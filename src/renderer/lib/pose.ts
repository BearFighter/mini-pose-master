// SPDX-License-Identifier: GPL-3.0-or-later
// Pose step logic on top of composePose (contracts section 13): the stored inputs, live previews,
// memoised composition, provenance round trip, the edit merge rule, copy L->R / R->L, gizmo deltas.
import { Quaternion, Vector3 } from 'three'
import type { ClipFrame } from '../../shared/clip'
import type { ComposeResult, EditOp, PoseInputs } from '../../shared/composePose'
import { composePose } from '../../shared/composePose'
import type { QuatWXYZ } from '../../shared/coords'
import { quatB2T, quatT2B, vecB2T } from '../../shared/coords'
import type { Deltas } from '../../shared/fk'
import { canonicalIndex, posedBones, topoOrder } from '../../shared/fk'
import type { HandPose } from '../../shared/handPose'
import { inv, mul, q4, wxyz } from '../../shared/math'
import type { PoseProvenance, PoseState } from '../../shared/poseState'
import type { WeaponEntry } from '../../shared/project'
import { makePoseState } from '../../shared/poseState'
import type { RigJson } from '../../shared/rig'
import { mirrorName } from '../../shared/skeleton'

/** The clip frame a pose starts from. */
export interface PoseSource {
  pack: string
  clip: string
  frame: number
}

/** What the pose slice stores (and undo/redo snapshots); the deltas are derived from it. */
export interface PoseInputsState {
  source: PoseSource | null
  mirrored: boolean
  planted: boolean
  edits: EditOp[]
}

/**
 * A live preview on top of the committed state: a scrubbed frame, a bone gizmo drag in progress, a finger
 * slider being dragged (hands) or a weapon being moved (weapons).
 */
export interface PosePreview {
  frame?: number
  op?: EditOp
  hands?: HandsLike
  weapons?: WeaponEntry[]
}

export const REST_INPUTS: PoseInputsState = { source: null, mirrored: false, planted: true, edits: [] }

export function effectiveInputs(inputs: PoseInputsState, preview: PosePreview | null): PoseInputsState {
  if (!preview) return inputs
  return {
    ...inputs,
    source: inputs.source && preview.frame !== undefined ? { ...inputs.source, frame: preview.frame } : inputs.source,
    edits: preview.op ? [...inputs.edits, preview.op] : inputs.edits
  }
}

/** A loaded clip's frames, as the pose code needs them. */
export interface LoadedClipLike {
  packId: string
  clipId: string
  frames: number
  frame(i: number): ClipFrame
}

/** The clip frame of `inputs.source` when that clip is loaded (frame clamped), else null. */
export function sourceFrame(inputs: PoseInputsState, clip: LoadedClipLike | null): ClipFrame | null {
  const src = inputs.source
  if (!src || !clip || clip.packId !== src.pack || clip.clipId !== src.clip || clip.frames <= 0) return null
  return clip.frame(Math.min(clip.frames - 1, Math.max(0, Math.round(src.frame))))
}

/** True when the source clip is wanted but not loaded (the pose then shows rest + edits). */
export function clipMissing(inputs: PoseInputsState, clip: LoadedClipLike | null): boolean {
  return inputs.source !== null && sourceFrame(inputs, clip) === null
}

export interface HandsLike {
  L: HandPose | null
  R: HandPose | null
}

let memo: {
  rig: RigJson
  inputs: PoseInputsState
  preview: PosePreview | null
  clip: LoadedClipLike | null
  hands: HandsLike | null
  weapons: WeaponEntry[] | null
  skipHand: 'L' | 'R' | null
  result: ComposeResult
} | null = null

/**
 * composePose for the current state (pose inputs, hands, weapons, plus any preview), memoised on its
 * arguments by identity, so the viewer, the panels and the save share one computation per change.
 * `skipHand` leaves out one side's hand pose (auto-grip starts from the pose without it).
 */
