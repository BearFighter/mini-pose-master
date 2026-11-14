// SPDX-License-Identifier: GPL-3.0-or-later
// Forward kinematics on rig.json in Blender space (contracts section 5), plus canonical lookups.
import { Quaternion, Vector3 } from 'three'
import type { QuatWXYZ, Vec3 } from './coords'
import { q4, rotate, v3, wxyz } from './math'
import type { RigJson } from './rig'
import { BONES } from './skeleton'

export type Deltas = Record<string, QuatWXYZ>

export function topoOrder(rig: RigJson): number[] {
  const out: number[] = []
  const seen = new Set<number>()
  const visit = (i: number): void => {
    if (seen.has(i)) return
    const p = rig.bones[i].parent
    if (p >= 0) visit(p)
    seen.add(i)
    out.push(i)
  }
  rig.bones.forEach((_b, i) => visit(i))
  return out
}

/** canonical bone name -> rig bone index */
export function canonicalIndex(rig: RigJson): Map<string, number> {
  const m = new Map<string, number>()
  rig.bones.forEach((b, i) => {
    if (b.canonical && !m.has(b.canonical)) m.set(b.canonical, i)
  })
  return m
}

/** Every bone gets a delta: missing ones inherit their parent's (contracts section 13). */
export function resolveDeltas(rig: RigJson, deltas: Deltas): Deltas {
  const out: Deltas = {}
  for (const i of topoOrder(rig)) {
    const p = rig.bones[i].parent
    out[String(i)] = deltas[String(i)] ?? (p >= 0 ? out[String(p)] : [1, 0, 0, 0])
  }
  return out
}

export interface PosedBone {
  D: Quaternion
  head: Vector3
  tail: Vector3
}

/** Posed heads/tails of every bone (Blender space, metres). */
export function posedBones(rig: RigJson, deltas: Deltas, rootOffset: Vec3 = [0, 0, 0]): PosedBone[] {
  const res = resolveDeltas(rig, deltas)
  const hips = canonicalIndex(rig).get('hips')
  const out: PosedBone[] = new Array(rig.bones.length)
  for (const i of topoOrder(rig)) {
    const b = rig.bones[i]
    const D = q4(res[String(i)])
    let head: Vector3
    if (b.parent >= 0) {
      const p = out[b.parent]
      head = p.head.clone().add(rotate(p.D, v3(b.head).sub(v3(rig.bones[b.parent].head))))
    } else {
      head = v3(b.head)
    }
    if (i === hips) head.add(v3(rootOffset))
    const tail = head.clone().add(rotate(D, v3(b.tail).sub(v3(b.head))))
    out[i] = { D, head, tail }
  }
  return out
}

const HEADS = new Set(BONES.map((b) => b.head))

/** Posed canonical joints: canonical bone heads, plus tails for end joints (head_top, tips, toe). */
export function posedJoints(rig: RigJson, deltas: Deltas, rootOffset: Vec3 = [0, 0, 0]): Record<string, Vector3> {
  const pb = posedBones(rig, deltas, rootOffset)
  const ci = canonicalIndex(rig)
  const J: Record<string, Vector3> = {}
  for (const b of BONES) {
    const i = ci.get(b.name)
    if (i === undefined) continue
    J[b.head] = pb[i].head
    if (!HEADS.has(b.tail)) J[b.tail] = pb[i].tail
  }
  return J
}

/** Rest canonical joints from rig.json. */
export function restJoints(rig: RigJson): Record<string, Vector3> {
  const J: Record<string, Vector3> = {}
  for (const [k, v] of Object.entries(rig.joints)) J[k] = v3(v)
  return J
}

export const identityDeltas = (): Deltas => ({})
export { wxyz }
