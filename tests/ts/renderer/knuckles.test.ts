// SPDX-License-Identifier: GPL-3.0-or-later
// Optional knuckle points (contracts section 4): two extra markers per finger for curved fingers.
import { describe, expect, it } from 'vitest'
import { deriveJoints } from '../../../src/shared/derive'
import type { MarkerMap } from '../../../src/shared/project'
import { addKnucklePoints, hasKnucklePoints, isFingerMarker, knucklePointNames, moveMarker, removeKnucklePoints } from '../../../src/renderer/lib/markers'
import { standardMarkers } from '../helpers/skeletonRig'

const base = (): MarkerMap =>
  Object.fromEntries(Object.entries(standardMarkers()).map(([k, p]) => [k, { p: [p[0], p[1], p[2]], confidence: 1, source: 'auto' as const }]))
const vec = (m: MarkerMap) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.p]))

describe('knuckle points', () => {
  it('are absent by default and the middle joints lie on the straight line', () => {
    const m = base()
    expect(hasKnucklePoints(m, 'L')).toBe(false)
    const J = deriveJoints(vec(m))
    const a = J.index_0_L
    const t = J.index_tip_L
    expect(J.index_1_L.distanceTo(a.clone().lerp(t, 0.45))).toBeLessThan(1e-12)
    expect(J.thumb_2_R.distanceTo(J.thumb_0_R.clone().lerp(J.thumb_tip_R, 0.73))).toBeLessThan(1e-12)
  })

  it('adding them changes nothing until one is moved; then the joint follows the marker', () => {
    const m = base()
    const before = deriveJoints(vec(m))
    const added = addKnucklePoints(m, 'L')
    expect(knucklePointNames('L')).toHaveLength(10)
    expect(hasKnucklePoints(added, 'L')).toBe(true)
    expect(hasKnucklePoints(added, 'R')).toBe(false)
    for (const n of knucklePointNames('L')) {
      expect(isFingerMarker(n)).toBe(true)
      expect(added[n].source).toBe('user')
    }
    const same = deriveJoints(vec(added))
    for (const k of Object.keys(before)) expect(same[k].distanceTo(before[k])).toBeLessThan(1e-12)
    const p = added.index_1_L.p
    const moved = moveMarker(added, 'index_1_L', [p[0], p[1] - 0.02, p[2]], false)
    const J = deriveJoints(vec(moved))
    expect(J.index_1_L.y).toBeCloseTo(p[1] - 0.02, 12)
    expect(J.index_2_L.distanceTo(before.index_2_L)).toBeLessThan(1e-12)
  })

  it('mirrored edits move the partner only when it has the point too', () => {
    const both = addKnucklePoints(addKnucklePoints(base(), 'L'), 'R')
    const p = both.ring_2_L.p
    const moved = moveMarker(both, 'ring_2_L', [p[0], p[1], p[2] + 0.01], true)
    expect(moved.ring_2_R.p).toEqual([-p[0], p[1], p[2] + 0.01])
    const one = addKnucklePoints(base(), 'L')
    expect(moveMarker(one, 'ring_2_L', [p[0], p[1], p[2] + 0.01], true).ring_2_R).toBeUndefined()
  })

  it('removing them restores the straight fingers and leaves the other hand alone', () => {
    const both = addKnucklePoints(addKnucklePoints(base(), 'L'), 'R')
    const out = removeKnucklePoints(both, 'L')
    expect(hasKnucklePoints(out, 'L')).toBe(false)
    expect(hasKnucklePoints(out, 'R')).toBe(true)
    expect(Object.keys(out)).toHaveLength(Object.keys(base()).length + 10)
  })
})
