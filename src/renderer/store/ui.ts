// SPDX-License-Identifier: GPL-3.0-or-later
// ui slice: the current step, the selection, camera focus requests, dialogs.
import type { SliceCreator } from './types'

/** Weapons and hands come before posing: the hand shape is known once a weapon is in it. */
export const STEPS = ['import', 'rig', 'weapons', 'hands', 'pose', 'export'] as const
export type Step = (typeof STEPS)[number]

export const STEP_LABELS: Record<Step, string> = {
  import: 'Import',
  rig: 'Rig',
  weapons: 'Weapons',
  hands: 'Hands',
  pose: 'Pose',
  export: 'Export'
}

/** A request for the viewer camera: look at `center` (three.js frame) so a sphere of `radius` fits. */
export interface FocusRequest {
  center: [number, number, number]
  radius: number
  /** Keep the current viewing direction (else the default front-right view). */
  keepDirection: boolean
  seq: number
}

/** What the Pose step's gizmo does: rotate the selected bone, or move the hand (reach). */
export type PoseTool = 'rotate' | 'reach'

export interface UiSlice {
  step: Step
  /** Selected marker name (Rig step). */
  selection: string | null
  /** Selected bone, canonical name (Pose step). */
  boneSelection: string | null
  poseTool: PoseTool
  /** "Rotate bone only": edits with chain = false. */
  boneOnly: boolean
  focus: FocusRequest | null
  showBlenderSetup: boolean
  logOpen: boolean
  /** Bumped to ask the viewer to frame the posed rig (a new clip was picked). */
  frameSeq: number
  requestFrame(): void
  setStep(step: Step): void
  select(name: string | null): void
  selectBone(name: string | null): void
  setPoseTool(tool: PoseTool): void
  setBoneOnly(on: boolean): void
  requestFocus(center: [number, number, number], radius: number, keepDirection?: boolean): void
  setShowBlenderSetup(show: boolean): void
  setLogOpen(open: boolean): void
}

export const createUiSlice: SliceCreator<UiSlice> = (set, get) => ({
  step: 'import',
  selection: null,
  boneSelection: null,
  poseTool: 'rotate',
  boneOnly: false,
  focus: null,
  showBlenderSetup: false,
  logOpen: false,
  frameSeq: 0,
  requestFrame: () => set({ frameSeq: get().frameSeq + 1 }),
  setStep: (step) => set({ step }),
  select: (selection) => set({ selection }),
  selectBone: (boneSelection) =>
    set({ boneSelection, gestureBone: null, ...(boneSelection && /^hand\.[LR]$/.test(boneSelection) ? {} : { poseTool: 'rotate' as PoseTool }) }),
  setPoseTool: (poseTool) => set({ poseTool }),
  setBoneOnly: (boneOnly) => set({ boneOnly }),
  requestFocus: (center, radius, keepDirection = true) =>
    set({ focus: { center, radius, keepDirection, seq: (get().focus?.seq ?? 0) + 1 } }),
  setShowBlenderSetup: (showBlenderSetup) => set({ showBlenderSetup }),
  setLogOpen: (logOpen) => set({ logOpen })
})
