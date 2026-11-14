// SPDX-License-Identifier: GPL-3.0-or-later
// Types of the project file (contracts section 15) and the markers file (section 4), shared by the
// main process and the renderer. Types only; no DOM and no Node APIs.
import type { QuatWXYZ, Vec3 } from './coords'
import type { HandPose } from './handPose'
import type { PoseState } from './poseState'

/** An axis as the import job writes it: `X`, `-X`, `Y`, `-Y`, `Z`, `-Z`. */
export type Axis = 'X' | '-X' | 'Y' | '-Y' | 'Z' | '-Z'

/** `source.orientation` / the import job's `orientation` argument. */
export interface Orientation {
  up: Axis
  forward: Axis
  unit_scale: number
}

/** One marker of rig/markers.json (contracts section 4). Blender frame, metres. */
export interface MarkerEntry {
  p: Vec3
  confidence: number
  source: 'auto' | 'user'
}

/** Editable joint name -> marker. */
export type MarkerMap = Record<string, MarkerEntry>

/** rig/markers.json */
export interface MarkersFile {
  schema: 'mpm.markers/1'
  markers: MarkerMap
}

/** Work-in-progress rig data kept in the project file until (and after) the rig job runs. */
export interface RigDraft {
  /** The (possibly edited) auto-rig markers; null until "Find joints" has run. */
  markers: MarkerMap | null
}

/** Weapon entry (contracts section 12). */
export interface WeaponEntry {
  id: string
  file: string
  attach_bone: string
  offset: { t: Vec3; q: QuatWXYZ; s: number }
  support: { enabled: boolean; side: 'L' | 'R'; point: Vec3; normal: Vec3; axis: Vec3 }
  merge: boolean
}

/** Bake settings (contracts section 14). */
export interface BakeSettings {
  schema: 'mpm.bake/1'
  scale: { mode: 'height_mm'; height_mm: number } | { mode: 'heroic'; size_mm: number }
  detail: number
  flatten_mm: number
  base_mm: number
  min_wall_mm: number
  weapons_separate: boolean
  max_tris: number
}

/** `hands` of the project file (contracts section 15). */
export interface ProjectHands {
  L: HandPose | null
  R: HandPose | null
  locked: Partial<Record<'L' | 'R', string[]>>
}

/** The .mposer JSON (contracts section 15) plus `rigDraft`. Unknown keys are kept as they are. */
export interface ProjectData {
  schemaVersion: number
  app: string
  appVersion: string
  source: { file: string; orientation: Orientation | null } | null
  rig: { kind: 'auto' | 'imported'; hash: string } | null
  pose: PoseState | null
  hands: ProjectHands | null
  weapons: WeaponEntry[]
  bake: BakeSettings | null
  rigDraft?: RigDraft
  [key: string]: unknown
}

export const MARKERS_SCHEMA = 'mpm.markers/1'
