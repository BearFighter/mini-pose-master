// SPDX-License-Identifier: GPL-3.0-or-later
// pose slice (contracts sections 13 and 18): the pose *inputs* (clip source, mirrored, planted, edits),
// a live preview, and ONE undo/redo history for the whole pose: snapshots of {poseInputs, hands,
// weapons}, so a weapon move or a finger slider undoes like a bone edit. The deltas are derived with
// composePose (lib/pose.ts computePose), never stored here.
import type { EditOp } from '../../shared/composePose'
import type { WeaponEntry } from '../../shared/project'
import type { HandsState } from '../lib/hands'
import { REST_INPUTS, type PoseInputsState, type PosePreview } from '../lib/pose'
import type { SliceCreator } from './types'

export const UNDO_MAX = 100

export interface HistorySnapshot {
  poseInputs: PoseInputsState
  hands: HandsState
  weapons: WeaponEntry[]
}

export interface PoseSlice {
  poseInputs: PoseInputsState
  posePreview: PosePreview | null
  undo: HistorySnapshot[]
  redo: HistorySnapshot[]
  /** Bone (canonical name) of the last committed gizmo drag; a new drag on it merges (lib/pose appendRotate). */
  gestureBone: string | null
  /** A message about the pose (re-applied to a rebuilt rig, clip not installed, ...). */
  poseNotice: string | null
  /** Commits a change to the pose inputs, hands and/or weapons as one undo step (100 kept); clears redo and the preview. */
  commitHistory(next: Partial<HistorySnapshot>, opts?: { gestureBone?: string | null }): void
  /** commitHistory for the pose inputs alone. */
  commitPose(next: PoseInputsState, opts?: { gestureBone?: string | null }): void
  setPosePreview(preview: PosePreview | null): void
  undoPose(): boolean
  redoPose(): boolean
  /** Replaces the inputs without an undo step and clears the history (project load, new rig). */
  resetPoseInputs(inputs?: PoseInputsState): void
  setPoseNotice(notice: string | null): void
}

/** Snapshots are compared by value: committing the same state again is not an undo step. */
function same(a: HistorySnapshot, b: HistorySnapshot): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export const createPoseSlice: SliceCreator<PoseSlice> = (set, get) => {
  const snapshot = (): HistorySnapshot => {
    const s = get()
    return { poseInputs: s.poseInputs, hands: s.hands, weapons: s.weapons }
  }
  const restore = (h: HistorySnapshot) => ({ poseInputs: h.poseInputs, hands: h.hands, weapons: h.weapons })
  const touched = () => {
    const data = get().data
    // a new project object so a save that is running doesn't mark this change as saved
    return data ? { data: { ...data }, dirty: true } : {}
  }
  return {
    poseInputs: REST_INPUTS,
    posePreview: null,
    undo: [],
    redo: [],
    gestureBone: null,
    poseNotice: null,
    commitHistory: (next, opts = {}) => {
      const before = snapshot()
      const after: HistorySnapshot = { ...before, ...next }
      const gestureBone = opts.gestureBone ?? null
      if (same(before, after)) {
        set({ posePreview: null, gestureBone })
        return
      }
      set({
        ...restore(after),
        posePreview: null,
        undo: [...get().undo, before].slice(-UNDO_MAX),
        redo: [],
        gestureBone,
        ...touched()
      })
    },
    commitPose: (next, opts) => get().commitHistory({ poseInputs: next }, opts),
    setPosePreview: (posePreview) => set({ posePreview }),
    undoPose: () => {
      const { undo, redo } = get()
      const prev = undo[undo.length - 1]
      if (!prev) return false
      set({ ...restore(prev), posePreview: null, undo: undo.slice(0, -1), redo: [...redo, snapshot()].slice(-UNDO_MAX), gestureBone: null, ...touched() })
      return true
    },
    redoPose: () => {
      const { undo, redo } = get()
      const next = redo[redo.length - 1]
      if (!next) return false
      set({ ...restore(next), posePreview: null, redo: redo.slice(0, -1), undo: [...undo, snapshot()].slice(-UNDO_MAX), gestureBone: null, ...touched() })
      return true
    },
    resetPoseInputs: (inputs = REST_INPUTS) => set({ poseInputs: inputs, posePreview: null, undo: [], redo: [], gestureBone: null }),
    setPoseNotice: (poseNotice) => set({ poseNotice })
  }
}

/** Type helper for edit ops in components. */
export type { EditOp }
