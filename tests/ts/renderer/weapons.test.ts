// SPDX-License-Identifier: GPL-3.0-or-later
// Weapon placement helpers (src/renderer/lib/weapons.ts) and the viewer's attach/helper nesting.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BufferAttribute, BufferGeometry, Matrix4, Mesh, Object3D, Quaternion, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { detailNumbers as numbers } from '../../../src/renderer/lib/errors'
import {
  defaultOffset,
  gripRotation,
  gripTolerance,
  lengthMm,
  m4B2T,
  nextWeaponId,
  principalAxis,
  supportFromHit,
  translationFor,
  unitMm,
  weaponTriangles,
  withGripPoint,
  withScale
} from '../../../src/renderer/lib/weapons'
import { DEFAULT_BAKE } from '../../../src/renderer/store/bake'
import { quatB2T, vecB2T, vecT2B } from '../../../src/shared/coords'
import { q4, v3 } from '../../../src/shared/math'
import type { RigJson } from '../../../src/shared/rig'
import { attachFrame, weaponMatrix } from '../../../src/shared/weaponPose'

const RIG = JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'rig_auto_apose.json'), 'utf8')) as RigJson
const close = (a: Vector3, b: Vector3, eps = 1e-9) => expect(a.distanceTo(b)).toBeLessThan(eps)

describe('grip placement', () => {
  it('lays the weapon axis along the socket +Y and the palm direction on +Z', () => {
    const q = q4(gripRotation([0, 0, 1], [-1, 0, 0]))
    close(new Vector3(0, 0, 1).applyQuaternion(q), new Vector3(0, 1, 0))
    close(new Vector3(-1, 0, 0).applyQuaternion(q), new Vector3(0, 0, 1))
    // without a palm direction: the shortest turn of the axis
    const q2 = q4(gripRotation([1, 0, 0]))
    close(new Vector3(1, 0, 0).applyQuaternion(q2), new Vector3(0, 1, 0))
    // a palm direction along the axis is ignored
    close(new Vector3(0, 0, 1).applyQuaternion(q4(gripRotation([0, 0, 1], [0, 0, 2]))), new Vector3(0, 1, 0))
  })

  it('puts the grip point on the socket, also after a new scale', () => {
    const d = composeSomePose()
    const p: [number, number, number] = [0.01, -0.02, 0.15]
    const q = gripRotation([0, 0, 1], [-1, 0, 0])
    const offset = { t: translationFor(q, 1.5, p), q, s: 1.5 }
    const socket = new Vector3().setFromMatrixPosition(attachFrame(RIG, d, 'grip.R')!)
    close(v3(p).applyMatrix4(weaponMatrix(RIG, d, { attach_bone: 'grip.R', offset })!), socket)
    const scaled = withScale(offset, 0.5)
    expect(scaled.s).toBe(0.5)
    close(v3(p).applyMatrix4(weaponMatrix(RIG, d, { attach_bone: 'grip.R', offset: scaled })!), socket)
    const regripped = withGripPoint(offset, [0, 0, -0.1])
    close(new Vector3(0, 0, -0.1).applyMatrix4(weaponMatrix(RIG, d, { attach_bone: 'grip.R', offset: regripped })!), socket)
    // default: the bbox centre on the socket, the principal axis along the grip
    const def = defaultOffset([0, 0, 1], [0, 0, 0.4])
    const W = weaponMatrix(RIG, d, { attach_bone: 'grip.R', offset: def })!
    close(new Vector3(0, 0, 0.4).applyMatrix4(W), socket)
    const along = new Vector3(0, 0, 1).transformDirection(W)
    close(along, new Vector3(0, 1, 0).transformDirection(attachFrame(RIG, d, 'grip.R')!), 1e-9)
  })

  it('support grip from a click: palm into the weapon, unit axis', () => {
    expect(supportFromHit([0, 0, 0.1], [2, 0, 0], [0, 0, 3])).toEqual({ point: [0, 0, 0.1], normal: [-1, -0, -0], axis: [0, 0, 1] })
  })

  it('finds the principal axis of an elongated point cloud', () => {
    const pts: number[] = []
    for (let i = 0; i < 200; i++) {
      const t = (i / 199 - 0.5) * 1.2
      pts.push(0.3 * t + 0.01 * Math.sin(i), -0.1 * t + 0.01 * Math.cos(i * 1.3), 0.9 * t)
    }
    const a = principalAxis(pts)
    const exp = new Vector3(0.3, -0.1, 0.9).normalize()
    expect(new Vector3(...a).angleTo(exp)).toBeLessThan(0.02)
    expect(a[2]).toBeGreaterThan(0) // largest component positive
    expect(principalAxis([1, 2, 3])).toEqual([0, 0, 1])
  })
})

