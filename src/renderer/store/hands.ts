// SPDX-License-Identifier: GPL-3.0-or-later
// hands slice (contracts section 10/18): L and R hand poses and locked fingers. No UI yet.
import type { HandPose } from '../../shared/handPose'
import type { SliceCreator } from './types'

export interface HandsSlice {
  hands: { L: HandPose | null; R: HandPose | null; locked: { L: string[]; R: string[] } }
  setHandPose(side: 'L' | 'R', pose: HandPose | null): void
  setLockedFingers(side: 'L' | 'R', fingers: string[]): void
}

export const createHandsSlice: SliceCreator<HandsSlice> = (set, get) => ({
  hands: { L: null, R: null, locked: { L: [], R: [] } },
  setHandPose: (side, pose) => set({ hands: { ...get().hands, [side]: pose } }),
  setLockedFingers: (side, fingers) => set({ hands: { ...get().hands, locked: { ...get().hands.locked, [side]: fingers } } })
})
