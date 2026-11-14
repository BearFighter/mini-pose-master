// SPDX-License-Identifier: GPL-3.0-or-later
// contracts section 12: two-bone IK (support arm), plant feet. Deltas are absolute armature-space
// rotations, so changing a parent never changes a child's world orientation; only positions move.
import { Quaternion, Vector3 } from 'three'
import type { Deltas } from './fk'
import { canonicalIndex, posedBones, resolveDeltas } from './fk'
import { frame, inv, mul, q4, rotBetween, v3, wxyz } from './math'
import type { RigJson } from './rig'
import type { Vec3 } from './coords'

/** New mid/end positions for a chain a-b-c reaching target t, bending toward `pole`. */
export function solveTwoBone(
  a: Vector3,
  b: Vector3,
  c: Vector3,
  t: Vector3,
  pole: Vector3
): { mid: Vector3; end: Vector3; short: number } {
  const l1 = b.distanceTo(a)
  const l2 = c.distanceTo(b)
  const toT = t.clone().sub(a)
  const dist = toT.length()
  const axis = dist > 1e-9 ? toT.clone().divideScalar(dist) : new Vector3(0, 0, -1)
  if (dist >= l1 + l2) {
    const mid = a.clone().add(axis.clone().multiplyScalar(l1))
    const end = a.clone().add(axis.clone().multiplyScalar(l1 + l2))
    return { mid, end, short: dist - (l1 + l2) }
  }
  const d = Math.max(dist, Math.abs(l1 - l2) + 1e-9)
  let p = pole.clone().sub(axis.clone().multiplyScalar(pole.dot(axis)))
  if (p.lengthSq() < 1e-12) p = new Vector3(0, -1, 0).sub(axis.clone().multiplyScalar(-axis.y))
  p.normalize()
  const cosA = (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d)
  const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA))
  const mid = a.clone().add(axis.clone().multiplyScalar(l1 * cosA)).add(p.multiplyScalar(l1 * sinA))
  const end = a.clone().add(axis.clone().multiplyScalar(d))
  return { mid, end, short: 0 }
}

function swingTo(D: Quaternion, restDir: Vector3, newDir: Vector3): Quaternion {
  const cur = restDir.clone().applyQuaternion(D)
  return mul(rotBetween(cur, newDir), D).normalize()
}

export interface ReachResult {
  deltas: Deltas
  reachShort: number
}

/**
 * Move side s's wrist (hand head) to `target`. Optional `orient` sets the hand so its grip frame
 * (grip_axis, palm_normal) matches (axis, normal) in armature space.
 */
export function reachArm(
  rig: RigJson,
  deltas: Deltas,
  s: 'L' | 'R',
  target: Vec3,
  orient?: { axis: Vec3; normal: Vec3 }
): ReachResult {
  const ci = canonicalIndex(rig)
  const ua = ci.get(`upper_arm.${s}`)
  const fa = ci.get(`forearm.${s}`)
  const hd = ci.get(`hand.${s}`)
  if (ua === undefined || fa === undefined || hd === undefined) throw new Error(`rig has no ${s} arm`)
  const out = resolveDeltas(rig, deltas)
  const pb = posedBones(rig, out)
  const a = pb[ua].head
  const b = pb[fa].head
  const c = pb[hd].head
  const sign = s === 'L' ? 1 : -1
  let pole = b.clone().sub(a)
  if (pole.lengthSq() < 1e-12) pole = new Vector3(sign, 0.3, -1).normalize()
  const sol = solveTwoBone(a, b, c, v3(target), pole)
  const rest = (i: number): Vector3 => v3(rig.bones[i].tail).sub(v3(rig.bones[i].head)).normalize()
  out[String(ua)] = wxyz(swingTo(q4(out[String(ua)]), rest(ua), sol.mid.clone().sub(a).normalize()))
  out[String(fa)] = wxyz(swingTo(q4(out[String(fa)]), rest(fa), sol.end.clone().sub(sol.mid).normalize()))
  const hf = rig.hands[s]
  if (orient && hf) {
    const ga = v3(hf.grip_axis ?? hf.lateral)
    const pn = v3(hf.palm_normal)
    out[String(hd)] = wxyz(mul(frame(v3(orient.axis), v3(orient.normal)), inv(frame(ga, pn))))
  }
  return { deltas: out, reachShort: sol.short }
}

const FOOT_JOINT_BONES = ['foot', 'toe']

function footLow(rig: RigJson, deltas: Deltas, s: 'L' | 'R'): number {
  const ci = canonicalIndex(rig)
  const pb = posedBones(rig, deltas)
  let z = Infinity
  for (const n of FOOT_JOINT_BONES) {
    const i = ci.get(`${n}.${s}`)
    if (i !== undefined) z = Math.min(z, pb[i].head.z, pb[i].tail.z)
  }
  return z
}

/** With both feet in contact, raise the lower foot to the higher one by two-bone IK on that leg. */
export function plantFeet(rig: RigJson, deltas: Deltas, contacts: { L: boolean; R: boolean }): Deltas {
  if (!(contacts.L && contacts.R)) return { ...deltas }
  const out = resolveDeltas(rig, deltas)
  const zl = footLow(rig, out, 'L')
  const zr = footLow(rig, out, 'R')
  if (!isFinite(zl) || !isFinite(zr) || Math.abs(zl - zr) < 1e-9) return out
  const lo: 'L' | 'R' = zl < zr ? 'L' : 'R'
  const raise = Math.abs(zl - zr)
  const ci = canonicalIndex(rig)
  const th = ci.get(`thigh.${lo}`)
  const sh = ci.get(`shin.${lo}`)
  const ft = ci.get(`foot.${lo}`)
  if (th === undefined || sh === undefined || ft === undefined) return out
  const pb = posedBones(rig, out)
  const a = pb[th].head
  const b = pb[sh].head
  const c = pb[ft].head
  const sol = solveTwoBone(a, b, c, c.clone().add(new Vector3(0, 0, raise)), b.clone().sub(a))
  const rest = (i: number): Vector3 => v3(rig.bones[i].tail).sub(v3(rig.bones[i].head)).normalize()
  out[String(th)] = wxyz(swingTo(q4(out[String(th)]), rest(th), sol.mid.clone().sub(a).normalize()))
  out[String(sh)] = wxyz(swingTo(q4(out[String(sh)]), rest(sh), sol.end.clone().sub(sol.mid).normalize()))
  return out
}
