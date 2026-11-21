// SPDX-License-Identifier: GPL-3.0-or-later
// contracts sections 12-13: weapon attach frame, grip sockets following the hands, two-hand support IK.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Matrix4, Quaternion, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import type { EditOp, PoseInputs } from '../../src/shared/composePose'
import { composePose } from '../../src/shared/composePose'
import { canonicalIndex, posedBones, posedJoints } from '../../src/shared/fk'
import type { HandPose } from '../../src/shared/handPose'
import { inv, mul, q4, quatAngleDeg, v3, wxyz } from '../../src/shared/math'
import type { WeaponEntry } from '../../src/shared/weaponPose'
import { attachFrame, followHands, holdingStance, mainGripPoint, placeWeapon, weaponMatrix } from '../../src/shared/weaponPose'
import { autoRig } from './helpers/skeletonRig'

const AUTO = autoRig()
const PRESETS = JSON.parse(readFileSync(join(__dirname, '..', '..', 'resources', 'hand_presets.json'), 'utf8'))
const FIST = PRESETS.presets.find((p: HandPose) => p.name === 'fist') as HandPose
const ci = canonicalIndex(AUTO)
const I = (n: string): number => ci.get(n) as number
const rot = (axis: [number, number, number], deg: number) =>
  wxyz(new Quaternion().setFromAxisAngle(new Vector3(...axis).normalize(), (deg * Math.PI) / 180))

// Fixture sword grips (weapon-local, from fixtures/out/sword/sword.truth.json): main hand at z = 0.03,
// support hand at z = -0.035, grip axis +Z, palm normal -X.
const sword = (support: boolean): WeaponEntry => ({
  id: 'sword',
  file: 'weapons/sword.glb',
  attach_bone: 'grip.R',
  offset: { t: [0, 0, -0.03], q: [1, 0, 0, 0], s: 1 },
  support: { enabled: support, side: 'L', mode: 'reach', point: [0, 0, -0.035], normal: [-1, 0, 0], axis: [0, 0, 1] }
})

describe('weapon placement', () => {
  it('attachFrame is T(posed head) * D_b * R(rest_q) and the offset composes after it', () => {
    const d = { [String(I('upper_arm.R'))]: rot([0.3, 1, 0.2], 40) }
    const A = attachFrame(AUTO, d, 'grip.R') as Matrix4
    const pb = posedBones(AUTO, d)[I('grip.R')]
    const exp = new Matrix4().compose(pb.head, mul(pb.D, q4(AUTO.bones[I('grip.R')].rest_q)), new Vector3(1, 1, 1))
    expect(Math.max(...A.elements.map((e, k) => Math.abs(e - exp.elements[k])))).toBeLessThan(1e-12)
    const W = weaponMatrix(AUTO, d, { attach_bone: 'grip.R', offset: { t: [0.01, 0, 0], q: rot([0, 0, 1], 90), s: 2 } }) as Matrix4
    const p = new Vector3(0.1, 0, 0).applyMatrix4(W)
    const local = new Vector3(0.01, 0.2, 0) // q: x -> y, scaled by 2, then t
    expect(p.distanceTo(local.applyMatrix4(A))).toBeLessThan(1e-9)
    expect(attachFrame(AUTO, d, 'tail.01')).toBeNull()
  })

  it('grip sockets follow their hand even after a bone-only hand rotation', () => {
    const inputs: PoseInputs = { mirrored: false, planted: false, edits: [{ kind: 'rotate', bone: 'hand.R', q: rot([1, 0, 0], 45), chain: false }] }
    const r = composePose(AUTO, inputs, null)
    expect(quatAngleDeg(q4(r.deltas[String(I('grip.R'))]), q4(r.deltas[String(I('hand.R'))]))).toBeLessThan(1e-6)
    const f = followHands(AUTO, { [String(I('hand.L'))]: rot([0, 1, 0], 30) })
    expect(f[String(I('grip.L'))]).toEqual(f[String(I('hand.L'))])
  })
})

