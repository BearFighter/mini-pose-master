// SPDX-License-Identifier: GPL-3.0-or-later
// The app's thumbnail queue: loads the clip frame, draws it (thumbRenderer) and saves the PNG
// through library.saveThumb.
import { api } from '../api'
import { ClipCache, fetchPackIndex } from '../lib/clips'
import { ThumbQueue } from '../lib/thumbs'
import { useStore } from '../store'
import { renderStickFigure } from './thumbRenderer'

/** Thumbnails load their own clips, so they never push the pose clips out of the main cache. */
const thumbClips = new ClipCache(2)

export const thumbQueue = new ThumbQueue({
  async render(job) {
    const s = useStore.getState()
    const index = s.selectedPack === job.packId && s.packIndex ? s.packIndex : await fetchPackIndex(job.packId, s.libraryVersion)
    const clip = await thumbClips.load(job.packId, index, job.clipId)
    return renderStickFigure(clip.frame(Math.min(job.frame, clip.frames - 1)), clip.clip.jointNames)
  },
  save: (job, png) => api.library.saveThumb(job.packId, job.clipId, job.frame, png)
})