export function computePose(
  rig: RigJson,
  inputs: PoseInputsState,
  preview: PosePreview | null,
  clip: LoadedClipLike | null,
  hands: HandsLike | null,
  weapons: WeaponEntry[] | null = null,
  skipHand: 'L' | 'R' | null = null
): ComposeResult {
  if (
    memo &&
    memo.rig === rig &&
    memo.inputs === inputs &&
    memo.preview === preview &&
    memo.clip === clip &&
    memo.hands === hands &&
    memo.weapons === weapons &&
    memo.skipHand === skipHand
  ) {
    return memo.result
  }
  const eff = effectiveInputs(inputs, preview)
  const h = preview?.hands ?? hands
  const w = preview?.weapons ?? weapons
  const composeInputs: PoseInputs = {
    mirrored: eff.mirrored,
    planted: eff.planted,
    edits: eff.edits,
    hands: h ? { L: skipHand === 'L' ? null : h.L, R: skipHand === 'R' ? null : h.R } : undefined,
    weapons: w ?? undefined
  }
  const result = composePose(rig, composeInputs, sourceFrame(eff, clip))
  memo = { rig, inputs, preview, clip, hands, weapons, skipHand, result }
  return result
}

// ---------------------------------------------------------------------------------------------------
// Provenance (project.pose) <-> inputs

export function provenanceFromInputs(inputs: PoseInputsState): PoseProvenance {
  return {
    pack: inputs.source?.pack ?? null,
    clip: inputs.source?.clip ?? null,
    frame: inputs.source?.frame ?? null,
    mirrored: inputs.mirrored,
    planted: inputs.planted,
    edits: inputs.edits.map((op) => ({ ...op }))
  }
}

export function inputsFromProvenance(p: PoseProvenance | null | undefined): PoseInputsState {
  if (!p) return REST_INPUTS
  const source = p.pack && p.clip && typeof p.frame === 'number' ? { pack: p.pack, clip: p.clip, frame: p.frame } : null
  return {
    source,
    mirrored: !!p.mirrored,
    planted: p.planted !== false,
    edits: Array.isArray(p.edits) ? p.edits.filter(isEditOp).map((op) => ({ ...op })) : []
  }
}

function isEditOp(op: unknown): op is EditOp {
  const o = op as Record<string, unknown> | null
  if (!o) return false
  if (o.kind === 'rotate') return typeof o.bone === 'string' && Array.isArray(o.q) && o.q.length === 4 && typeof o.chain === 'boolean'
  if (o.kind === 'reach') return (o.side === 'L' || o.side === 'R') && Array.isArray(o.target) && o.target.length === 3
  return false
}

/** project.pose for the inputs: every bone resolved, root offset 0 (contracts section 13). */
export function poseStateFor(rig: RigJson, deltas: Deltas, inputs: PoseInputsState): PoseState {
  return makePoseState(rig, deltas, [0, 0, 0], provenanceFromInputs(inputs))
}

// ---------------------------------------------------------------------------------------------------
// Edits

const canonW = (q: QuatWXYZ): QuatWXYZ => (q[0] < 0 ? [-q[0], -q[1], -q[2], -q[3]] : q)

/**
 * Appends a rotate edit. When `merge` is true and the last edit is a rotate of the same bone and
 * mode, the two become one: applying q1 then q2 about the same head is q2 * q1.
 */
export function appendRotate(edits: EditOp[], op: Extract<EditOp, { kind: 'rotate' }>, merge: boolean): EditOp[] {
  const last = edits[edits.length - 1]
  if (merge && last && last.kind === 'rotate' && last.bone === op.bone && last.chain === op.chain) {
    const q = canonW(wxyz(mul(q4(op.q), q4(last.q)).normalize()))
    return [...edits.slice(0, -1), { ...last, q }]
  }
  return [...edits, op]
}

/** Appends a reach edit, replacing a directly preceding reach of the same side. */
export function appendReach(edits: EditOp[], op: Extract<EditOp, { kind: 'reach' }>): EditOp[] {
  const last = edits[edits.length - 1]
  if (last && last.kind === 'reach' && last.side === op.side) return [...edits.slice(0, -1), op]
  return [...edits, op]
}

