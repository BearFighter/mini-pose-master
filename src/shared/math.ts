// SPDX-License-Identifier: GPL-3.0-or-later
// Small math helpers for pose work in Blender space (three.js classes used purely as math).
import { Matrix4, Quaternion, Vector3 } from 'three'
import type { QuatWXYZ, Vec3 } from './coords'

export const v3 = (a: Vec3): Vector3 => new Vector3(a[0], a[1], a[2])
export const arr = (v: Vector3): Vec3 => [v.x, v.y, v.z]

/** JSON [w,x,y,z] -> Quaternion (Blender space, no axis conversion). */
export const q4 = (q: QuatWXYZ): Quaternion => new Quaternion(q[1], q[2], q[3], q[0]).normalize()

/** Quaternion -> JSON [w,x,y,z], normalised, w >= 0. */
export function wxyz(q: Quaternion): QuatWXYZ {
  const n = q.clone().normalize()
  const s = n.w < 0 ? -1 : 1
  return [s * n.w, s * n.x, s * n.y, s * n.z]
}

export const mul = (a: Quaternion, b: Quaternion): Quaternion => new Quaternion().multiplyQuaternions(a, b)
export const inv = (a: Quaternion): Quaternion => a.clone().invert()
export const rotate = (q: Quaternion, v: Vector3): Vector3 => v.clone().applyQuaternion(q)

/** contracts section 6 frame(y, x_hint): orthonormal basis with columns [x, y, z], as a quaternion. */
export function frame(y: Vector3, xHint: Vector3): Quaternion {
  const Y = y.clone().normalize()
  let X = xHint.clone().sub(Y.clone().multiplyScalar(xHint.dot(Y)))
  if (X.lengthSq() < 1e-16) {
    X = Math.abs(Y.x) < 0.9 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0)
    X.sub(Y.clone().multiplyScalar(X.dot(Y)))
  }
  X.normalize()
  const Z = new Vector3().crossVectors(X, Y)
  return new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(X, Y, Z)).normalize()
}

/** D = frame(a, ah) * frame(b, bh)^T : rotation taking the rest frame onto the target frame. */
export function frameDelta(dTarget: Vector3, hTarget: Vector3, dRest: Vector3, hRest: Vector3): Quaternion {
  return mul(frame(dTarget, hTarget), inv(frame(dRest, hRest)))
}

/** Minimal rotation taking unit-ish vector a onto b. */
export const rotBetween = (a: Vector3, b: Vector3): Quaternion =>
  new Quaternion().setFromUnitVectors(a.clone().normalize(), b.clone().normalize())

/** Angle between two quaternion rotations in degrees. */
export function quatAngleDeg(a: Quaternion, b: Quaternion): number {
  const d = Math.min(1, Math.abs(a.clone().normalize().dot(b.clone().normalize())))
  return (2 * Math.acos(d) * 180) / Math.PI
}
