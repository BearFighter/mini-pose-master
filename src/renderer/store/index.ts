// SPDX-License-Identifier: GPL-3.0-or-later
// The renderer store: every slice in one zustand store (contracts section 18).
import { create } from 'zustand'
import { createAppSlice } from './app'
import { createBakeSlice } from './bake'
import { createHandsSlice } from './hands'
import { createJobsSlice } from './jobs'
import { createPoseSlice } from './pose'
import { createProjectSlice } from './project'
import { createRigSlice } from './rig'
import type { Store } from './types'
import { createUiSlice } from './ui'
import { createWeaponsSlice } from './weapons'

export type { Store } from './types'

export const useStore = create<Store>()((...a) => ({
  ...createAppSlice(...a),
  ...createProjectSlice(...a),
  ...createRigSlice(...a),
  ...createPoseSlice(...a),
  ...createHandsSlice(...a),
  ...createWeaponsSlice(...a),
  ...createBakeSlice(...a),
  ...createJobsSlice(...a),
  ...createUiSlice(...a)
}))
