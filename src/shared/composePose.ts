// SPDX-License-Identifier: GPL-3.0-or-later
// contracts section 13: the one function that turns pose provenance into rig deltas.
// Order: clip frame (retarget) -> mirror -> plant feet -> edits -> grip sockets follow their hands ->
// two-hand weapon IK -> hand poses.
import type { ClipFrame } from './clip'
import type { QuatWXYZ, Vec3 } from './coords'
import type { Deltas } from './fk'
import { canonicalIndex, resolveDeltas } from './fk'
import type { HandPose } from './handPose'
import { applyHandPose } from './handPose'
import { plantFeet, reachArm } from './ik'
import { mul, q4, wxyz } from './math'
import { mirrorPose } from './mirror'
import { retargetFrame } from './retarget'
import type { RigJson } from './rig'
import { mirrorName } from './skeleton'
import type { WeaponEntry } from './weaponPose'
import { followHands, placeWeapon, supportIK } from './weaponPose'

/** An edit, replayable on any rig: bones by canonical name, rotations and targets in Blender armature space. */
export type EditOp =
  | { kind: 'rotate'; bone: string; q: QuatWXYZ; chain: boolean }
  | { kind: 'reach'; side: 'L' | 'R'; target: Vec3 }

export interface PoseInputs {
  mirrored: boolean
  planted: boolean
  edits: EditOp[]
  hands?: { L?: HandPose | null; R?: HandPose | null }
  /** Weapons with `support.enabled` drive the support arm (two-hand IK). */
  weapons?: WeaponEntry[]
}

export interface ComposeResult {
  deltas: Deltas
  /** Edits that could not be applied (bone missing on this rig, no such arm). */
  skipped: EditOp[]
  /** Per side, how far the last reach edit fell short of its target (metres). */
  reachShort: { L?: number; R?: number }
  /** Per weapon id, how far the support hand fell short of its grip point (metres). */
  supportShort: Record<string, number>
  /**
   * Per weapon id, its transform for this pose (armature space, column-major 4x4). Draw and bake the
   * weapon with this: a two-handed weapon in "both" mode depends on where the pose puts both hands.
   */
  weaponMatrices: Record<string, number[]>
}

/** Every descendant of bone i (rig.json indices), any order. */
export function descendants(rig: RigJson, i: number): number[] {
  const kids = new Map<number, number[]>()
  rig.bones.forEach((b, j) => {
    if (b.parent >= 0) kids.set(b.parent, [...(kids.get(b.parent) ?? []), j])
  })
  const out: number[] = []
  const stack = [...(kids.get(i) ?? [])]
  while (stack.length) {
    const j = stack.pop() as number
    out.push(j)
    stack.push(...(kids.get(j) ?? []))
  }
  return out
}

const canonW = (q: QuatWXYZ): QuatWXYZ => (q[0] < 0 ? [-q[0], -q[1], -q[2], -q[3]] : q)

/** The same edit on the other side: rotations S q S = [w, x, -y, -z], targets x -> -x. */
export function mirrorEdit(op: EditOp): EditOp {
  if (op.kind === 'rotate') {
    const [w, x, y, z] = op.q
    return { ...op, bone: mirrorName(op.bone), q: canonW([w, x, -y, -z]) }
  }
  return { kind: 'reach', side: op.side === 'L' ? 'R' : 'L', target: [-op.target[0], op.target[1], op.target[2]] }
}

/** Toggle mirroring: the clip base mirrors and so do the edits, so the whole pose mirrors. */
export function toggleMirror(inputs: PoseInputs): PoseInputs {
  return { ...inputs, mirrored: !inputs.mirrored, edits: inputs.edits.map(mirrorEdit) }
}

/** Apply one edit to resolved deltas. Returns null when it doesn't apply to this rig. */
export function applyEdit(rig: RigJson, deltas: Deltas, op: EditOp): { deltas: Deltas; reachShort?: number } | null {
  if (op.kind === 'rotate') {
    const i = canonicalIndex(rig).get(op.bone)
    if (i === undefined) return null
    const q = q4(op.q)
    const out = { ...deltas }
    for (const j of [i, ...(op.chain ? descendants(rig, i) : [])]) {
      out[String(j)] = canonW(wxyz(mul(q, q4(deltas[String(j)])).normalize()))
    }
    return { deltas: out }
  }
  try {
    const r = reachArm(rig, deltas, op.side, op.target)
    return { deltas: r.deltas, reachShort: r.reachShort }
  } catch {
    return null
  }
}

export function composePose(rig: RigJson, inputs: PoseInputs, frame: ClipFrame | null): ComposeResult {
  let d = resolveDeltas(rig, frame ? retargetFrame(rig, frame) : {})
  if (inputs.mirrored) d = mirrorPose(rig, d, [0, 0, 0]).deltas
  if (inputs.planted && frame) {
    const c = inputs.mirrored ? { L: frame.contacts.R, R: frame.contacts.L } : frame.contacts
    d = resolveDeltas(rig, plantFeet(rig, d, c))
  }
  const skipped: EditOp[] = []
  const reachShort: ComposeResult['reachShort'] = {}
  for (const op of inputs.edits) {
    const r = applyEdit(rig, d, op)
    if (!r) {
      skipped.push(op)
      continue
    }
    d = r.deltas
    if (op.kind === 'reach' && r.reachShort !== undefined) reachShort[op.side] = r.reachShort
  }
  d = followHands(rig, d)
  const supportShort: Record<string, number> = {}
  const weaponMatrices: Record<string, number[]> = {}
  const placed = new Map<string, ReturnType<typeof placeWeapon>>()
  for (const w of inputs.weapons ?? []) {
    const W = placeWeapon(rig, d, w)   // from the pose as it is, before any hand moves onto a weapon
    placed.set(w.id, W)
    if (W) weaponMatrices[w.id] = [...W.elements]
  }
  for (const w of inputs.weapons ?? []) {
    const r = supportIK(rig, d, w, placed.get(w.id))
    if (r) {
      d = r.deltas
      supportShort[w.id] = r.reachShort
    }
  }
  for (const s of ['L', 'R'] as const) {
    const h = inputs.hands?.[s]
    if (h && rig.hands[s]) d = applyHandPose(rig, d, s, h)
  }
  const out: Deltas = {}
  for (const [k, q] of Object.entries(resolveDeltas(rig, d))) out[k] = canonW(wxyz(q4(q)))
  return { deltas: out, skipped, reachShort, supportShort, weaponMatrices }
}
