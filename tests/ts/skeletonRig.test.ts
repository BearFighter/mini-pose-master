// SPDX-License-Identifier: GPL-3.0-or-later
// The test skeleton itself (tests/ts/helpers/skeletonRig.ts): the rigs it builds have the rig.json shape
// the engine writes (contracts sections 3, 4, 8), so the other tests stand on what they think they do.
import { Quaternion, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import type { Vec3 } from '../../src/shared/coords'
import { EDITABLE } from '../../src/shared/derive'
import { fingerFrame } from '../../src/shared/handPose'
import { q4, quatAngleDeg, v3 } from '../../src/shared/math'
import type { RigBone, RigJson } from '../../src/shared/rig'
import { BONES, JOINTS } from '../../src/shared/skeleton'
import { alignedRest, ARM_DROP_DEG, autoRig, autoRigFromJoints, FINGER_RADIUS_M, IMPORTED_PREFIX, importedRig, MARKERS_APOSE, standardJoints, standardMarkers } from './helpers/skeletonRig'

const AUTO = autoRig()
const AUTO_T = autoRig({ tpose: true })
const IMPORTED = importedRig()

const FINGER = /^(thumb|index|middle|ring|pinky)\./
/** radians; a 2 cm finger bone whose ends are rounded to 1e-7 m is known to about 5e-6 */
const ANGLE = 1e-5
const dir = (b: RigBone): Vector3 => v3(b.tail).sub(v3(b.head)).normalize()
const axis = (b: RigBone, k: 0 | 1 | 2): Vector3 => new Vector3(k === 0 ? 1 : 0, k === 1 ? 1 : 0, k === 2 ? 1 : 0).applyQuaternion(q4(b.rest_q))
const len = (rig: RigJson, a: string, b: string): number => v3(rig.joints[a]).distanceTo(v3(rig.joints[b]))
const sideOf = (name: string): 'L' | 'R' => (name.endsWith('.L') ? 'L' : 'R')

describe('standard markers', () => {
  it('are the 39 editable markers of a 1.80 m figure: Z up, facing -Y, left at +X, feet on the floor, symmetric', () => {
    expect(Object.keys(MARKERS_APOSE)).toEqual(EDITABLE)
    expect(EDITABLE.length).toBe(39)
    const m = MARKERS_APOSE
    expect(m.head_top[2]).toBe(1.8)
    for (const k of ['pelvis', 'chest', 'neck', 'head', 'head_top']) expect(m[k][0]).toBe(0)
    for (const [k, p] of Object.entries(m)) {
      expect(p[2], k).toBeGreaterThan(0)
      if (k.endsWith('_L')) {
        expect(p[0], k).toBeGreaterThan(0)
        expect(m[k.replace(/_L$/, '_R')]).toEqual([-p[0], p[1], p[2]])
      }
    }
    // the toes point forward (-Y) and rest on the floor
    expect(m.toe_L[1]).toBeLessThan(m.ankle_L[1] - 0.15)
    expect(m.toe_L[2]).toBeLessThan(0.02)
    // the usual shares of the height (Drillis and Contini): upper arm 0.186, forearm 0.146, hand 0.108
    const d = (a: string, b: string): number => v3(m[a]).distanceTo(v3(m[b]))
    expect(d('shoulder_L', 'elbow_L') / 1.8).toBeCloseTo(0.186, 3)
    expect(d('elbow_L', 'wrist_L') / 1.8).toBeCloseTo(0.146, 3)
    expect((d('wrist_L', 'middle_0_L') + d('middle_0_L', 'middle_tip_L')) / 1.8).toBeCloseTo(0.108, 3)
    expect(m.hip_L[2] / 1.8).toBeCloseTo(0.53, 3)
    // a fresh copy every time
    expect(standardMarkers()).toEqual({ ...MARKERS_APOSE })
    expect(standardMarkers()).not.toBe(standardMarkers())
  })

  it('tpose turns the arms up about the shoulders and nothing else', () => {
    const a = standardJoints()
    const t = standardJoints({ tpose: true })
    const arm = /^(elbow|wrist|thumb|index|middle|ring|pinky|grip)_/
    for (const j of JOINTS) {
      if (!arm.test(j.name)) expect(t[j.name], j.name).toEqual(a[j.name])
    }
    for (const s of ['L', 'R']) {
      // horizontal: the wrist at shoulder height (the table is rounded to 0.1 mm)
      expect(Math.abs(t[`wrist_${s}`][2] - t[`shoulder_${s}`][2])).toBeLessThan(1e-4)
      // rigid: every distance from the shoulder is kept
      for (const j of JOINTS) {
        if (!arm.test(j.name) || !j.name.endsWith(`_${s}`)) continue
        expect(v3(t[j.name]).distanceTo(v3(t[`shoulder_${s}`]))).toBeCloseTo(v3(a[j.name]).distanceTo(v3(a[`shoulder_${s}`])), 6)
      }
    }
    const drop = (J: Record<string, Vec3>): number => (Math.atan2(J.shoulder_L[2] - J.wrist_L[2], J.wrist_L[0] - J.shoulder_L[0]) * 180) / Math.PI
    expect(drop(a) - drop(t)).toBeCloseTo(ARM_DROP_DEG, 4)
  })
})

describe('auto rig', () => {
  it('has the rig.json shape of contracts section 8, with no mesh', () => {
    for (const rig of [AUTO, AUTO_T]) {
      expect(rig.schema).toBe('mpm.rig/1')
      expect(rig.kind).toBe('auto')
      expect(rig.height_m).toBe(1.8)
      expect(rig.floor_z).toBe(0)
      expect(rig.meshes).toEqual([])
      expect(rig.hash).toMatch(/^[0-9a-f]{40}$/)
      expect(Object.keys(rig.joints)).toEqual(JOINTS.map((j) => j.name))
      expect(rig.bones.length).toBe(53)
      expect(rig.bones.map((b) => b.name).sort()).toEqual(BONES.map((b) => b.name).sort())
      rig.bones.forEach((b, i) => {
        const def = BONES.find((x) => x.name === b.name)!
        expect(b.index).toBe(i)
        expect(b.gltf_node).toBe(i)
        expect(b.canonical).toBe(b.name)
        expect(b.parent).toBeLessThan(i) // parents first
        expect(b.parent < 0 ? null : rig.bones[b.parent].name).toBe(def.parent)
        expect(b.deform).toBe(def.deform)
        expect(b.head).toEqual(rig.joints[def.head])
        expect(b.tail).toEqual(rig.joints[def.tail])
        if (FINGER.test(b.name)) {
          const [finger, k] = b.name.split('.')
          expect(b.radius_m).toBe(FINGER_RADIUS_M[finger as keyof typeof FINGER_RADIUS_M][Number(k) - 1])
          expect(b.radius_m).toBeGreaterThanOrEqual(0.008)
          expect(b.radius_m).toBeLessThanOrEqual(0.011)
        } else expect(b.radius_m).toBeNull()
      })
      for (const s of ['L', 'R'] as const) {
        const h = rig.hands[s]!
        expect(Object.keys(h).sort()).toEqual(['grip_axis', 'hand_axis', 'hand_width', 'lateral', 'palm_normal'])
        expect(h.hand_width).toBeCloseTo(len(rig, `index_0_${s}`, `pinky_0_${s}`), 6)
      }
    }
    expect(AUTO_T.hash).not.toBe(AUTO.hash)
  })

  it('lists the bones in the order Blender does: every bone followed by its whole subtree', () => {
    const names = AUTO.bones.map((b) => b.name)
    expect(names.slice(0, 9)).toEqual(['hips', 'spine', 'chest', 'neck', 'head', 'shoulder.L', 'upper_arm.L', 'forearm.L', 'hand.L'])
    // the whole left arm, fingers and socket included, comes before the right shoulder; the legs come last
    expect(names[names.indexOf('grip.L') + 1]).toBe('shoulder.R')
    expect(names.indexOf('thumb.01.L')).toBe(names.indexOf('hand.L') + 1)
    expect(names.slice(-8)).toEqual(['thigh.L', 'shin.L', 'foot.L', 'toe.L', 'thigh.R', 'shin.R', 'foot.R', 'toe.R'])
    // so it is not the skeleton.json order, and indices must never be taken from BONES
    expect(names).not.toEqual(BONES.map((b) => b.name))
    // depth first: a bone's descendants are exactly the bones that follow it up to the next non-descendant
    AUTO.bones.forEach((b, i) => {
      const isUnder = (j: number): boolean => {
        for (let p = AUTO.bones[j].parent; p >= 0; p = AUTO.bones[p].parent) if (p === i) return true
        return false
      }
      const under = AUTO.bones.filter((_x, j) => isUnder(j)).map((x) => x.index)
      expect(under, b.name).toEqual(under.map((_x, k) => i + 1 + k))
    })
  })

  it('rest rotations follow the roll rule of build_armature (contracts section 3)', () => {
    // the rule on its own: a vertical bone rolled toward -Y is a quarter turn about X
    const up = alignedRest(new Vector3(0, 0, 0), new Vector3(0, 0, 1), new Vector3(0, -1, 0))
    expect(quatAngleDeg(up, new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2))).toBeLessThan(1e-6)
    // a bone pointing forward (-Y) rolled toward +Z: X = Y x Z = -X world, a half turn about Z
    const fwd = alignedRest(new Vector3(0, 0, 0), new Vector3(0, -1, 0), new Vector3(0, 0, 1))
    expect(quatAngleDeg(fwd, new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI))).toBeLessThan(1e-6)
    expect(() => alignedRest(new Vector3(), new Vector3(0, -1, 0), new Vector3(0, -1, 0))).toThrow(/parallel/)

    for (const rig of [AUTO, AUTO_T]) {
      let alongY = 0
      for (const b of rig.bones) {
        const d = dir(b)
        const [x, y, z] = [axis(b, 0), axis(b, 1), axis(b, 2)]
        expect(q4(b.rest_q).length()).toBeCloseTo(1, 8)
        expect(b.rest_q[0]).toBeGreaterThanOrEqual(0)
        // local Y runs along the bone, X = Y x Z (ANGLE: heads and tails are rounded to 1e-7 m, as in rig.json)
        expect(y.angleTo(d), b.name).toBeLessThan(ANGLE)
        expect(x.distanceTo(new Vector3().crossVectors(y, z)), b.name).toBeLessThan(1e-6)
        // local Z is the roll target made perpendicular to the bone
        let target: Vector3
        if (FINGER.test(b.name) || b.name.startsWith('grip.')) target = v3(rig.hands[sideOf(b.name)]!.palm_normal)
        else if (Math.abs(d.y) > 0.9) {
          target = new Vector3(0, 0, 1)
          alongY++
        } else target = new Vector3(0, -1, 0)
        const want = target.clone().sub(d.clone().multiplyScalar(target.dot(d))).normalize()
        expect(z.angleTo(want), b.name).toBeLessThan(ANGLE)
      }
      expect(alongY).toBe(4) // the feet and toes run along Y and are rolled toward +Z instead
      // contracts section 10: on auto rigs the finger frame F_b equals the bone's rest rotation
      for (const b of rig.bones) {
        if (FINGER.test(b.name)) expect(quatAngleDeg(fingerFrame(rig, b.index, sideOf(b.name)), q4(b.rest_q)), b.name).toBeLessThan(1e-3)
      }
      // the socket: Y along the grip axis, Z out of the palm
      for (const s of ['L', 'R'] as const) {
        const g = rig.bones.find((b) => b.name === `grip.${s}`)!
        expect(axis(g, 1).angleTo(v3(rig.hands[s]!.grip_axis!))).toBeLessThan(ANGLE)
        expect(axis(g, 2).angleTo(v3(rig.hands[s]!.palm_normal))).toBeLessThan(ANGLE)
        expect(v3(g.tail).distanceTo(v3(g.head))).toBeCloseTo(0.1, 6)
      }
    }
  })

  it('is deterministic, a new object each call, and plain JSON', () => {
    expect(autoRig()).toEqual(AUTO)
    expect(autoRig()).not.toBe(AUTO)
    expect(JSON.parse(JSON.stringify(AUTO))).toEqual(AUTO) // no -0, no undefined
    expect(JSON.parse(JSON.stringify(IMPORTED))).toEqual(IMPORTED)
    expect(importedRig()).toEqual(IMPORTED)
    // from the rig's own (rounded) joints: the same bones, rest rotations within the rounding
    const again = autoRigFromJoints(AUTO.joints, { height_m: 1.83, floor_z: -0.01 })
    expect(again).toMatchObject({ height_m: 1.83, floor_z: -0.01, joints: AUTO.joints })
    again.bones.forEach((b, i) => {
      expect({ ...b, rest_q: null }).toEqual({ ...AUTO.bones[i], rest_q: null })
      expect(quatAngleDeg(q4(b.rest_q), q4(AUTO.bones[i].rest_q)), b.name).toBeLessThan(1e-3)
    })
  })
})

