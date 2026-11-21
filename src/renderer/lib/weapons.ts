// SPDX-License-Identifier: GPL-3.0-or-later
// Weapon placement helpers for the Weapons step (contracts section 12): offsets that put a grip point
// on the socket, the weapon's principal axis, print scale, three <-> Blender 4x4 conversion, and the
// weapon's triangles in Blender armature space (for auto-grip).
import { Matrix4, type Mesh, type Object3D, Quaternion, Vector3, type BufferAttribute } from 'three'
import type { QuatWXYZ, Vec3 } from '../../shared/coords'
import { C, CT } from '../../shared/coords'
import { arr, q4, v3, wxyz } from '../../shared/math'
import type { BakeSettings } from '../../shared/project'
import type { RigJson } from '../../shared/rig'
import type { WeaponOffset } from '../../shared/weaponPose'

/** C (three -> Blender) and C^T as 4x4. */
export const C4 = new Matrix4().setFromMatrix3(C)
export const CT4 = new Matrix4().setFromMatrix3(CT)

/** A Blender-space transform as a three.js one: M_t = C^-1 * M_b * C. */
export function m4B2T(mb: Matrix4): Matrix4 {
  return CT4.clone().multiply(mb).multiply(C4)
}

/**
 * The offset rotation that lays the weapon-local `axis` along the attach frame's +Y (the grip bone points
 * along the hand's grip axis). With `palm` (the weapon-local direction the palm faces) the attach frame's
 * +Z (the palm normal) is turned onto it too; without, the turn about the axis is the shortest one.
 */
export function gripRotation(axis: Vec3, palm: Vec3 | null = null): QuatWXYZ {
  const a = v3(axis).normalize()
  if (!palm) return wxyz(new Quaternion().setFromUnitVectors(a, new Vector3(0, 1, 0)))
  const n = v3(palm)
  n.sub(a.clone().multiplyScalar(n.dot(a)))
  if (n.lengthSq() < 1e-12) return gripRotation(axis, null)
  n.normalize()
  const x = new Vector3().crossVectors(a, n)
  // columns: where the attach frame's x, y, z axes point in weapon-local space
  const toWeapon = new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(x, a, n))
  return wxyz(toWeapon.invert())
}

/** offset.t that puts the weapon-local point `p` on the socket: t = -q * s * p. */
export function translationFor(q: QuatWXYZ, s: number, p: Vec3): Vec3 {
  return arr(v3(p).multiplyScalar(s).applyQuaternion(q4(q)).negate())
}

/** Default placement: the principal axis along the grip, the bounding-box centre on the socket. */
export function defaultOffset(principal: Vec3, center: Vec3, s = 1): WeaponOffset {
  const q = gripRotation(principal)
  return { t: translationFor(q, s, center), q, s }
}

/** "Set grip point": the clicked weapon-local point moves to the socket; rotation and scale stay. */
export function withGripPoint(offset: WeaponOffset, p: Vec3): WeaponOffset {
  return { ...offset, t: translationFor(offset.q, offset.s, p) }
}

/** A new scale keeps the grip point (the weapon-local point now on the socket) where it is. */
export function withScale(offset: WeaponOffset, s: number): WeaponOffset {
  const onSocket = v3(offset.t).negate().applyQuaternion(q4(offset.q).invert()).multiplyScalar(1 / offset.s)
  return { ...offset, s, t: translationFor(offset.q, s, arr(onSocket)) }
}

/** The support grip from a click on the weapon: the palm faces into the weapon (opposite the surface normal). */
export function supportFromHit(point: Vec3, surfaceNormal: Vec3, axis: Vec3): { point: Vec3; normal: Vec3; axis: Vec3 } {
  const n = v3(surfaceNormal).normalize().negate()
  return { point, normal: arr(n), axis: arr(v3(axis).normalize()) }
}

export function flipAxis(axis: Vec3): Vec3 {
  return [-axis[0], -axis[1], -axis[2]]
}