describe('two-hand support IK', () => {
  // Bring the right hand in front of the body so the left hand can reach the sword.
  const front: PoseInputs = { mirrored: false, planted: false, edits: [{ kind: 'reach', side: 'R', target: [-0.03, -0.3, 1.2] }] }

  it('puts the support socket on the weapon, palm and grip axis aligned', () => {
    const w = sword(true)
    const r = composePose(AUTO, { ...front, weapons: [w] }, null)
    expect(r.supportShort.sword).toBeLessThan(1e-6)
    const W = weaponMatrix(AUTO, r.deltas, w) as Matrix4
    const target = v3(w.support!.point).applyMatrix4(W)
    const pb = posedBones(AUTO, r.deltas)
    expect(pb[I('grip.L')].head.distanceTo(target)).toBeLessThan(1e-4)
    const rotW = new Quaternion()
    W.decompose(new Vector3(), rotW, new Vector3())
    const hf = AUTO.hands.L!
    const palm = v3(hf.palm_normal).applyQuaternion(pb[I('hand.L')].D)
    const ga = v3(hf.grip_axis ?? hf.lateral).applyQuaternion(pb[I('hand.L')].D)
    expect(palm.angleTo(v3(w.support!.normal).applyQuaternion(rotW)) * 180 / Math.PI).toBeLessThan(0.5)
    expect(ga.angleTo(v3(w.support!.axis).applyQuaternion(rotW)) * 180 / Math.PI).toBeLessThan(0.5)
  })

  it('fingers turn with the support hand, then the hand pose is applied on top', () => {
    const w = sword(true)
    const noIk = composePose(AUTO, front, null).deltas
    const ik = composePose(AUTO, { ...front, weapons: [w] }, null).deltas
    const rel = (d: typeof ik, b: string) => mul(inv(q4(d[String(I('hand.L'))])), q4(d[String(I(b))]))
    for (const b of ['index.01.L', 'thumb.02.L', 'grip.L'])
      expect(quatAngleDeg(rel(ik, b), rel(noIk, b))).toBeLessThan(1e-4)
    const fist = composePose(AUTO, { ...front, weapons: [w], hands: { L: FIST } }, null).deltas
    expect(quatAngleDeg(rel(fist, 'index.02.L'), rel(ik, 'index.02.L'))).toBeGreaterThan(30)
    expect(quatAngleDeg(q4(fist[String(I('hand.L'))]), q4(ik[String(I('hand.L'))]))).toBeLessThan(1e-6)
  })

  it('out of reach: no stretching, the shortfall is reported', () => {
    const w = sword(true)
    const r = composePose(AUTO, { mirrored: false, planted: false, edits: [], weapons: [w] }, null)
    expect(r.supportShort.sword).toBeGreaterThan(0.05)
    const rest = posedJoints(AUTO, {})
    const p = posedJoints(AUTO, r.deltas)
    for (const [a, b] of [['shoulder_L', 'elbow_L'], ['elbow_L', 'wrist_L']] as const)
      expect(Math.abs(p[a].distanceTo(p[b]) - rest[a].distanceTo(rest[b]))).toBeLessThan(1e-9)
  })

  it('a disabled support changes nothing', () => {
    const a = composePose(AUTO, front, null).deltas
    const b = composePose(AUTO, { ...front, weapons: [sword(false)] }, null).deltas
    expect(b).toEqual(a)
  })
})

