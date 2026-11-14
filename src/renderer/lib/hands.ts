// SPDX-License-Identifier: GPL-3.0-or-later
// Hand poses for the Hands step (contracts section 10): presets (resources/hand_presets.json, bundled
// at build time), finger edits, copy between hands, and the project's `hands` state.
import presetsFile from '../../../resources/hand_presets.json'
import type { FingerName, FingerPose, HandPose } from '../../shared/handPose'
import { FINGERS } from '../../shared/handPose'

export interface HandPreset extends HandPose {
  label: string
  /** Fingers auto-grip leaves alone (e.g. the trigger finger). */
  lock: FingerName[]
}

export const HAND_PRESETS: HandPreset[] = (presetsFile as unknown as { presets: HandPreset[] }).presets

/** `hands` of the project file (contracts section 15) and the hands slice. */
export interface HandsState {
  L: HandPose | null
  R: HandPose | null
  locked: { L: string[]; R: string[] }
}

export const NO_HANDS: HandsState = { L: null, R: null, locked: { L: [], R: [] } }

function cloneFinger(f: FingerPose): FingerPose {
  const out: FingerPose = { flex: [f.flex[0] ?? 0, f.flex[1] ?? 0, f.flex[2] ?? 0] }
  if (f.spread !== undefined) out.spread = f.spread
  if (f.roll !== undefined) out.roll = f.roll
  return out
}

export function cloneHand(h: HandPose): HandPose {
  const fingers = {} as Record<FingerName, FingerPose>
  for (const f of FINGERS) fingers[f] = cloneFinger(h.fingers[f] ?? { flex: [0, 0, 0] })
  return { schema: 'mpm.hand/1', name: h.name, fingers }
}

export function presetByName(name: string): HandPreset | undefined {
  return HAND_PRESETS.find((p) => p.name === name)
}

/** A preset as a hand pose (without its label and lock). */
export function handFromPreset(p: HandPreset): HandPose {
  return cloneHand(p)
}

/** One finger changed; the pose is named "custom" once it no longer is the preset. */
export function withFinger(h: HandPose, finger: FingerName, patch: Partial<FingerPose>): HandPose {
  const out = cloneHand(h)
  out.fingers[finger] = { ...out.fingers[finger], ...patch, flex: (patch.flex ?? out.fingers[finger].flex).slice(0, 3) as [number, number, number] }
  out.name = 'custom'
  return out
}

export function normaliseHands(raw: unknown): HandsState {
  const h = (raw ?? {}) as Partial<HandsState>
  return {
    L: h.L ? cloneHand(h.L) : null,
    R: h.R ? cloneHand(h.R) : null,
    locked: { L: [...(h.locked?.L ?? [])], R: [...(h.locked?.R ?? [])] }
  }
}

/** "Copy hand L→R" (from 'L') / "R→L": spread and roll mean the same on both hands, so values copy as they are. */
export function copyHand(hands: HandsState, from: 'L' | 'R'): HandsState {
  const to = from === 'L' ? 'R' : 'L'
  const src = hands[from]
  return { ...hands, [to]: src ? cloneHand(src) : null, locked: { ...hands.locked, [to]: [...hands.locked[from]] } }
}

export function setLocked(hands: HandsState, side: 'L' | 'R', finger: FingerName, on: boolean): HandsState {
  const cur = hands.locked[side].filter((f) => f !== finger)
  return { ...hands, locked: { ...hands.locked, [side]: on ? [...cur, finger] : cur } }
}

/** Slider ranges (degrees). */
export const FLEX_RANGE: [number, number] = [-20, 110]
export const SPREAD_RANGE: [number, number] = [-30, 40]
export const ROLL_RANGE: [number, number] = [-30, 90]
