// SPDX-License-Identifier: GPL-3.0-or-later
// contracts section 5 pose math on a bound three.js rig.
import { Matrix4, Quaternion, Vector3 } from 'three'
import { quatB2T, vecB2T, vecT2B } from './coords'
import type { QuatWXYZ, Vec3 } from './coords'
import type { BoundRig } from './rig'

/**
 * Pose the rig: deltas are armature-space D_b in Blender coordinates keyed by rig.json bone index.
 * Missing bones inherit D_parent. q_local_b = q_restlocal_b * (R_rest_b^-1 D_p^-1 D_b R_rest_b), in
 * three space. The root offset (Blender metres, armature space) moves the hips bone.
 * Returns the three-space deltas per bone.
 */
export function applyPoseState(
  b: BoundRig,
  deltas: Record<string, QuatWXYZ>,
  rootOffset: Vec3 = [0, 0, 0]
): Quaternion[] {
  const D: Quaternion[] = new Array(b.bones.length)
  for (const i of b.order) {
    const p = b.rig.bones[i].parent
    const given = deltas[String(i)]
    const Dp = p >= 0 ? D[p] : new Quaternion()
    const Di = given ? quatB2T(given) : Dp.clone()
    D[i] = Di
    const Rr = b.restArm[i]
    const rel = Rr.clone().invert().multiply(Dp.clone().invert()).multiply(Di).multiply(Rr)
    const bone = b.bones[i]
    bone.quaternion.copy(b.restLocal[i]).multiply(rel).normalize()
    bone.position.copy(b.restPos[i])
  }
  if (b.hipsIndex !== null && (rootOffset[0] || rootOffset[1] || rootOffset[2])) {
    const i = b.hipsIndex
    const p = b.rig.bones[i].parent
    const off = vecB2T(rootOffset)
    if (p >= 0) {
      // parent's posed armature rotation = D_p R_rest_p ; express the offset in the parent's local frame
      const parentArm = D[p].clone().multiply(b.restArm[p])
      off.applyQuaternion(parentArm.invert())
    }
    b.bones[i].position.add(off)
  }
  b.armature.updateMatrixWorld(true)
  return D
}

/** Posed bone heads in Blender coordinates (armature space, metres). */
export function posedHeadsBlender(b: BoundRig): Vec3[] {
  const inv = new Matrix4().copy(b.armature.matrixWorld).invert()
  return b.bones.map((o) => vecT2B(new Vector3().setFromMatrixPosition(o.matrixWorld).applyMatrix4(inv)))
}
