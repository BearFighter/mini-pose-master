// SPDX-License-Identifier: GPL-3.0-or-later
// contracts section 12: weapon placement on the posed grip socket and two-hand (support) IK.
// Everything is in Blender armature space, metres, like the bake (engine/mpm/bake.py attach_frame).
import { Matrix4, Quaternion, Vector3 } from 'three'
import type { QuatWXYZ, Vec3 } from './coords'
import type { Deltas } from './fk'
import { canonicalIndex, posedBones, resolveDeltas } from './fk'
import { reachArm } from './ik'
import { arr, frame, inv, mul, q4, v3, wxyz } from './math'
import type { RigJson } from './rig'

export interface WeaponOffset {
  t: Vec3
  q: QuatWXYZ
  s: number
}

export interface WeaponSupport {
  enabled: boolean
  side: 'L' | 'R'
  /** Weapon-local: where the support hand's grip socket goes, which way its palm faces, the grip axis. */
  point: Vec3
  normal: Vec3
  axis: Vec3
}

export interface WeaponEntry {
  id: string
  file: string
  attach_bone: string
  offset: WeaponOffset
  support?: WeaponSupport
  merge?: boolean
}

const canonW = (q: QuatWXYZ): QuatWXYZ => (q[0] < 0 ? [-q[0], -q[1], -q[2], -q[3]] : q)

/** A = Translation(posed head) * (D_b * R(rest_q_b)) of a canonical bone; equals Blender's pose_bone.matrix. */
export function attachFrame(rig: RigJson, deltas: Deltas, canonical: string): Matrix4 | null {
  const i = canonicalIndex(rig).get(canonical)
  if (i === undefined) return null
  const pb = posedBones(rig, deltas)[i]
  const R = mul(pb.D, q4(rig.bones[i].rest_q))
  return new Matrix4().compose(pb.head.clone(), R, new Vector3(1, 1, 1))
}

/** TRS(offset): translation t, rotation q, uniform scale s, in the attach bone's posed frame. */
export function offsetMatrix(off: WeaponOffset): Matrix4 {
  return new Matrix4().compose(v3(off.t), q4(off.q), new Vector3(off.s, off.s, off.s))
}

/** The weapon's transform in armature space: A * TRS(offset). Null when the rig has no such socket. */
export function weaponMatrix(rig: RigJson, deltas: Deltas, w: Pick<WeaponEntry, 'attach_bone' | 'offset'>): Matrix4 | null {
  const A = attachFrame(rig, deltas, w.attach_bone)
  return A ? A.multiply(offsetMatrix(w.offset)) : null
}

/** Every descendant of bone i. */
function descendants(rig: RigJson, i: number): number[] {
  const out: number[] = []
  const stack = [i]
  while (stack.length) {
    const p = stack.pop() as number
    rig.bones.forEach((b, j) => {
      if (b.parent === p) {
        out.push(j)
        stack.push(j)
      }
    })
  }
  return out
}

/** The grip sockets are rigid attachments: their delta is always their hand's. */
export function followHands(rig: RigJson, deltas: Deltas): Deltas {
  const out = resolveDeltas(rig, deltas)
  const ci = canonicalIndex(rig)
  for (const s of ['L', 'R'] as const) {
    const h = ci.get(`hand.${s}`)
    const g = ci.get(`grip.${s}`)
    if (h !== undefined && g !== undefined) out[String(g)] = out[String(h)]
  }
  return out
}

export interface SupportResult {
  deltas: Deltas
  reachShort: number
}

/**
 * Two-hand IK (section 12): the support hand's grip socket goes to W * point, its palm faces W * normal and
 * its grip axis lies along W * axis. Arm by two-bone IK (shoulder fixed, no stretching); the hand's own
 * children (fingers, socket) turn with the hand. Null when it does not apply to this rig.
 */
export function supportIK(rig: RigJson, deltas: Deltas, w: WeaponEntry): SupportResult | null {
  const sup = w.support
  if (!sup?.enabled) return null
  const s = sup.side
  const hf = rig.hands[s]
  const ci = canonicalIndex(rig)
  const hd = ci.get(`hand.${s}`)
  const gp = ci.get(`grip.${s}`)
  const W = weaponMatrix(rig, deltas, w)
  if (!hf || hd === undefined || gp === undefined || !W) return null
  const pos = new Vector3()
  const rot = new Quaternion()
  W.decompose(pos, rot, new Vector3())
  const target = v3(sup.point).applyMatrix4(W)
  const axis = v3(sup.axis).applyQuaternion(rot).normalize()
  const normal = v3(sup.normal).applyQuaternion(rot).normalize()
  // The hand delta reachArm will set (same formula), to find where the wrist must go.
  const ga = v3(hf.grip_axis ?? hf.lateral)
  const pn = v3(hf.palm_normal)
  const Dh = mul(frame(axis, normal), inv(frame(ga, pn)))
  const socket = v3(rig.bones[gp].head).sub(v3(rig.bones[hd].head)).applyQuaternion(Dh)
  const wrist = target.clone().sub(socket)
  const before = resolveDeltas(rig, deltas)
  const r = reachArm(rig, before, s, arr(wrist), { axis: arr(axis), normal: arr(normal) })
  const change = mul(q4(r.deltas[String(hd)]), inv(q4(before[String(hd)])))
  for (const j of descendants(rig, hd)) r.deltas[String(j)] = canonW(wxyz(mul(change, q4(before[String(j)])).normalize()))
  return { deltas: r.deltas, reachShort: r.reachShort }
}
