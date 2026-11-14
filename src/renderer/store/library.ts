// SPDX-License-Identifier: GPL-3.0-or-later
// library slice (renderer side of the pose library): packs, the selected pack's index, the clip
// filter, the loaded clip, and install progress.
import type { PackIndex } from '../../shared/clip'
import type { PackInfo } from '../../shared/ipc'
import type { LoadedClip } from '../lib/clips'
import type { SliceCreator } from './types'

export interface InstallProgress {
  stage: string
  fraction: number
}

export interface LibrarySlice {
  packs: PackInfo[] | null
  selectedPack: string | null
  packIndex: PackIndex | null
  /** Bumped when a pack's files change (cache busting for index.json and thumbnails). */
  libraryVersion: number
  clipText: string
  clipTags: string[]
  loadedClip: LoadedClip | null
  /** Clip being fetched (pack/clip), for a spinner. */
  loadingClip: string | null
  installs: Record<string, InstallProgress>
  setPacks(packs: PackInfo[]): void
  setSelectedPack(packId: string | null, index?: PackIndex | null): void
  bumpLibraryVersion(): void
  setClipFilter(text: string, tags?: string[]): void
  toggleClipTag(tag: string): void
  setLoadedClip(clip: LoadedClip | null): void
  setLoadingClip(key: string | null): void
  setInstallProgress(packId: string, progress: InstallProgress | null): void
}

export const createLibrarySlice: SliceCreator<LibrarySlice> = (set, get) => ({
  packs: null,
  selectedPack: null,
  packIndex: null,
  libraryVersion: Date.now(),
  clipText: '',
  clipTags: [],
  loadedClip: null,
  loadingClip: null,
  installs: {},
  setPacks: (packs) => set({ packs }),
  setSelectedPack: (selectedPack, packIndex = null) =>
    set(selectedPack === get().selectedPack ? { packIndex } : { selectedPack, packIndex, clipText: '', clipTags: [] }),
  bumpLibraryVersion: () => set({ libraryVersion: get().libraryVersion + 1 }),
  setClipFilter: (clipText, clipTags) => set(clipTags ? { clipText, clipTags } : { clipText }),
  toggleClipTag: (tag) => {
    const tags = get().clipTags
    set({ clipTags: tags.includes(tag) ? tags.filter((t) => t !== tag) : [...tags, tag] })
  },
  setLoadedClip: (loadedClip) => set({ loadedClip }),
  setLoadingClip: (loadingClip) => set({ loadingClip }),
  setInstallProgress: (packId, progress) => {
    const installs = { ...get().installs }
    if (progress) installs[packId] = progress
    else delete installs[packId]
    set({ installs })
  }
})
