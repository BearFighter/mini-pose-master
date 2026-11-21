// SPDX-License-Identifier: GPL-3.0-or-later
// contracts section 13: composePose order, edit ops (FK chain / single bone / reach), mirror of edits, hands.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Quaternion, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import type { EditOp, PoseInputs } from '../../src/shared/composePose'
import { composePose, descendants, mirrorEdit, toggleMirror } from '../../src/shared/composePose'
import { canonicalIndex, posedJoints } from '../../src/shared/fk'
import type { HandPose } from '../../src/shared/handPose'
import { applyHandPose } from '../../src/shared/handPose'
import { q4, quatAngleDeg, wxyz } from '../../src/shared/math'
import { mirrorPose } from '../../src/shared/mirror'
import { autoRig } from './helpers/skeletonRig'

const AUTO = autoRig()
const PRESETS = JSON.parse(readFileSync(join(__dirname, '..', '..', 'resources', 'hand_presets.json'), 'utf8'))
const FIST = PRESETS.presets.find((p: HandPose) => p.name === 'fist') as HandPose
const ci = canonicalIndex(AUTO)
const idx = (n: string): string => String(ci.get(n))
const rot = (axis: [number, number, number], deg: number) =>
  wxyz(new Quaternion().setFromAxisAngle(new Vector3(...axis).normalize(), (deg * Math.PI) / 180))
const base: PoseInputs = { mirrored: false, planted: false, edits: [] }

describe('composePose', () => {
  it('rest without a clip or edits', () => {
    const r = composePose(AUTO, base, null)
    expect(Object.keys(r.deltas)).toHaveLength(AUTO.bones.length)
    for (const q of Object.values(r.deltas)) expect(quatAngleDeg(q4(q), new Quaternion())).toBeLessThan(1e-9)
  })

  it('a chain rotation carries the limb rigidly about the bone head', () => {
    const q = rot([0, 1, 0.3], 50)
    const r = composePose(AUTO, { ...base, edits: [{ kind: 'rotate', bone: 'upper_arm.R', q, chain: true }] }, null)
    for (const j of [ci.get('upper_arm.R') as number, ...descendants(AUTO, ci.get('upper_arm.R') as number)])
      expect(quatAngleDeg(q4(r.deltas[String(j)]), q4(q))).toBeLessThan(1e-6)
    expect(quatAngleDeg(q4(r.deltas[idx('upper_arm.L')]), new Quaternion())).toBeLessThan(1e-9)
    const rest = posedJoints(AUTO, {})
    const posed = posedJoints(AUTO, r.deltas)
    const pivot = rest['shoulder_R']
    for (const j of ['elbow_R', 'wrist_R', 'index_tip_R']) {
      const exp = rest[j].clone().sub(pivot).applyQuaternion(q4(q)).add(pivot)
      expect(posed[j].distanceTo(exp)).toBeLessThan(1e-6)
    }
  })

  it('a single-bone rotation leaves the children oriented as before', () => {
    const q = rot([1, 0, 0], 30)
    const r = composePose(AUTO, { ...base, edits: [{ kind: 'rotate', bone: 'upper_arm.R', q, chain: false }] }, null)
    expect(quatAngleDeg(q4(r.deltas[idx('upper_arm.R')]), q4(q))).toBeLessThan(1e-6)
    expect(quatAngleDeg(q4(r.deltas[idx('forearm.R')]), new Quaternion())).toBeLessThan(1e-9)
  })

  it('edits compose in order', () => {
    const a = rot([0, 0, 1], 20)
    const b = rot([1, 0, 0], 35)
    const r = composePose(AUTO, { ...base, edits: [
      { kind: 'rotate', bone: 'spine', q: a, chain: true },
      { kind: 'rotate', bone: 'spine', q: b, chain: true }] }, null)
    expect(quatAngleDeg(q4(r.deltas[idx('head')]), q4(b).multiply(q4(a)))).toBeLessThan(1e-6)
  })

  it('reach puts the wrist on the target and reports the shortfall', () => {
    const rest = posedJoints(AUTO, {})
    const t = rest['shoulder_L'].clone().add(new Vector3(0.15, -0.35, -0.2))
    const r = composePose(AUTO, { ...base, edits: [{ kind: 'reach', side: 'L', target: [t.x, t.y, t.z] }] }, null)
    expect(posedJoints(AUTO, r.deltas)['wrist_L'].distanceTo(t)).toBeLessThan(1e-4)
    expect(r.reachShort.L).toBeLessThan(1e-6)
  })

  it('toggling mirror mirrors the whole pose, edits included', () => {
    const edits: EditOp[] = [
      { kind: 'rotate', bone: 'upper_arm.R', q: rot([0.2, 1, 0.3], 60), chain: true },
      { kind: 'rotate', bone: 'thigh.L', q: rot([1, 0.1, 0], -35), chain: true },
      { kind: 'rotate', bone: 'spine', q: rot([0, 0, 1], 25), chain: true }
    ]
    const inputs = { ...base, edits }
    const a = composePose(AUTO, inputs, null).deltas
    const m = mirrorPose(AUTO, a, [0, 0, 0]).deltas
    const b = composePose(AUTO, toggleMirror(inputs), null).deltas
    const pm = posedJoints(AUTO, m)
    const pb = posedJoints(AUTO, b)
    for (const j of Object.keys(pm)) expect(pb[j].distanceTo(pm[j])).toBeLessThan(1e-5)
    expect(toggleMirror(toggleMirror(inputs)).edits).toEqual(edits.map((e) => mirrorEdit(mirrorEdit(e))))
  })

  it('hand poses are applied after the edits, so fingers follow the hand', () => {
    const q = rot([0, 1, 0], 70)
    const edits: EditOp[] = [{ kind: 'rotate', bone: 'forearm.R', q, chain: true }]
    const r = composePose(AUTO, { ...base, edits, hands: { R: FIST } }, null)
    const noHand = composePose(AUTO, { ...base, edits }, null).deltas
    const exp = applyHandPose(AUTO, noHand, 'R', FIST)
    for (const k of Object.keys(exp)) expect(quatAngleDeg(q4(r.deltas[k]), q4(exp[k]))).toBeLessThan(1e-4)
    expect(quatAngleDeg(q4(r.deltas[idx('index.02.R')]), q4(q))).toBeGreaterThan(30)
  })

  it('skips edits for bones the rig does not have', () => {
    const r = composePose(AUTO, { ...base, edits: [{ kind: 'rotate', bone: 'tail.01', q: rot([1, 0, 0], 10), chain: true }] }, null)
    expect(r.skipped).toHaveLength(1)
  })
})