/**
 * The weapon's principal axis (largest variance of its vertices, largest component positive), like the
 * convert_weapon job. `points` are xyz triples.
 */
export function principalAxis(points: ArrayLike<number>): Vec3 {
  const n = Math.floor(points.length / 3)
  if (n < 2) return [0, 0, 1]
  const mean = [0, 0, 0]
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) mean[k] += points[i * 3 + k] / n
  const c = [0, 0, 0, 0, 0, 0, 0, 0, 0]
  for (let i = 0; i < n; i++) {
    const d = [points[i * 3] - mean[0], points[i * 3 + 1] - mean[1], points[i * 3 + 2] - mean[2]]
    for (let r = 0; r < 3; r++) for (let k = 0; k < 3; k++) c[r * 3 + k] += d[r] * d[k]
  }
  // power iteration from the axis with the largest variance
  let v = [0, 0, 0]
  v[[c[0], c[4], c[8]].indexOf(Math.max(c[0], c[4], c[8]))] = 1
  for (let it = 0; it < 100; it++) {
    const w = [0, 1, 2].map((r) => c[r * 3] * v[0] + c[r * 3 + 1] * v[1] + c[r * 3 + 2] * v[2])
    const len = Math.hypot(w[0], w[1], w[2])
    if (len < 1e-30) break
    v = w.map((x) => x / len)
  }
  const i = [0, 1, 2].reduce((best, k) => (Math.abs(v[k]) > Math.abs(v[best]) ? k : best), 0)
  return (v[i] < 0 ? v.map((x) => -x) : v) as Vec3
}

/** Millimetres per model metre (engine/mpm/bake.py unit_mm). */
export function unitMm(rig: RigJson, bake: BakeSettings | null): number {
  const sc = bake?.scale ?? { mode: 'height_mm' as const, height_mm: 40 }
  if (sc.mode === 'heroic') {
    const j = rig.joints
    if (!j.head || !j.head_top) return 40 / Math.max(rig.height_m, 1e-9)
    const eye = j.head[2] + 0.4 * (j.head_top[2] - j.head[2]) - (rig.floor_z ?? 0)
    return sc.size_mm / Math.max(eye, 1e-9)
  }
  return sc.height_mm / Math.max(rig.height_m, 1e-9)
}

/** Model metres -> millimetres at print scale. */
export function printMm(metres: number, mmPerMetre: number): number {
  return metres * mmPerMetre
}

/** A weapon's longest dimension at print scale. */
export function lengthMm(dims: Vec3, s: number, mmPerMetre: number): number {
  return Math.max(...dims) * s * mmPerMetre
}

/**
 * The weapon's triangles in Blender armature space: every mesh under `root` (three.js coordinates of the
 * weapon GLB, i.e. C^-1 * Blender weapon-local), converted with C and moved by `Mb` (weaponMatrix).
 * Returns xyz triples, 9 numbers per triangle.
 */
export function weaponTriangles(root: Object3D, Mb: Matrix4): Float32Array {
  root.updateMatrixWorld(true)
  const rootInv = root.matrixWorld.clone().invert()
  const out: number[] = []
  const v = new Vector3()
  const toArmature = Mb.clone().multiply(C4)
  root.traverse((o) => {
    const mesh = o as Mesh
    if (!mesh.isMesh) return
    const m = toArmature.clone().multiply(rootInv.clone().multiply(mesh.matrixWorld))
    const pos = mesh.geometry.getAttribute('position') as BufferAttribute
    const index = mesh.geometry.getIndex()
    const count = index ? index.count : pos.count
    for (let i = 0; i < count; i++) {
      v.fromBufferAttribute(pos, index ? index.getX(i) : i).applyMatrix4(m)
      out.push(v.x, v.y, v.z)
    }
  })
  return new Float32Array(out)
}

/** The next free weapon id: w1, w2, ... */
export function nextWeaponId(ids: string[]): string {
  for (let n = 1; ; n++) if (!ids.includes(`w${n}`)) return `w${n}`
}
