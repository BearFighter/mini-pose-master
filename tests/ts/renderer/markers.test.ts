// SPDX-License-Identifier: GPL-3.0-or-later
// Marker helpers: confidence colours, mirrored edits, list order, hand groups; test pose; orientation.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CONFIDENCE_COLORS,
  confidenceColor,
  confidenceLevel,
  displayConfidence,
  handMarkerNames,
  isFingerMarker,
  markerListOrder,
  mirrorX,
  moveMarker
} from '../../../src/renderer/lib/markers'
import { forwardChoices, pickOrientation, sameOrientation, unitScaleChoices, withUp } from '../../../src/renderer/lib/orientation'
import { basename, dirname, projectUrl } from '../../../src/renderer/lib/paths'
import { TEST_POSE, testPoseDeltas } from '../../../src/renderer/lib/testPose'
import { posedJoints, restJoints } from '../../../src/shared/fk'
import type { MarkerMap } from '../../../src/shared/project'
import type { RigJson } from '../../../src/shared/rig'

const markers = (): MarkerMap => ({
  pelvis: { p: [0, 0, 1], confidence: 0.9, source: 'auto' },
  shoulder_L: { p: [0.2, 0, 1.5], confidence: 0.4, source: 'auto' },
  shoulder_R: { p: [-0.21, 0.01, 1.49], confidence: 0.6, source: 'auto' },
  wrist_L: { p: [0.4, 0, 0.9], confidence: 0.5, source: 'auto' },
  index_tip_L: { p: [0.45, 0, 0.75], confidence: 0.5, source: 'auto' },
  thumb_0_R: { p: [-0.42, 0, 0.88], confidence: 0.3, source: 'auto' }
})

describe('confidence colours', () => {
  it('green >= 0.8, amber 0.5 to 0.8, red < 0.5', () => {
    expect(confidenceLevel(1)).toBe('high')
    expect(confidenceLevel(0.8)).toBe('high')
    expect(confidenceLevel(0.7999)).toBe('medium')
    expect(confidenceLevel(0.5)).toBe('medium')
    expect(confidenceLevel(0.4999)).toBe('low')
    expect(confidenceLevel(0)).toBe('low')
    expect(confidenceColor(0.85)).toBe(CONFIDENCE_COLORS.high)
    expect(confidenceColor(0.6)).toBe(CONFIDENCE_COLORS.medium)
    expect(confidenceColor(0.2)).toBe(CONFIDENCE_COLORS.low)
    expect(new Set(Object.values(CONFIDENCE_COLORS)).size).toBe(3)
  })

  it('a marker the user placed shows as certain', () => {
    expect(displayConfidence({ confidence: 0.2, source: 'user' })).toBe(1)
    expect(displayConfidence({ confidence: 0.2, source: 'auto' })).toBe(0.2)
  })
})

describe('moveMarker', () => {
  it('moves one marker and marks it as user-placed', () => {
    const before = markers()
    const after = moveMarker(before, 'shoulder_L', [0.25, 0.02, 1.52], false)
    expect(after.shoulder_L).toEqual({ p: [0.25, 0.02, 1.52], confidence: 0.4, source: 'user' })
    expect(after.shoulder_R).toEqual(before.shoulder_R)
    expect(before.shoulder_L.p).toEqual([0.2, 0, 1.5]) // input untouched
  })

  it('with mirror on, moves the L/R partner mirrored in x', () => {
    const after = moveMarker(markers(), 'shoulder_L', [0.25, 0.02, 1.52], true)
    expect(after.shoulder_R).toEqual({ p: [-0.25, 0.02, 1.52], confidence: 0.6, source: 'user' })
    const back = moveMarker(after, 'shoulder_R', [-0.3, 0.05, 1.4], true)
    expect(back.shoulder_L.p).toEqual([0.3, 0.05, 1.4])
  })

  it('centre markers and missing partners move alone', () => {
    const m = markers()
    const after = moveMarker(m, 'pelvis', [0.01, 0, 0.98], true)
    expect(after.pelvis.p).toEqual([0.01, 0, 0.98])
    expect(Object.keys(after)).toEqual(Object.keys(m))
    const wrist = moveMarker(m, 'wrist_L', [0.5, 0, 0.9], true) // no wrist_R in this map
    expect(wrist.wrist_R).toBeUndefined()
    expect(moveMarker(m, 'nope', [0, 0, 0], true)).toBe(m)
    expect(mirrorX([1, 2, 3])).toEqual([-1, 2, 3])
  })
})

