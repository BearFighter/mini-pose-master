// SPDX-License-Identifier: GPL-3.0-or-later
// WP8a: retarget / hand pose / IK / plant feet / mirror / clip format, on rigs derived from the
// original procedural fixtures (tests/ts/fixtures).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Quaternion, Vector3 } from 'three'
import type { ClipFrame } from '../../src/shared/clip'
import { parseClipF32, writeClipF32 } from '../../src/shared/clip'
import type { Deltas } from '../../src/shared/fk'
import { canonicalIndex, posedBones, posedJoints, resolveDeltas } from '../../src/shared/fk'
import { applyHandPose } from '../../src/shared/handPose'
import type { HandPose } from '../../src/shared/handPose'
import { plantFeet, reachArm } from '../../src/shared/ik'
import { mul, q4, quatAngleDeg, rotBetween, v3, wxyz } from '../../src/shared/math'
import { mirrorPose } from '../../src/shared/mirror'
import { makePoseState } from '../../src/shared/poseState'
import { retargetFrame } from '../../src/shared/retarget'
import type { RigJson } from '../../src/shared/rig'
import { BONES } from '../../src/shared/skeleton'

const load = (n: string): RigJson =>
  JSON.parse(readFileSync(join(__dirname, 'fixtures', n), 'utf8')) as RigJson
const AUTO = load('rig_auto_apose.json')
const MIXAMO = load('rig_imported_mixamo.json')

function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Random pose: each canonical bone rotates up to maxDeg on top of its parent's delta. */
function randomPose(rig: RigJson, seed: number, maxDeg = 35): Deltas {
  const r = rng(seed)
  const ci = canonicalIndex(rig)
  const D = new Map<string, Quaternion>()
  const out: Deltas = {}
  for (const b of BONES) {
    const i = ci.get(b.name)
    if (i === undefined) continue
    const axis = new Vector3(r() * 2 - 1, r() * 2 - 1, r() * 2 - 1).normalize()
    const local = new Quaternion().setFromAxisAngle(axis, ((r() * maxDeg) * Math.PI) / 180)
    const p = b.parent ? D.get(b.parent) : undefined
    const q = p ? mul(p, local) : local
    D.set(b.name, q)
    out[String(i)] = wxyz(q)
  }
  return out
}

/** A clip frame read off a posed rig, using the section 9 rotation conventions. */
function frameFromPose(rig: RigJson, deltas: Deltas): ClipFrame {
  const J = posedJoints(rig, deltas)
  const joints: ClipFrame['joints'] = {}
  for (const [k, v] of Object.entries(J)) joints[k] = [v.x, v.y, v.z]
  const ci = canonicalIndex(rig)
  const res = resolveDeltas(rig, deltas)
  const D = (name: string): Quaternion => q4(res[String(ci.get(name)!)])
  const rot: ClipFrame['rot'] = { head: wxyz(D('head')), ankle_L: wxyz(D('foot.L')), ankle_R: wxyz(D('foot.R')) }
  for (const s of ['L', 'R'] as const) {
    const palm = v3(rig.hands[s]!.palm_normal)
    rot[`wrist_${s}`] = wxyz(mul(D(`hand.${s}`), rotBetween(new Vector3(0, 0, -1), palm)))
  }
  return { joints, rot, contacts: { L: true, R: true } }
}

const angle = (a: Vector3, b: Vector3): number => (a.angleTo(b) * 180) / Math.PI
const boneDir = (pb: ReturnType<typeof posedBones>, i: number): Vector3 => pb[i].tail.clone().sub(pb[i].head)

