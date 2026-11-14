// SPDX-License-Identifier: GPL-3.0-or-later
// Hands step flows (contracts sections 10-11): presets, finger sliders (live preview, one undo step on
// release), keep (locked), copy / reset, and auto-grip against the weapons held by that hand.
import type { FingerName, HandPose } from '../../shared/handPose'
import type { WeaponEntry } from '../../shared/project'
import { weaponMatrix } from '../../shared/weaponPose'
import { cleanError } from '../api'
import { autoGrip, buildBVH, type AutoGripResult } from '../lib/autoGrip'
import { copyHand, handFromPreset, presetByName, setLocked, type HandsState } from '../lib/hands'
import { projectUrl } from '../lib/paths'
import { computePose } from '../lib/pose'
import { gripTolerance, weaponTriangles } from '../lib/weapons'
import { loadWeaponScene } from '../viewer/weaponView'
import { fail, S } from './flow'
import { syncPoseToProject } from './poseActions'

function commitHands(hands: HandsState): void {
  S().commitHistory({ hands })
  syncPoseToProject(true)
}

/** A preset: its finger angles and its keep (lock) list. */
export function choosePreset(side: 'L' | 'R', name: string): void {
  const p = presetByName(name)
  if (!p) return
  const { hands } = S()
  commitHands({ ...hands, [side]: handFromPreset(p), locked: { ...hands.locked, [side]: [...p.lock] } })
  S().setGripReport(side, null)
}

/** A slider is being dragged: preview the hand without committing. */
export function previewHand(side: 'L' | 'R', pose: HandPose): void {
  const { hands } = S()
  S().setPosePreview({ hands: { L: side === 'L' ? pose : hands.L, R: side === 'R' ? pose : hands.R } })
}

/** Slider released: one undo step. */
export function commitHand(side: 'L' | 'R', pose: HandPose): void {
  commitHands({ ...S().hands, [side]: pose })
}

export function setFingerKeep(side: 'L' | 'R', finger: FingerName, keep: boolean): void {
  commitHands(setLocked(S().hands, side, finger, keep))
}

export function copyHandSide(from: 'L' | 'R'): void {
  commitHands(copyHand(S().hands, from))
}

export function resetHand(side: 'L' | 'R'): void {
  const { hands } = S()
  commitHands({ ...hands, [side]: null, locked: { ...hands.locked, [side]: [] } })
  S().setGripReport(side, null)
}

/** Weapons held by a hand: attached to its socket, or gripped by it as the support hand. */
export function weaponsForHand(weapons: WeaponEntry[], side: 'L' | 'R'): WeaponEntry[] {
  return weapons.filter((w) => w.attach_bone === `grip.${side}` || (w.support?.enabled && w.support.side === side))
}

/**
 * Auto-grip one hand (contracts section 11): starts from the hand's current pose (a preset), closes the
 * unlocked fingers onto the weapons that hand holds, commits the result as one undo step.
 */
export async function runAutoGrip(side: 'L' | 'R'): Promise<AutoGripResult> {
  const s = S()
  const rig = s.rigJson
  if (!rig) return fail(new Error('Build the rig first'))
  if (!rig.hands[side]) return fail(new Error(`This rig has no finger bones on the ${side === 'L' ? 'left' : 'right'} hand`))
  const held = weaponsForHand(s.weapons, side)
  if (held.length === 0) return fail(new Error('Attach a weapon to this hand first (Weapons step)'))
  // contracts section 13: hand poses come last, so the weapon and the arm don't depend on this hand's fingers
  const base = computePose(rig, s.poseInputs, null, s.loadedClip, s.hands, s.weapons, side).deltas
  const parts: Float32Array[] = []
  try {
    for (const w of held) {
      const Mb = weaponMatrix(rig, base, w)
      if (!Mb) continue
      const scene = await loadWeaponScene(w.id, projectUrl(w.file, s.weaponVersion[w.id]))
      parts.push(weaponTriangles(scene, Mb))
    }
  } catch (e) {
    return fail(new Error(`The weapon could not be loaded: ${cleanError(e)}`))
  }
  const all = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    all.set(p, o)
    o += p.length
  }
  if (all.length === 0) return fail(new Error('The weapon has no triangles'))
  const start = s.hands[side] ?? handFromPreset(presetByName('grip')!)
  const t0 = performance.now() // timed with the BVH build
  const result = autoGrip({
    rig,
    base,
    side,
    start,
    locked: s.hands.locked[side],
    bvh: buildBVH(all),
    tolM: gripTolerance(rig, s.bake)
  })
  const ms = performance.now() - t0
  commitHand(side, result.pose)
  S().setGripReport(side, { fingers: result.fingers, ms })
  return result
}
