// SPDX-License-Identifier: GPL-3.0-or-later
// derive.ts against contracts section 4: every rule of the table, written out again here in plain
// arithmetic, on the standard markers (A- and T-pose); and against the engine (skeleton.py), on the
// joints of every auto rig.json the engine wrote into tests/golden (skipped when there is none).
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Vec3 } from '../../src/shared/coords'
import { EDITABLE, deriveJoints, handFrame } from '../../src/shared/derive'
import type { RigJson } from '../../src/shared/rig'
import { JOINTS } from '../../src/shared/skeleton'
import { ARM_DROP_DEG, MARKERS_APOSE, standardMarkers } from './helpers/skeletonRig'

type V = [number, number, number]
const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const mul = (a: V, k: number): V => [a[0] * k, a[1] * k, a[2] * k]
const dot = (a: V, b: V): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const len = (a: V): number => Math.hypot(a[0], a[1], a[2])
const unit = (a: V): V => mul(a, 1 / len(a))
const lerp = (a: V, b: V, t: number): V => add(a, mul(sub(b, a), t))

/** contracts section 4, rule by rule. */
function section4(m: Record<string, V>): { joints: Record<string, V>; hands: Record<'L' | 'R', Record<string, V | number>> } {
  const J: Record<string, V> = { ...m }
  const hands = {} as Record<'L' | 'R', Record<string, V | number>>
  J.spine0 = lerp(m.pelvis, m.chest, 0.3)
  for (const [s, sign] of [['L', 1], ['R', -1]] as const) {
    const sh = m[`shoulder_${s}`]
    J[`clav_${s}`] = [m.pelvis[0] + sign * 0.18 * Math.abs(sh[0] - m.pelvis[0]), m.neck[1], m.neck[2] - 0.25 * (m.neck[2] - sh[2])]
    const ank = m[`ankle_${s}`]
    const toe = m[`toe_${s}`]
    const ball = lerp(ank, toe, 0.68)
    J[`ball_${s}`] = [ball[0], ball[1], 0.35 * ank[2] + 0.65 * toe[2]]
    for (const f of ['index', 'middle', 'ring', 'pinky']) {
      J[`${f}_1_${s}`] = lerp(m[`${f}_0_${s}`], m[`${f}_tip_${s}`], 0.45)
      J[`${f}_2_${s}`] = lerp(m[`${f}_0_${s}`], m[`${f}_tip_${s}`], 0.75)
    }
    J[`thumb_1_${s}`] = lerp(m[`thumb_0_${s}`], m[`thumb_tip_${s}`], 0.4)
    J[`thumb_2_${s}`] = lerp(m[`thumb_0_${s}`], m[`thumb_tip_${s}`], 0.73)
    const wrist = m[`wrist_${s}`]
    const [i0, m0, r0, p0] = ['index', 'middle', 'ring', 'pinky'].map((f) => m[`${f}_0_${s}`])
    const handAxis = unit(sub(m0, wrist))
    const lateral = unit(sub(i0, p0))
    const palmNormal = s === 'L' ? unit(cross(handAxis, lateral)) : unit(cross(lateral, handAxis))
    const handWidth = len(sub(i0, p0))
    const gripAxis = unit(sub(lateral, mul(handAxis, dot(lateral, handAxis))))
    const centre = mul([i0, m0, r0, p0, wrist].reduce(add), 1 / 5)
    J[`grip_${s}`] = add(centre, mul(palmNormal, 0.35 * handWidth))
    J[`grip_tip_${s}`] = add(J[`grip_${s}`], mul(gripAxis, 0.1))
    hands[s] = { hand_axis: handAxis, lateral, palm_normal: palmNormal, hand_width: handWidth, grip_axis: gripAxis }
  }
  return { joints: J, hands }
}

const dist = (a: { x: number; y: number; z: number }, b: Vec3): number => Math.hypot(a.x - b[0], a.y - b[1], a.z - b[2])