describe('retarget (contracts section 6)', () => {
  for (const seed of [1, 2, 3, 4]) {
    it(`recovers a random pose on the auto rig (seed ${seed})`, () => {
      const truth = randomPose(AUTO, seed)
      const got = retargetFrame(AUTO, frameFromPose(AUTO, truth))
      const ci = canonicalIndex(AUTO)
      const rt = resolveDeltas(AUTO, truth)
      const rg = resolveDeltas(AUTO, got)
      for (const n of ['hips', 'head', 'hand.L', 'hand.R', 'foot.L', 'foot.R']) {
        const i = String(ci.get(n)!)
        expect(quatAngleDeg(q4(rt[i]), q4(rg[i])), n).toBeLessThan(0.05)
      }
      const pt = posedBones(AUTO, truth)
      const pg = posedBones(AUTO, got)
      for (const b of BONES) {
        if (b.name.startsWith('grip.')) continue
        const i = ci.get(b.name)!
        expect(angle(boneDir(pt, i), boneDir(pg, i)), b.name).toBeLessThan(0.05)
      }
    })
  }

  it('copies directions onto an imported rig with different proportions', () => {
    const frame = frameFromPose(AUTO, randomPose(AUTO, 9))
    const got = retargetFrame(MIXAMO, frame)
    const ci = canonicalIndex(MIXAMO)
    const pg = posedBones(MIXAMO, got)
    for (const b of BONES) {
      const i = ci.get(b.name)
      if (i === undefined || b.name.startsWith('grip.')) continue
      const want = v3(frame.joints[b.tail]).sub(v3(frame.joints[b.head]))
      expect(angle(boneDir(pg, i), want), b.name).toBeLessThan(0.05)
    }
  })
})

const flat = (flex: [number, number, number], spread = 0): HandPose['fingers']['index'] => ({ flex, spread })
const pose = (f: Partial<HandPose['fingers']>): HandPose => ({
  schema: 'mpm.hand/1',
  name: 't',
  fingers: {
    thumb: flat([0, 0, 0]),
    index: flat([0, 0, 0]),
    middle: flat([0, 0, 0]),
    ring: flat([0, 0, 0]),
    pinky: flat([0, 0, 0]),
    ...f
  }
})

describe('hand pose (contracts section 10)', () => {
  for (const rig of [AUTO, MIXAMO]) {
    for (const s of ['L', 'R'] as const) {
      it(`${rig.kind} ${s}: flex curls toward the palm, +spread goes toward the thumb`, () => {
        const ci = canonicalIndex(rig)
        const i = ci.get(`index.01.${s}`)!
        const restD = v3(rig.bones[i].tail).sub(v3(rig.bones[i].head)).normalize()
        const n = v3(rig.hands[s]!.palm_normal)
        const z = n.clone().sub(restD.clone().multiplyScalar(n.dot(restD))).normalize()
        const curled = posedBones(rig, applyHandPose(rig, {}, s, pose({ index: flat([90, 0, 0]) })))
        expect(boneDir(curled, i).normalize().dot(z)).toBeGreaterThan(0.999)
        const spread = posedBones(rig, applyHandPose(rig, {}, s, pose({ index: flat([0, 0, 0], 20) })))
        const lat = v3(rig.hands[s]!.lateral)
        expect(boneDir(spread, i).normalize().dot(lat)).toBeGreaterThan(restD.dot(lat) + 0.1)
        const zero = applyHandPose(rig, {}, s, pose({}))
        const rz = resolveDeltas(rig, zero)
        expect(quatAngleDeg(q4(rz[String(i)]), new Quaternion())).toBeLessThan(1e-6)
      })
    }
  }
})