describe('print scale', () => {
  it('unit_mm and tol_m follow engine/mpm/bake.py', () => {
    expect(unitMm(RIG, DEFAULT_BAKE)).toBeCloseTo(40 / RIG.height_m, 12)
    const j = RIG.joints
    const eye = j.head[2] + 0.4 * (j.head_top[2] - j.head[2]) - RIG.floor_z
    expect(unitMm(RIG, { ...DEFAULT_BAKE, scale: { mode: 'heroic', size_mm: 32 } })).toBeCloseTo(32 / eye, 12)
    expect(gripTolerance(RIG, DEFAULT_BAKE)).toBeCloseTo(0.2 / (40 / RIG.height_m), 12)
    expect(lengthMm([0.05, 0.9, 0.1], 0.5, 20)).toBeCloseTo(9, 12)
    expect(nextWeaponId(['w1', 'w3'])).toBe('w2')
  })
})

describe('three <-> Blender', () => {
  it('m4B2T and the attach/helper nesting give weaponMatrix in three space', () => {
    const d = composeSomePose()
    const offset = { t: [0.02, -0.03, 0.01] as [number, number, number], q: gripRotation([0.2, 0.1, 1], [-1, 0, 0.1]), s: 1.3 }
    const Wb = weaponMatrix(RIG, d, { attach_bone: 'grip.R', offset })!
    const p: [number, number, number] = [0.05, -0.01, 0.2]
    const expected = vecB2T(new Vector3(...p).applyMatrix4(Wb).toArray() as [number, number, number])
    close(vecB2T(p).applyMatrix4(m4B2T(Wb)), expected)
    // the viewer: attach (C^-1 A C) -> helper (C^-1 TRS C) -> weapon (three coordinates)
    const attach = new Object3D()
    attach.matrixAutoUpdate = false
    attach.matrix.copy(m4B2T(attachFrame(RIG, d, 'grip.R')!))
    const helper = new Object3D()
    helper.position.copy(vecB2T(offset.t))
    helper.quaternion.copy(quatB2T(offset.q))
    helper.scale.setScalar(offset.s)
    const weapon = new Object3D()
    attach.add(helper)
    helper.add(weapon)
    attach.updateMatrixWorld(true)
    close(vecB2T(p).applyMatrix4(weapon.matrixWorld), expected, 1e-9)
  })

  it('weapon triangles come out in Blender armature space', () => {
    const g = new BufferGeometry()
    // one triangle in three.js coordinates of the weapon GLB
    g.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0, 0.1, 0, 0, 0, 0.2, 0]), 3))
    const root = new Object3D()
    root.add(new Mesh(g))
    const Wb = new Matrix4().compose(new Vector3(1, 2, 3), new Quaternion(), new Vector3(1, 1, 1))
    const tris = weaponTriangles(root, Wb)
    // three (0, 0.2, 0) is Blender (0, 0, 0.2)
    close(new Vector3(tris[6], tris[7], tris[8]), new Vector3(1, 2, 3.2), 1e-6)
    close(new Vector3(tris[3], tris[4], tris[5]), new Vector3(1.1, 2, 3), 1e-6)
    expect(vecT2B(new Vector3(0, 0.2, 0))).toEqual([0, -0, 0.2])
  })
})

describe('error details', () => {
  it('lists the numbers of a job error detail', () => {
    expect(numbers({ moved_fraction: 0.0312345, worst_drift: 0.01234, grow: 1.5, note: 'x' })).toBe('moved_fraction 0.0312, worst_drift 0.0123, grow 1.5')
    expect(numbers(undefined)).toBe('')
  })
})

function composeSomePose() {
  const q = new Quaternion().setFromAxisAngle(new Vector3(0.3, 1, 0.2).normalize(), 0.6)
  const i = RIG.bones.findIndex((b) => b.canonical === 'upper_arm.R')
  return { [String(i)]: [q.w, q.x, q.y, q.z] as [number, number, number, number] }
}
