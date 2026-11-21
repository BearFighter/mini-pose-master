// SPDX-License-Identifier: GPL-3.0-or-later
// weapons slice (contracts sections 12 and 18): weapon entries (changed through the pose history),
// what the convert job reported per weapon, the selection and the Weapons step's tool.
import type { ConvertWeaponResult } from '../../shared/jobResults'
import type { WeaponEntry } from '../../shared/project'
import type { SliceCreator } from './types'

/** What the Weapons step's click / gizmo does. */
export type WeaponTool = 'move' | 'rotate' | 'grip' | 'support'

export interface WeaponsSlice {
  weapons: WeaponEntry[]
  /** The convert job's result per weapon id (axis, size, warnings); not saved. */
  weaponInfo: Record<string, ConvertWeaponResult>
  /** Cache-busting version per weapon id, bumped when its GLB is converted again. */
  weaponVersion: Record<string, number>
  weaponSelection: string | null
  weaponTool: WeaponTool
  /** Loads a project's weapons: the convert results and versions of the last project are dropped. */
  setWeapons(weapons: WeaponEntry[]): void
  setWeaponInfo(id: string, info: ConvertWeaponResult | null): void
  bumpWeaponVersion(id: string): void
  selectWeapon(id: string | null): void
  setWeaponTool(tool: WeaponTool): void
}

export const createWeaponsSlice: SliceCreator<WeaponsSlice> = (set, get) => ({
  weapons: [],
  weaponInfo: {},
  weaponVersion: {},
  weaponSelection: null,
  weaponTool: 'move',
  setWeapons: (weapons) => set({ weapons, weaponInfo: {}, weaponVersion: {} }),
  setWeaponInfo: (id, info) => {
    const all = { ...get().weaponInfo }
    if (info) all[id] = info
    else delete all[id]
    set({ weaponInfo: all })
  },
  bumpWeaponVersion: (id) => set({ weaponVersion: { ...get().weaponVersion, [id]: Date.now() } }),
  selectWeapon: (weaponSelection) => set({ weaponSelection }),
  setWeaponTool: (weaponTool) => set({ weaponTool })
})