describe('IK and plant feet (contracts section 12)', () => {
  it('reaches a target with the wrist and keeps bone lengths', () => {
    const ci = canonicalIndex(AUTO)
    const pb0 = posedBones(AUTO, {})
    const sh = pb0[ci.get('upper_arm.L')!].head
    const target = sh.clone().add(new Vector3(0.15, -0.3, -0.2))
    const r = reachArm(AUTO, {}, 'L', [target.x, target.y, target.z])
    const pb = posedBones(AUTO, r.deltas)
    expect(pb[ci.get('hand.L')!].head.distanceTo(target)).toBeLessThan(1e-6)
    expect(r.reachShort).toBe(0)
    for (const n of ['upper_arm.L', 'forearm.L']) {
      const i = ci.get(n)!
      expect(Math.abs(pb[i].head.distanceTo(pb[i].tail) - pb0[i].head.distanceTo(pb0[i].tail))).toBeLessThan(1e-9)
    }
    const far = sh.clone().add(new Vector3(2, 0, 0))
    const r2 = reachArm(AUTO, {}, 'L', [far.x, far.y, far.z])
    expect(r2.reachShort).toBeGreaterThan(0.5)
  })
  it('plants both feet at the same height', () => {
    const ci = canonicalIndex(AUTO)
    const bent: Deltas = {}
    const th = ci.get('thigh.R')!
    bent[String(th)] = wxyz(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.6))
    const sh = ci.get('shin.R')!
    bent[String(sh)] = wxyz(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -0.2))
    const low = (d: Deltas, s: string): number => {
      const pb = posedBones(AUTO, d)
      return Math.min(...['foot', 'toe'].flatMap((n) => [pb[ci.get(`${n}.${s}`)!].head.z, pb[ci.get(`${n}.${s}`)!].tail.z]))
    }
    expect(Math.abs(low(bent, 'L') - low(bent, 'R'))).toBeGreaterThan(0.01)
    const planted = plantFeet(AUTO, bent, { L: true, R: true })
    expect(Math.abs(low(planted, 'L') - low(planted, 'R'))).toBeLessThan(1e-5)
    const one = plantFeet(AUTO, bent, { L: true, R: false })
    expect(Math.abs(low(one, 'L') - low(one, 'R'))).toBeGreaterThan(0.01)
  })
})

describe('mirror (contracts section 5)', () => {
  it('mirroring twice is the identity and mirrors joint positions', () => {
    const d = randomPose(AUTO, 21)
    const m1 = mirrorPose(AUTO, d, [0.02, 0.01, -0.03])
    const m2 = mirrorPose(AUTO, m1.deltas, m1.rootOffset)
    const r = resolveDeltas(AUTO, d)
    // acos near 1 amplifies float error; 1e-4 deg is still exact for posing purposes
    for (const k of Object.keys(r)) expect(quatAngleDeg(q4(r[k]), q4(m2.deltas[k]))).toBeLessThan(1e-4)
    expect(m2.rootOffset).toEqual([0.02, 0.01, -0.03])
    const J = posedJoints(AUTO, d)
    const M = posedJoints(AUTO, m1.deltas)
    const swap = (n: string): string => n.replace(/_L$/, '_X').replace(/_R$/, '_L').replace(/_X$/, '_R')
    for (const k of Object.keys(J)) {
      const a = J[k]
      const b = M[swap(k)]
      // the auto fixture rig is symmetric to ~1e-6 m
      expect(Math.hypot(a.x + b.x, a.y - b.y, a.z - b.z), k).toBeLessThan(1e-4)
    }
  })
})

describe('clip format and pose state', () => {
  it('round-trips frames through .f32', () => {
    const names = ['pelvis', 'head', 'wrist_L']
    const frames: ClipFrame[] = [
      { joints: { pelvis: [0, 0, 1], head: [0, 0.1, 1.6], wrist_L: [0.5, 0, 1] }, rot: { head: [1, 0, 0, 0] }, contacts: { L: true, R: false } },
      { joints: { pelvis: [0, 0, 0.9], head: [0, 0, 1.5], wrist_L: [0.4, -0.1, 1.1] }, rot: {}, contacts: { L: false, R: true } }
    ]
    const clip = parseClipF32(writeClipF32(frames, names), names)
    expect(clip.frames).toBe(2)
    expect(clip.frame(1).contacts).toEqual({ L: false, R: true })
    expect(clip.frame(0).joints.head[2]).toBeCloseTo(1.6, 6)
    expect(() => clip.frame(2)).toThrow()
  })
  it('pose state lists every bone', () => {
    const st = makePoseState(MIXAMO, randomPose(MIXAMO, 5), [0, 0, 0])
    expect(Object.keys(st.deltas).length).toBe(MIXAMO.bones.length)
    expect(st.rig_hash).toBe(MIXAMO.hash)
  })
})
