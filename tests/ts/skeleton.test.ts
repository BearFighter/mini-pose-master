// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from 'vitest'
import { JOINTS, BONES, boneIndex, mirrorName } from '../../src/shared/skeleton'

describe('skeleton', () => {
  it('has 68 joints and 53 bones', () => {
    expect(JOINTS.length).toBe(68)
    expect(BONES.length).toBe(53)
  })

  it('lists every parent before its child', () => {
    BONES.forEach((bone, i) => {
      if (bone.parent === null) return
      const parentIndex = BONES.findIndex((b) => b.name === bone.parent)
      expect(parentIndex).toBeGreaterThanOrEqual(0)
      expect(parentIndex).toBeLessThan(i)
    })
  })

  it('starts with hips, spine, chest, neck, head', () => {
    expect(BONES.slice(0, 5).map((b) => b.name)).toEqual(['hips', 'spine', 'chest', 'neck', 'head'])
  })

  it('puts upper_arm.L before upper_arm.R', () => {
    expect(boneIndex('upper_arm.L')).toBeGreaterThanOrEqual(0)
    expect(boneIndex('upper_arm.L')).toBeLessThan(boneIndex('upper_arm.R'))
  })

  it('mirrors names by swapping trailing .L/.R and _L/_R only', () => {
    expect(mirrorName('thumb.01.L')).toBe('thumb.01.R')
    expect(mirrorName('hip_R')).toBe('hip_L')
    expect(mirrorName('hips')).toBe('hips')
  })

  it('uses only known joints for every bone head and tail', () => {
    const joints = new Set(JOINTS.map((j) => j.name))
    for (const bone of BONES) {
      expect(joints.has(bone.head), `${bone.name} head ${bone.head}`).toBe(true)
      expect(joints.has(bone.tail), `${bone.name} tail ${bone.tail}`).toBe(true)
    }
  })

  it('keeps grip.L non-deforming', () => {
    const grip = BONES.find((b) => b.name === 'grip.L')
    expect(grip?.deform).toBe(false)
  })
})