describe('two-handed weapons that follow both hands ("both" mode)', () => {
  // A two-handed sword: right hand at the guard, left hand 12 cm further down the grip (weapon-local -Z).
  const greatsword = (mode?: 'both' | 'reach'): WeaponEntry => ({
    id: 'gs',
    file: 'weapons/gs.glb',
    attach_bone: 'grip.R',
    offset: { t: [0, 0, 0], q: [1, 0, 0, 0], s: 1 },
    support: { enabled: true, side: 'L', mode, point: [0, 0, -0.12], normal: [-1, 0, 0], axis: [0, 0, 1] }
  })
  const stance = (): PoseInputs => ({
    mirrored: false,
    planted: false,
    edits: holdingStance(AUTO, 'R').map((h) => ({ kind: 'reach' as const, side: h.side, target: h.target }))
  })

  it('points the weapon from the main hand at the support hand, then closes the support hand on its grip', () => {
    const w = greatsword()
    const before = composePose(AUTO, stance(), null).deltas
    const r = composePose(AUTO, { ...stance(), weapons: [w] }, null)
    const W = new Matrix4().fromArray(r.weaponMatrices.gs)
    const pb0 = posedBones(AUTO, before)
    const pm = mainGripPoint(w).applyMatrix4(W)
    // main grip on the main hand's socket
    expect(pm.distanceTo(pb0[I('grip.R')].head)).toBeLessThan(1e-9)
    // the weapon's grip line points at where the pose had the support hand
    const dir = v3(w.support!.point).applyMatrix4(W).sub(pm).normalize()
    const want = pb0[I('grip.L')].head.clone().sub(pm).normalize()
    expect(dir.angleTo(want)).toBeLessThan(1e-6)
    // and the support hand ends exactly on its grip when it can reach
    const pb = posedBones(AUTO, r.deltas)
    expect(r.supportShort.gs).toBeLessThan(1e-6)
    expect(pb[I('grip.L')].head.distanceTo(v3(w.support!.point).applyMatrix4(W))).toBeLessThan(1e-4)
    // the main arm is not touched by the support IK
    expect(quatAngleDeg(q4(r.deltas[String(I('forearm.R'))]), q4(before[String(I('forearm.R'))]))).toBeLessThan(1e-9)
  })

  it('moving the support arm in the pose turns the weapon', () => {
    const w = greatsword()
    const a = composePose(AUTO, { ...stance(), weapons: [w] }, null).weaponMatrices.gs
    const moved = stance()
    const t = (moved.edits[1] as Extract<EditOp, { kind: 'reach' }>).target
    moved.edits[1] = { kind: 'reach', side: 'L', target: [t[0] + 0.1, t[1], t[2] - 0.1] }
    const b = composePose(AUTO, { ...moved, weapons: [w] }, null).weaponMatrices.gs
    const da = new Vector3(0, 0, -1).transformDirection(new Matrix4().fromArray(a))
    const db = new Vector3(0, 0, -1).transformDirection(new Matrix4().fromArray(b))
    expect(da.angleTo(db)).toBeGreaterThan(0.1)
  })

  it('"reach" mode keeps the weapon fixed in the main hand; one-handed weapons are unchanged', () => {
    const w = greatsword('reach')
    const r = composePose(AUTO, { ...stance(), weapons: [w] }, null)
    const fixed = weaponMatrix(AUTO, r.deltas, w) as Matrix4
    expect(Math.max(...fixed.elements.map((e, k) => Math.abs(e - r.weaponMatrices.gs[k])))).toBeLessThan(1e-9)
    const one = { ...greatsword(), support: { ...greatsword().support!, enabled: false } }
    const d = composePose(AUTO, stance(), null).deltas
    expect(placeWeapon(AUTO, d, one)!.elements).toEqual((weaponMatrix(AUTO, d, one) as Matrix4).elements)
  })

  it('the holding stance brings both hands in front of the body within reach', () => {
    const r = composePose(AUTO, stance(), null)
    const j = posedJoints(AUTO, r.deltas)
    expect(r.reachShort.R ?? 0).toBeLessThan(1e-6)
    expect(r.reachShort.L ?? 0).toBeLessThan(1e-6)
    expect(j.wrist_R.y).toBeLessThan(j.shoulder_R.y - 0.15)   // in front (the figure faces -Y)
    expect(j.wrist_L.y).toBeLessThan(j.shoulder_L.y - 0.15)
  })
})

