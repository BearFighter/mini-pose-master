// SPDX-License-Identifier: GPL-3.0-or-later
// app slice: app info, Blender status, update state.
import type { AppInfo, BlenderStatus, MpmEventPayloads } from '../../shared/ipc'
import type { SliceCreator } from './types'

export type UpdateState = MpmEventPayloads['update:event']

export interface AppSlice {
  info: AppInfo | null
  /** null until the first blender.status() answer. */
  blender: BlenderStatus | null
  update: UpdateState | null
  setAppInfo(info: AppInfo): void
  setBlenderStatus(status: BlenderStatus): void
  setUpdate(update: UpdateState): void
}

export const createAppSlice: SliceCreator<AppSlice> = (set) => ({
  info: null,
  blender: null,
  update: null,
  setAppInfo: (info) => set({ info }),
  setBlenderStatus: (blender) => set({ blender }),
  setUpdate: (update) => set({ update })
})
