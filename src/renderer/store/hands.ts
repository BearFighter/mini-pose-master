// SPDX-License-Identifier: GPL-3.0-or-later
// hands slice (contracts sections 10 and 18): L and R hand poses and locked fingers. Changes go through
// the pose history (commitHistory); the setter here only loads a project's hands.
import type { FingerName } from '../../shared/handPose'
import { NO_HANDS, type HandsState } from '../lib/hands'
import type { SliceCreator } from './types'

export interface FingerGripReport {
  touching: boolean
  maxed: boolean
  minDistance_m: number
  locked: boolean
  reopened: boolean
  startDistance_m: number
  stepTravel_m: number
}

/** The last auto-grip of one hand: per finger, the run time, and the print scale it ran at. */
export interface GripReport {
  fingers: Record<FingerName, FingerGripReport>
  ms: number
  unitMm: number
}

export interface HandsSlice {
  hands: HandsState
  /** The last auto-grip per side (shown under the sliders), with its run time. */
  gripReport: { L?: GripReport; R?: GripReport }
  setHands(hands: HandsState): void
  setGripReport(side: 'L' | 'R', report: GripReport | null): void
}

export const createHandsSlice: SliceCreator<HandsSlice> = (set, get) => ({
  hands: NO_HANDS,
  gripReport: {},
  setHands: (hands) => set({ hands, gripReport: {} }),
  setGripReport: (side, report) => {
    const g = { ...get().gripReport }
    if (report) g[side] = report
    else delete g[side]
    set({ gripReport: g })
  }
})
