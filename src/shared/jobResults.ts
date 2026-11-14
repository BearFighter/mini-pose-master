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

/** `convert_weapon` job result. */
export interface ConvertWeaponResult {
  /** `weapons/<stem>.glb`: static, metres, the weapon's own origin and axes. */
  weapon_glb: string
  objects: string[]
  tri_count: number
  bbox_m: [Vec3, Vec3]
  dims_m: Vec3
  /** Unit vector along the weapon's longest extent (largest component positive). */
  principal_axis: Vec3
  normal_maps: string[]
  unit_scale_used: number
  suggested_unit_scale: number
  warnings: string[]
}

/** `make_printable` report (engine/mpm/printable.py) plus `summary`. */
export interface PrintableReport {
  name: string
  final_dims_mm: Vec3
  tris: number
  stl: string
  stl_mb: number
  thin_area_pct: number
  min_thickness_mm: number
  pieces: number
  seconds: number
  summary: string
  voxel_coarsened_to?: number
  [key: string]: unknown
}

/** `bake` job result (contracts section 16). */
export interface BakeJobResult {
  stl: string
  preview_glb: string
  report: PrintableReport
  weapons: { id: string; stl: string; report: PrintableReport }[]
  gates: {
    follow: FollowStats
    posed: boolean
    faces: number
    levels_lowered: number
    voxel_coarsened_to: number | null
  }
  detail: Record<string, unknown>
  unit_mm: number
  standing_mm: number
  weights_transferred: unknown[]
  seconds: number
}
