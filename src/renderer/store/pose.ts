// SPDX-License-Identifier: GPL-3.0-or-later
// pose slice (contracts section 13/18): deltas by rig bone index, root offset, provenance, undo/redo.
// No UI yet; the Pose step builds on it.
import type { Vec3 } from '../../shared/coords'
import type { Deltas } from '../../shared/fk'
import type { PoseProvenance } from '../../shared/poseState'
import type { SliceCreator } from './types'

export const UNDO_MAX = 100

export interface PoseSnapshot {
  deltas: Deltas
  rootOffset: Vec3
  provenance: PoseProvenance | null
}

export interface PoseSlice {
  deltas: Deltas
  rootOffset: Vec3
  provenance: PoseProvenance | null
  undo: PoseSnapshot[]
  redo: PoseSnapshot[]
  /** Sets the pose, pushing the previous one on the undo stack (at most 100) and clearing redo. */
  setPose(pose: PoseSnapshot): void
  undoPose(): void
  redoPose(): void
  resetPose(): void
}

const snapshot = (s: PoseSnapshot): PoseSnapshot => ({ deltas: s.deltas, rootOffset: s.rootOffset, provenance: s.provenance })

export const createPoseSlice: SliceCreator<PoseSlice> = (set, get) => ({
  deltas: {},
  rootOffset: [0, 0, 0],
  provenance: null,
  undo: [],
  redo: [],
  setPose: (pose) => set({ ...snapshot(pose), undo: [...get().undo, snapshot(get())].slice(-UNDO_MAX), redo: [] }),
  undoPose: () => {
    const undo = get().undo
    const prev = undo[undo.length - 1]
    if (!prev) return
    set({ ...prev, undo: undo.slice(0, -1), redo: [...get().redo, snapshot(get())].slice(-UNDO_MAX) })
  },
  redoPose: () => {
    const redo = get().redo
    const next = redo[redo.length - 1]
    if (!next) return
    set({ ...next, redo: redo.slice(0, -1), undo: [...get().undo, snapshot(get())].slice(-UNDO_MAX) })
  },
  resetPose: () => set({ deltas: {}, rootOffset: [0, 0, 0], provenance: null, undo: [], redo: [] })
})
