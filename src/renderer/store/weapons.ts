// SPDX-License-Identifier: GPL-3.0-or-later
// weapons slice (contracts section 12/18): weapon entries plus loaded geometry handles. No UI yet.
import type { WeaponEntry } from '../../shared/project'
import type { SliceCreator } from './types'

export interface WeaponsSlice {
  weapons: WeaponEntry[]
  /** Loaded geometry per weapon id (owned by the viewer). */
  weaponHandles: Record<string, unknown>
  setWeapons(weapons: WeaponEntry[]): void
  setWeaponHandle(id: string, handle: unknown): void
}

export const createWeaponsSlice: SliceCreator<WeaponsSlice> = (set, get) => ({
  weapons: [],
  weaponHandles: {},
  setWeapons: (weapons) => set({ weapons }),
  setWeaponHandle: (id, handle) => set({ weaponHandles: { ...get().weaponHandles, [id]: handle } })
})
