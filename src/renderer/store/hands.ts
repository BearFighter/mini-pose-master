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
}

export interface HandsSlice {
  hands: HandsState
  /** The last auto-grip per side (shown under the sliders), with its run time. */
  gripReport: { L?: { fingers: Record<FingerName, FingerGripReport>; ms: number }; R?: { fingers: Record<FingerName, FingerGripReport>; ms: number } }
  setHands(hands: HandsState): void
  setGripReport(side: 'L' | 'R', report: { fingers: Record<FingerName, FingerGripReport>; ms: number } | null): void
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
