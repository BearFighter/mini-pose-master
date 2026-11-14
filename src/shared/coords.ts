// SPDX-License-Identifier: GPL-3.0-or-later
// Coordinate conversion between three.js / glTF (Y up) and Blender / engine JSON (Z up, faces -Y).
// contracts section 2: C maps three -> Blender, (x, y, z) -> (x, -z, y); C is +90 deg about X.
import { Matrix3, Matrix4, Quaternion, Vector3 } from 'three'

export type Vec3 = [number, number, number]
/** Quaternion as stored in JSON: [w, x, y, z], normalised, w >= 0. */
export type QuatWXYZ = [number, number, number, number]

/** three -> Blender. Matrix3.set takes row-major arguments. */
export const C = new Matrix3().set(1, 0, 0, 0, 0, -1, 0, 1, 0)
/** Blender -> three (C transposed = C inverse). */
export const CT = new Matrix3().set(1, 0, 0, 0, 0, 1, 0, -1, 0)

export function vecT2B(v: Vector3): Vec3 {
  return [v.x, -v.z, v.y]
}

export function vecB2T(v: Vec3): Vector3 {
  return new Vector3(v[0], v[2], -v[1])
}

/** R_t = C^T R_b C */
export function mat3B2T(m: Matrix3): Matrix3 {
  return CT.clone().multiply(m).multiply(C)
}

/** R_b = C R_t C^T */
export function mat3T2B(m: Matrix3): Matrix3 {
  return C.clone().multiply(m).multiply(CT)
}

function quatToMat3(q: Quaternion): Matrix3 {
  return new Matrix3().setFromMatrix4(new Matrix4().makeRotationFromQuaternion(q))
}

function mat3ToQuat(m: Matrix3): Quaternion {
  return new Quaternion().setFromRotationMatrix(new Matrix4().setFromMatrix3(m)).normalize()
}

/** JSON [w,x,y,z] in Blender space -> three Quaternion in three space. */
export function quatB2T(q: QuatWXYZ): Quaternion {
  const qb = new Quaternion(q[1], q[2], q[3], q[0]).normalize()
  return mat3ToQuat(mat3B2T(quatToMat3(qb)))
}

/** three Quaternion in three space -> JSON [w,x,y,z] in Blender space (normalised, w >= 0). */
export function quatT2B(q: Quaternion): QuatWXYZ {
  const qb = mat3ToQuat(mat3T2B(quatToMat3(q.clone().normalize())))
  const s = qb.w < 0 ? -1 : 1
  return [s * qb.w, s * qb.x, s * qb.y, s * qb.z]
}
