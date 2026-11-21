// SPDX-License-Identifier: GPL-3.0-or-later
// bake slice (contracts sections 14 and 18): the bake settings (written through to project.bake) and the
// last bake result.
import type { BakeJobResult } from '../../shared/jobResults'
import type { BakeSettings } from '../../shared/project'
import type { SliceCreator } from './types'

export const DEFAULT_BAKE: BakeSettings = {
  schema: 'mpm.bake/1',
  scale: { mode: 'height_mm', height_mm: 40 },
  detail: 2.0,
  flatten_mm: 0.5,
  base_mm: 0,
  min_wall_mm: 0.6,
  thicken_thin: true,
  weapons_separate: false,
  max_tris: 2_000_000
}

export interface BakeSlice {
  bake: BakeSettings | null
  bakeResult: BakeJobResult | null
  /** Cache-busting version of the preview GLB. */
  bakeVersion: number
  /** Export step: show the baked preview (else the posed rig). */
  showBaked: boolean
  setBake(bake: BakeSettings | null): void
  /** Changes the settings and project.bake (marks the project dirty). */
  updateBake(patch: Partial<BakeSettings>): void
  setBakeResult(result: BakeJobResult | null): void
  setShowBaked(on: boolean): void
}

export const createBakeSlice: SliceCreator<BakeSlice> = (set, get) => ({
  bake: null,
  bakeResult: null,
  bakeVersion: 0,
  showBaked: false,
  setBake: (bake) => set({ bake }),
  updateBake: (patch) => {
    const bake = { ...(get().bake ?? DEFAULT_BAKE), ...patch }
    const data = get().data
    set(data ? { bake, data: { ...data, bake }, dirty: true } : { bake })
  },
  setBakeResult: (bakeResult) => set({ bakeResult, bakeVersion: Date.now(), showBaked: bakeResult !== null }),
  setShowBaked: (showBaked) => set({ showBaked })
})
