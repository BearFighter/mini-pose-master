// SPDX-License-Identifier: GPL-3.0-or-later
// project slice: the open project's folder, its JSON (the single serialisable state) and a dirty flag.
import type { ProjectData } from '../../shared/project'
import type { SliceCreator } from './types'

export interface ProjectSlice {
  dir: string | null
  data: ProjectData | null
  dirty: boolean
  /** Adopts a project as loaded or saved (not dirty). */
  setProject(dir: string, data: ProjectData): void
  /** Replaces the project JSON through `mutate` (which must not modify its argument) and marks it dirty. */
  updateProject(mutate: (data: ProjectData) => ProjectData): void
  /** After a save of `saved`: clean, unless the project changed while the save ran. */
  markSaved(saved: ProjectData): void
  closeProject(): void
}

export const createProjectSlice: SliceCreator<ProjectSlice> = (set, get) => ({
  dir: null,
  data: null,
  dirty: false,
  setProject: (dir, data) => set({ dir, data, dirty: false }),
  updateProject: (mutate) => {
    const data = get().data
    if (!data) return
    set({ data: mutate(data), dirty: true })
  },
  markSaved: (saved) => {
    if (get().data === saved) set({ dirty: false })
  },
  closeProject: () => set({ dir: null, data: null, dirty: false })
})