describe('derived joints (contracts section 4)', () => {
  for (const tpose of [false, true]) {
    it(`follows every rule of the table on the standard markers (${tpose ? 'T' : 'A'}-pose)`, () => {
      const markers = standardMarkers({ tpose })
      expect(Object.keys(markers)).toEqual(EDITABLE)
      const J = deriveJoints(markers)
      const want = section4(markers)
      expect(Object.keys(J).sort()).toEqual(JOINTS.map((j) => j.name).sort())
      expect(Object.keys(J).length).toBe(68)
      let worst = 0
      for (const [k, p] of Object.entries(want.joints)) worst = Math.max(worst, dist(J[k], p))
      expect(worst).toBeLessThan(1e-12)
      for (const s of ['L', 'R'] as const) {
        const fr = handFrame(J, s)
        for (const k of ['hand_axis', 'lateral', 'palm_normal', 'grip_axis'] as const) expect(dist(fr[k], want.hands[s][k] as V), `${k} ${s}`).toBeLessThan(1e-12)
        expect(fr.hand_width).toBeCloseTo(want.hands[s].hand_width as number, 12)
        // a frame: unit vectors, the palm normal square to the hand axis and to the knuckle row, the grip axis
        // square to the hand axis and to the palm normal
        for (const k of ['hand_axis', 'lateral', 'palm_normal', 'grip_axis'] as const) expect(fr[k].length()).toBeCloseTo(1, 12)
        expect(Math.abs(fr.palm_normal.dot(fr.hand_axis))).toBeLessThan(1e-12)
        expect(Math.abs(fr.palm_normal.dot(fr.lateral))).toBeLessThan(1e-12)
        expect(Math.abs(fr.grip_axis.dot(fr.hand_axis))).toBeLessThan(1e-12)
        expect(Math.abs(fr.grip_axis.dot(fr.palm_normal))).toBeLessThan(1e-12)
      }
    })
  }

  it('the palm normal points out of the palm: toward the thigh in the A-pose, down in the T-pose', () => {
    const A = deriveJoints(MARKERS_APOSE)
    // contracts section 4: for a relaxed A-pose hand hanging at the side, the L palm normal has a negative x
    expect(handFrame(A, 'L').palm_normal.x).toBeLessThan(-0.5)
    expect(handFrame(A, 'R').palm_normal.x).toBeGreaterThan(0.5)
    // the socket sits on the palm side of the hand, toward the body
    expect(A.grip_L.x).toBeLessThan((A.wrist_L.x + A.middle_0_L.x) / 2)
    // the arm hangs ARM_DROP_DEG below horizontal
    const drop = (Math.atan2(A.shoulder_L.z - A.wrist_L.z, A.wrist_L.x - A.shoulder_L.x) * 180) / Math.PI
    expect(drop).toBeCloseTo(ARM_DROP_DEG, 1)
    const T = deriveJoints(standardMarkers({ tpose: true }))
    for (const s of ['L', 'R'] as const) expect(handFrame(T, s).palm_normal.z).toBeLessThan(-0.99)
    expect(Math.abs(T.wrist_L.z - T.shoulder_L.z)).toBeLessThan(1e-3)
    // both are symmetric in x
    for (const J of [A, T]) {
      for (const [k, p] of Object.entries(J)) {
        if (!k.endsWith('_L')) continue
        const q = J[k.replace(/_L$/, '_R')]
        expect(Math.hypot(p.x + q.x, p.y - q.y, p.z - q.z), k).toBeLessThan(1e-12)
      }
    }
  })

  it('names the missing marker', () => {
    const markers = Object.fromEntries(EDITABLE.filter((k) => k !== 'toe_R').map((k) => [k, MARKERS_APOSE[k]]))
    expect(() => deriveJoints(markers)).toThrow(/toe_R/)
  })
})

// The engine side of the same rules: rig.json joints of an auto rig come from skeleton.py derive_joints.
const GOLDEN = join(__dirname, '..', 'golden')
const engineRigs: [string, RigJson][] = (existsSync(GOLDEN) ? readdirSync(GOLDEN) : [])
  .filter((c) => existsSync(join(GOLDEN, c, 'rig.json')))
  .map((c): [string, RigJson] => [c, JSON.parse(readFileSync(join(GOLDEN, c, 'rig.json'), 'utf8')) as RigJson])
  .filter(([, rig]) => rig.kind === 'auto')
if (!engineRigs.length) console.warn('derive: no engine-written auto rig.json in tests/golden - the engine comparison is skipped')

describe.skipIf(!engineRigs.length)('derived joints match the engine (tests/golden auto rigs)', () => {
  for (const [name, rig] of engineRigs) {
    it(`${name}: joints to 1e-6 m, palm normals to 1e-6`, () => {
      const J = deriveJoints(Object.fromEntries(EDITABLE.map((k) => [k, rig.joints[k]])))
      expect(Object.keys(J).length).toBe(68)
      let worst = 0
      for (const [k, v] of Object.entries(rig.joints)) worst = Math.max(worst, dist(J[k], v))
      expect(worst).toBeLessThan(1e-6)
      for (const s of ['L', 'R'] as const) {
        const fr = handFrame(J, s)
        const pn = rig.hands[s]!.palm_normal
        expect(fr.palm_normal.x * pn[0] + fr.palm_normal.y * pn[1] + fr.palm_normal.z * pn[2]).toBeGreaterThan(0.999999)
      }
    })
  }
})
