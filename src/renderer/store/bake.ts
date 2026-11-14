// SPDX-License-Identifier: GPL-3.0-or-later
// bake slice (contracts section 14/18): bake settings. No UI yet.
import type { BakeSettings } from '../../shared/project'
import type { SliceCreator } from './types'

export interface BakeSlice {
  bake: BakeSettings | null
  setBake(bake: BakeSettings | null): void
}

export const createBakeSlice: SliceCreator<BakeSlice> = (set) => ({
  bake: null,
  setBake: (bake) => set({ bake })
})