describe('marker list and hands', () => {
  it('lists the lowest confidence first, ties in skeleton order', () => {
    expect(markerListOrder(markers())).toEqual(['thumb_0_R', 'shoulder_L', 'wrist_L', 'index_tip_L', 'shoulder_R', 'pelvis'])
  })

  it('knows the finger markers and the markers of each hand', () => {
    expect(isFingerMarker('index_tip_L')).toBe(true)
    expect(isFingerMarker('thumb_0_R')).toBe(true)
    expect(isFingerMarker('wrist_L')).toBe(false)
    expect(isFingerMarker('index_1_L')).toBe(false) // derived, never a marker
    expect(handMarkerNames(markers(), 'L').sort()).toEqual(['index_tip_L', 'wrist_L'])
    expect(handMarkerNames(markers(), 'R')).toEqual(['thumb_0_R'])
  })
})

describe('test pose', () => {
  const rig = JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'rig_auto_apose.json'), 'utf8')) as RigJson

  it('raises both arms 45 degrees and bends the left knee', () => {
    const deltas = testPoseDeltas(rig)
    expect(Object.keys(deltas).length).toBe(Object.keys(TEST_POSE).length)
    const rest = restJoints(rig)
    const posed = posedJoints(rig, deltas)
    for (const s of ['L', 'R']) {
      // the hands go up and out, symmetrically
      expect(posed[`wrist_${s}`].z).toBeGreaterThan(rest[`wrist_${s}`].z + 0.1)
      expect(Math.abs(posed[`wrist_${s}`].x)).toBeGreaterThan(Math.abs(rest[`wrist_${s}`].x))
      const angle = (a: string, b: string, P: typeof rest) => P[b].clone().sub(P[a]).normalize()
      const deg = (angle(`shoulder_${s}`, `elbow_${s}`, rest).angleTo(angle(`shoulder_${s}`, `elbow_${s}`, posed)) * 180) / Math.PI
      expect(deg).toBeCloseTo(45, 3)
    }
    expect(posed.wrist_L.x).toBeCloseTo(-posed.wrist_R.x, 6)
    // left knee forward (-Y), left ankle raised; the right leg stays at rest
    expect(posed.knee_L.y).toBeLessThan(rest.knee_L.y - 0.1)
    expect(posed.ankle_L.z).toBeGreaterThan(rest.ankle_L.z + 0.05)
    expect(posed.knee_R.distanceTo(rest.knee_R)).toBeLessThan(1e-9)
  })

  it('skips canonical bones the rig does not have', () => {
    const partial = { ...rig, bones: rig.bones.map((b) => (b.canonical === 'thigh.L' ? { ...b, canonical: null } : b)) }
    expect(Object.keys(testPoseDeltas(partial)).length).toBe(Object.keys(TEST_POSE).length - 1)
  })
})

describe('orientation choices', () => {
  it('offers only perpendicular forward axes and keeps a valid one', () => {
    expect(forwardChoices('Z')).toEqual(['Y', '-Y', 'X', '-X'])
    expect(forwardChoices('-Y')).toEqual(['Z', '-Z', 'X', '-X'])
    expect(withUp({ up: 'Z', forward: '-Y', unit_scale: 1 }, 'Y')).toEqual({ up: 'Y', forward: '-Z', unit_scale: 1 })
    expect(withUp({ up: 'Z', forward: 'X', unit_scale: 1 }, 'Y')).toEqual({ up: 'Y', forward: 'X', unit_scale: 1 })
    expect(pickOrientation({ up: 'Z', forward: '-Y', unit_scale: 0.01, reason: 'x' } as never)).toEqual({ up: 'Z', forward: '-Y', unit_scale: 0.01 })
    expect(sameOrientation({ up: 'Z', forward: '-Y', unit_scale: 1 }, { up: 'Z', forward: '-Y', unit_scale: 1 })).toBe(true)
    expect(sameOrientation({ up: 'Z', forward: '-Y', unit_scale: 1 }, null)).toBe(false)
    expect(unitScaleChoices(0.5).map((u) => u.value)).toContain(0.5)
  })
})

describe('renderer paths', () => {
  it('splits Windows and POSIX paths and builds mpm:// URLs', () => {
    expect(basename('C:\\Users\\me\\Hero\\')).toBe('Hero')
    expect(dirname('C:\\Users\\me\\Hero')).toBe('C:\\Users\\me')
    expect(dirname('C:\\Hero')).toBe('C:\\')
    expect(dirname('/home/me/Hero')).toBe('/home/me')
    expect(dirname('/Hero')).toBe('/')
    expect(projectUrl('rig/preview.glb')).toBe('mpm://project/rig/preview.glb')
    expect(projectUrl('rig\\my file.glb', 7)).toBe('mpm://project/rig/my%20file.glb?v=7')
  })
})
