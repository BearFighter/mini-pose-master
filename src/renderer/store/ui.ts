// SPDX-License-Identifier: GPL-3.0-or-later
// ui slice: the current step, the selection, camera focus requests, dialogs.
import type { SliceCreator } from './types'

export const STEPS = ['import', 'rig', 'pose', 'hands', 'weapons', 'export'] as const
export type Step = (typeof STEPS)[number]

export const STEP_LABELS: Record<Step, string> = {
  import: 'Import',
  rig: 'Rig',
  pose: 'Pose',
  hands: 'Hands',
  weapons: 'Weapons',
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

export interface UiSlice {
  step: Step
  /** Selected marker name. */
  selection: string | null
  focus: FocusRequest | null
  showBlenderSetup: boolean
  logOpen: boolean
  setStep(step: Step): void
  select(name: string | null): void
  requestFocus(center: [number, number, number], radius: number, keepDirection?: boolean): void
  setShowBlenderSetup(show: boolean): void
  setLogOpen(open: boolean): void
}

export const createUiSlice: SliceCreator<UiSlice> = (set, get) => ({
  step: 'import',
  selection: null,
  focus: null,
  showBlenderSetup: false,
  logOpen: false,
  setStep: (step) => set({ step }),
  select: (selection) => set({ selection }),
  requestFocus: (center, radius, keepDirection = true) =>
    set({ focus: { center, radius, keepDirection, seq: (get().focus?.seq ?? 0) + 1 } }),
  setShowBlenderSetup: (showBlenderSetup) => set({ showBlenderSetup }),
  setLogOpen: (logOpen) => set({ logOpen })
})
