// SPDX-License-Identifier: GPL-3.0-or-later
// Result types of the engine jobs the Import and Rig steps run (contracts section 16). Types only.
import type { Vec3 } from './coords'
import type { MarkerMap, Orientation } from './project'

/** `import` job result. */
export interface ImportJobResult {
  objects: { name: string; verts: number; tris: number; materials: string[] }[]
  materials: string[]
  normal_maps: { object: string; material: string; image: string; size: [number, number] }[]
  has_armature: boolean
  armature_bones: { name: string; parent: string | null; head: Vec3; tail: Vec3 }[]
  tri_count: number
  height_m: number
  suggested_orientation: Orientation & { reason?: string | null }
  orientation_used: Orientation
  proxy: boolean
  warnings: string[]
  /** Project-relative path of the static preview, `rig/preview.glb`. */
  preview_glb: string
}

/** `suggest_markers` job result. */
export interface SuggestMarkersResult {
  markers: MarkerMap
  warnings: string[]
}

export type SkeletonConvention = 'mixamo' | 'ue' | 'biped' | 'rigify' | 'unknown'

/** `suggest_mapping` job result. */
export interface SuggestMappingResult {
  convention: SkeletonConvention
  /** model bone name -> canonical bone name or null */
  mapping: Record<string, string | null>
  unmapped_canonical: string[]
  confidence: number
}

/** The rig job's self-check (contracts section 14 follow-check). */
export interface FollowStats {
  moved_fraction: number
  worst_drift: number
  grow: number
}

/** `rig` job result. Auto rigs also report `blind_vertices` and `hand_vertices`. */
export interface RigJobResult {
  rig_json: string
  rig_glb: string
  follow: FollowStats
  bones: number
  hash: string
  seconds: number
  blind_vertices?: number
  hand_vertices?: number
}
