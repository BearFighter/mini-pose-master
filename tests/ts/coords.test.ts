// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { Quaternion, Vector3 } from 'three'
import { C, quatB2T, quatT2B, vecB2T, vecT2B } from '../../src/shared/coords'

describe('coords (contracts section 2)', () => {
  it('maps three +Y to Blender +Z', () => {
    const v = new Vector3(0, 1, 0).applyMatrix3(C)
    expect(v.x).toBeCloseTo(0, 12)
    expect(v.y).toBeCloseTo(0, 12)
    expect(v.z).toBeCloseTo(1, 12)
  })
  it('converts three (1,2,3) to Blender (1,-3,2) and back', () => {
    expect(vecT2B(new Vector3(1, 2, 3))).toEqual([1, -3, 2])
    const back = vecB2T([1, -3, 2])
    expect([back.x, back.y, back.z]).toEqual([1, 2, 3])
  })
  it('round-trips quaternions and keeps w >= 0', () => {
    for (let k = 0; k < 50; k++) {
      const axis = new Vector3(Math.sin(k), Math.cos(k * 1.7), Math.sin(k * 0.3) + 0.2).normalize()
      const q = new Quaternion().setFromAxisAngle(axis, (k / 50) * Math.PI * 1.9)
      const b = quatT2B(q)
      expect(b[0]).toBeGreaterThanOrEqual(0)
      const t = quatB2T(b)
      expect(Math.abs(t.dot(q))).toBeCloseTo(1, 9)
    }
  })
  it('rotates vectors consistently across spaces', () => {
    const q = new Quaternion().setFromAxisAngle(new Vector3(0.3, 0.9, -0.2).normalize(), 1.1)
    const vt = new Vector3(0.4, -0.7, 1.3)
    const rotatedT = vt.clone().applyQuaternion(q)
    const qb = quatT2B(q)
    const qbThree = new Quaternion(qb[1], qb[2], qb[3], qb[0])
    const vb = new Vector3(...vecT2B(vt)).applyQuaternion(qbThree)
    const expected = vecT2B(rotatedT)
    expect(vb.x).toBeCloseTo(expected[0], 9)
    expect(vb.y).toBeCloseTo(expected[1], 9)
    expect(vb.z).toBeCloseTo(expected[2], 9)
  })
})
