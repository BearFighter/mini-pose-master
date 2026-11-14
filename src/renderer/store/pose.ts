// SPDX-License-Identifier: GPL-3.0-or-later
// pose slice (contracts sections 13 and 18): the pose *inputs* (clip source, mirrored, planted,
// edits), a live preview, and undo/redo stacks of input snapshots. The deltas are derived with
// composePose (lib/pose.ts computePose), never stored here.
import type { EditOp } from '../../shared/composePose'
import { REST_INPUTS, type PoseInputsState, type PosePreview } from '../lib/pose'
import type { SliceCreator } from './types'

export const UNDO_MAX = 100

export interface PoseSlice {
  poseInputs: PoseInputsState
  posePreview: PosePreview | null
  undo: PoseInputsState[]
  redo: PoseInputsState[]
  /** Bone (canonical name) of the last committed gizmo drag; a new drag on it merges (lib/pose appendRotate). */
  gestureBone: string | null
  /** A message about the pose (re-applied to a rebuilt rig, clip not installed, ...). */
  poseNotice: string | null
  /** Commits new inputs as one undo step (at most 100 kept); clears redo and the preview. */
  commitPose(next: PoseInputsState, opts?: { gestureBone?: string | null }): void
  setPosePreview(preview: PosePreview | null): void
  undoPose(): boolean
  redoPose(): boolean
  /** Replaces the inputs without an undo step (project load, new rig). */
  resetPoseInputs(inputs?: PoseInputsState): void
  setPoseNotice(notice: string | null): void
}

/** Edits are compared by value: committing the same inputs again is not an undo step. */
function same(a: PoseInputsState, b: PoseInputsState): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export const createPoseSlice: SliceCreator<PoseSlice> = (set, get) => ({
  poseInputs: REST_INPUTS,
  posePreview: null,
  undo: [],
  redo: [],
  gestureBone: null,
  poseNotice: null,
  commitPose: (next, opts = {}) => {
    const { poseInputs, undo, data } = get()
    const gestureBone = opts.gestureBone ?? null
    if (same(poseInputs, next)) {
      set({ posePreview: null, gestureBone })
      return
    }
    set({
      poseInputs: next,
      posePreview: null,
      undo: [...undo, poseInputs].slice(-UNDO_MAX),
      redo: [],
      gestureBone,
      // a new project object so a save that is running doesn't mark this change as saved
      ...(data ? { data: { ...data }, dirty: true } : {})
    })
  },
  setPosePreview: (posePreview) => set({ posePreview }),
  undoPose: () => {
    const { undo, redo, poseInputs, data } = get()
    const prev = undo[undo.length - 1]
    if (!prev) return false
    set({
      poseInputs: prev,
      posePreview: null,
      undo: undo.slice(0, -1),
      redo: [...redo, poseInputs].slice(-UNDO_MAX),
      gestureBone: null,
      ...(data ? { data: { ...data }, dirty: true } : {})
    })
    return true
  },
  redoPose: () => {
    const { undo, redo, poseInputs, data } = get()
    const next = redo[redo.length - 1]
    if (!next) return false
    set({
      poseInputs: next,
      posePreview: null,
      redo: redo.slice(0, -1),
      undo: [...undo, poseInputs].slice(-UNDO_MAX),
      gestureBone: null,
      ...(data ? { data: { ...data }, dirty: true } : {})
    })
    return true
  },
  resetPoseInputs: (inputs = REST_INPUTS) => set({ poseInputs: inputs, posePreview: null, undo: [], redo: [], gestureBone: null }),
  setPoseNotice: (poseNotice) => set({ poseNotice })
})

/** Type helper for edit ops in components. */
export type { EditOp }