/** "Reset bone": drops the bone's rotate edits, and the side's reach edits for a hand. */
export function removeBoneEdits(edits: EditOp[], bone: string): EditOp[] {
  const hand = /^hand\.([LR])$/.exec(bone)
  return edits.filter((op) => {
    if (op.kind === 'rotate') return op.bone !== bone
    return !(hand && op.side === hand[1])
  })
}

/**
 * "Copy pose L->R" (from = 'L') or "R->L": for each canonical bone of the source side, a rotate op
 * (chain: false) on its mirror partner so its delta becomes the mirrored source delta:
 * q = D_wanted * D_now^-1 with D_wanted = S D_source S ([w, x, -y, -z]). Parents first.
 */
export function copySideOps(rig: RigJson, deltas: Deltas, from: 'L' | 'R'): EditOp[] {
  const ci = canonicalIndex(rig)
  const ops: EditOp[] = []
  const suffix = `.${from}`
  for (const i of topoOrder(rig)) {
    const name = rig.bones[i].canonical
    if (!name || !name.endsWith(suffix)) continue
    const target = ci.get(mirrorName(name))
    if (target === undefined) continue
    const [w, x, y, z] = deltas[String(i)] ?? [1, 0, 0, 0]
    const wanted = q4([w, x, -y, -z])
    const now = q4(deltas[String(target)] ?? [1, 0, 0, 0])
    const q = canonW(wxyz(mul(wanted, inv(now)).normalize()))
    if (Math.abs(q[0]) > 1 - 1e-12) continue // already equal
    ops.push({ kind: 'rotate', bone: mirrorName(name), q, chain: false })
  }
  return ops
}

/**
 * The armature-space (Blender) rotation of a gizmo drag: the helper's orientation went from
 * `start` to `now` (three.js, relative to the armature node), so q_three = now * start^-1.
 */
export function gizmoDelta(start: Quaternion, now: Quaternion): QuatWXYZ {
  const qThree = now.clone().multiply(start.clone().invert()).normalize()
  return quatT2B(qThree)
}

/**
 * Where the rotation gizmo's helper goes (three.js frame, relative to the armature node): at bone
 * i's posed head, oriented D_b * R_rest_b.
 */
export function helperPose(rig: RigJson, deltas: Deltas, i: number): { position: Vector3; quaternion: Quaternion } {
  const head = posedBones(rig, deltas)[i].head
  const D = q4(deltas[String(i)] ?? [1, 0, 0, 0])
  return {
    position: vecB2T([head.x, head.y, head.z]),
    quaternion: quatB2T(wxyz(mul(D, q4(rig.bones[i].rest_q))))
  }
}

/** Canonical bones of a rig in hierarchy order with their depth (for the bone tree). */
export function canonicalTree(rig: RigJson): { name: string; index: number; depth: number }[] {
  const depthOf = new Map<number, number>()
  const out: { name: string; index: number; depth: number }[] = []
  for (const i of topoOrder(rig)) {
    const b = rig.bones[i]
    // depth counts canonical ancestors only, so unmapped helper bones don't indent the tree
    let p = b.parent
    let depth = 0
    while (p >= 0) {
      if (rig.bones[p].canonical) {
        depth = (depthOf.get(p) ?? 0) + 1
        break
      }
      p = rig.bones[p].parent
    }
    depthOf.set(i, depth)
    if (b.canonical && !b.canonical.startsWith('grip.')) out.push({ name: b.canonical, index: i, depth })
  }
  return out
}

/** The canonical bone for rig bone i: itself, or its nearest canonical ancestor. */
export function canonicalFor(rig: RigJson, i: number): string | null {
  let j = i
  while (j >= 0) {
    const c = rig.bones[j].canonical
    if (c && !c.startsWith('grip.')) return c
    j = rig.bones[j].parent
  }
  return null
}
