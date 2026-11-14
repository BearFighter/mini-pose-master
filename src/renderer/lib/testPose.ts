// SPDX-License-Identifier: GPL-3.0-or-later
// The fixed "Test pose" of the Rig step: both arms raised 45 degrees, the left knee bent.
// Armature-space deltas D_b in Blender coordinates (contracts section 5), keyed by rig bone index.
import type { QuatWXYZ, Vec3 } from '../../shared/coords'
import type { Deltas } from '../../shared/fk'
import { canonicalIndex } from '../../shared/fk'
import type { RigJson } from '../../shared/rig'

function axisAngle(axis: Vec3, degrees: number): QuatWXYZ {
  const half = (degrees * Math.PI) / 360
  const s = Math.sin(half)
  return [Math.cos(half), axis[0] * s, axis[1] * s, axis[2] * s]
}

/**
 * Canonical bone -> D. The figure faces -Y with its left at +X:
 * - an arm swings out and up about the front-back axis (-Y for the left arm, +Y for the right);
 * - the left thigh swings forward (about -X), the shin back (about +X, 80 degrees of knee bend),
 *   and the foot keeps its rest orientation (D = identity), so it stays level.
 */
export const TEST_POSE: Record<string, QuatWXYZ> = {
  'upper_arm.L': axisAngle([0, -1, 0], 45),
  'upper_arm.R': axisAngle([0, 1, 0], 45),
  'thigh.L': axisAngle([1, 0, 0], -45),
  'shin.L': axisAngle([1, 0, 0], 35),
  'foot.L': [1, 0, 0, 0]
}

/** The test pose for a rig; canonical bones the rig doesn't have are skipped. */
export function testPoseDeltas(rig: RigJson): Deltas {
  const index = canonicalIndex(rig)
  const out: Deltas = {}
  for (const [canonical, q] of Object.entries(TEST_POSE)) {
    const i = index.get(canonical)
    if (i !== undefined) out[String(i)] = q
  }
  return out
}