describe('imported rig', () => {
  const canonical = IMPORTED.bones.filter((b) => b.canonical !== null)
  const extra = IMPORTED.bones.filter((b) => b.canonical === null)

  it('maps every canonical bone once, under its own names, in another order', () => {
    expect(IMPORTED.kind).toBe('imported')
    expect(IMPORTED.meshes).toEqual([])
    expect(canonical.map((b) => b.canonical).sort()).toEqual(BONES.map((b) => b.name).sort())
    for (const b of IMPORTED.bones) {
      expect(b.index).toBe(IMPORTED.bones.indexOf(b))
      expect(b.parent).toBeLessThan(b.index) // Blender lists parents first
      expect(b.gltf_node).not.toBe(b.index)
      if (!b.name.startsWith('mpm_grip.')) expect(b.name.startsWith(IMPORTED_PREFIX)).toBe(true)
      expect(b.name).not.toBe(b.canonical)
      expect(b.radius_m === null).toBe(!(b.canonical && FINGER.test(b.canonical)))
    }
    expect(new Set(IMPORTED.bones.map((b) => b.gltf_node)).size).toBe(IMPORTED.bones.length)
    // the canonical bones come in another order than on the auto rig (legs before the spine and arms)
    const order = canonical.map((b) => b.canonical)
    expect(order).not.toEqual(AUTO.bones.map((b) => b.name))
    expect(order.indexOf('thigh.L')).toBeLessThan(order.indexOf('spine'))
    // the canonical parent is the nearest mapped ancestor
    for (const b of canonical) {
      let p = b.parent
      while (p >= 0 && IMPORTED.bones[p].canonical === null) p = IMPORTED.bones[p].parent
      expect(p < 0 ? null : IMPORTED.bones[p].canonical, b.name).toBe(BONES.find((x) => x.name === b.canonical)!.parent)
    }
  })

  it('has unmapped bones: an extra spine bone in the chain, a twist bone per forearm, end bones, a prop', () => {
    const name = (n: string): RigBone => IMPORTED.bones.find((b) => b.name === IMPORTED_PREFIX + n)!
    expect(extra.length).toBe(17)
    expect(name('Spine1').canonical).toBeNull()
    expect(IMPORTED.bones[name('Spine1').parent].canonical).toBe('spine')
    expect(name('Spine2').canonical).toBe('chest')
    expect(name('Spine2').parent).toBe(name('Spine1').index)
    for (const S of ['Left', 'Right']) {
      const twist = name(`${S}ForeArmTwist`)
      expect(twist.canonical).toBeNull()
      expect(twist.deform).toBe(true)
      expect(twist.parent).toBe(name(`${S}ForeArm`).index)
      expect(IMPORTED.bones.some((b) => b.parent === twist.index)).toBe(false) // a leaf
      expect(name(`${S}Toe_End`).parent).toBe(name(`${S}ToeBase`).index)
      expect(name(`${S}HandIndex4`).canonical).toBeNull()
    }
    expect(name('HeadTop_End').parent).toBe(name('Head').index)
    expect(name('RightHandProp')).toMatchObject({ canonical: null, deform: false, parent: name('RightHand').index })
  })

  it('has the two sockets the engine adds, and otherwise rolls that are not the canonical ones', () => {
    for (const s of ['L', 'R'] as const) {
      const g = IMPORTED.bones.find((b) => b.name === `mpm_grip.${s}`)!
      const hand = IMPORTED.bones[g.parent]
      expect(g).toMatchObject({ canonical: `grip.${s}`, deform: false, head: IMPORTED.joints[`grip_${s}`], tail: IMPORTED.joints[`grip_tip_${s}`] })
      expect(hand.canonical).toBe(`hand.${s}`)
      expect(axis(g, 2).angleTo(v3(IMPORTED.hands[s]!.palm_normal))).toBeLessThan(ANGLE)
      // added last: the hand's last child
      expect(Math.max(...IMPORTED.bones.filter((b) => b.parent === hand.index).map((b) => b.index))).toBe(g.index)
    }
    for (const b of IMPORTED.bones) {
      // local Y still runs along the bone, as in every Blender armature
      expect(axis(b, 1).angleTo(dir(b)), b.name).toBeLessThan(ANGLE)
      if (b.name.startsWith('mpm_grip.')) continue
      // what build_armature would give this bone (by its canonical name), and how far the roll is from it
      const d = dir(b)
      const finger = b.canonical !== null && FINGER.test(b.canonical)
      const target = finger ? v3(IMPORTED.hands[sideOf(b.canonical as string)]!.palm_normal) : Math.abs(d.y) > 0.9 ? new Vector3(0, 0, 1) : new Vector3(0, -1, 0)
      const canonicalZ = target.clone().sub(d.clone().multiplyScalar(target.dot(d))).normalize()
      expect((axis(b, 2).angleTo(canonicalZ) * 180) / Math.PI, b.name).toBeGreaterThan(20)
    }
    // so the finger frame of contracts section 10 is not the rest rotation here: it has to come from geometry
    const index = IMPORTED.bones.find((b) => b.canonical === 'index.01.L')!
    expect(quatAngleDeg(fingerFrame(IMPORTED, index.index, 'L'), q4(index.rest_q))).toBeGreaterThan(20)
  })

  it('stands on the joints of the standard figure: T-pose by default, tails may stop short', () => {
    expect(IMPORTED.joints).toEqual(AUTO_T.joints)
    expect(IMPORTED.hands).toEqual(AUTO_T.hands)
    expect(importedRig({ tpose: false }).joints).toEqual(AUTO.joints)
    expect(IMPORTED.height_m).toBe(1.8)
    const short: string[] = []
    for (const b of canonical) {
      const def = BONES.find((x) => x.name === b.canonical)!
      // contracts section 8: each canonical bone's head gives its head joint
      expect(b.head, b.name).toEqual(IMPORTED.joints[def.head])
      // the bone points at its canonical tail joint, and ends on it or before it
      const toJoint = v3(IMPORTED.joints[def.tail]).sub(v3(b.head))
      expect(dir(b).angleTo(toJoint), b.name).toBeLessThan(1e-5)
      const ratio = v3(b.tail).distanceTo(v3(b.head)) / toJoint.length()
      expect(ratio).toBeLessThanOrEqual(1 + 1e-6)
      if (ratio < 0.999) short.push(b.canonical as string)
    }
    expect(short.sort()).toEqual(['chest', 'hand.L', 'hand.R', 'hips', 'spine'])
  })
})
