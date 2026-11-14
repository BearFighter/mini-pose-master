// SPDX-License-Identifier: GPL-3.0-or-later
// rig slice: the import summary and preview, auto-rig markers, bone mapping, and the built rig.
// Markers are written through to the project JSON (`rigDraft.markers`) in the same update.
import type { Vec3 } from '../../shared/coords'
import type { ImportJobResult, RigJobResult, SuggestMappingResult } from '../../shared/jobResults'
import type { MarkerMap, ProjectData } from '../../shared/project'
import type { RigJson } from '../../shared/rig'
import { BONES } from '../../shared/skeleton'
import { cloneMarkers, moveMarker } from '../lib/markers'
import type { SliceCreator, Store } from './types'

export type RigPath = 'auto' | 'imported'

/** What the viewer has finished loading (for the UI and the end-to-end test). */
export interface ViewerFlags {
  previewLoaded: boolean
  rigLoaded: boolean
  /** Pose currently shown by the rig model. */
  pose: 'rest' | 'test' | 'pose' | null
  /** Increases every time the rig model has shown a new pose. */
  poseSeq: number
  boneCount: number
}

/** Canonical bones offered in the mapping table (grip bones are added by the rig job). */
export const MAPPABLE_BONES: string[] = BONES.filter((b) => b.deform).map((b) => b.name)

export interface RigSlice {
  importInfo: ImportJobResult | null
  previewUrl: string | null
  previewError: string | null
  markers: MarkerMap | null
  /** The last suggestion of "Find joints", for "Reset to suggestion". */
  suggested: MarkerMap | null
  markerWarnings: string[]
  mapping: SuggestMappingResult | null
  /** canonical bone -> model bone (null = none) */
  mappingEdits: Record<string, string | null>
  rigPath: RigPath
  rigJson: RigJson | null
  glbUrl: string | null
  rigResult: RigJobResult | null
  view: 'markers' | 'rig'
  testPose: boolean
  mirrorEdits: boolean
  xray: boolean
  viewer: ViewerFlags

  setImportInfo(info: ImportJobResult | null): void
  setPreview(url: string | null): void
  setPreviewError(message: string | null): void
  /** Sets the markers (and rigDraft.markers); `asSuggestion` also keeps them for "Reset to suggestion". */
  setMarkers(markers: MarkerMap | null, opts?: { asSuggestion?: boolean; warnings?: string[]; dirty?: boolean }): void
  /** Moves a marker (Blender frame); with "Mirror edits" on, its L/R partner too. */
  moveMarker(name: string, p: Vec3): void
  resetMarkersToSuggestion(): boolean
  setMappingSuggestion(result: SuggestMappingResult | null): void
  /** Maps a canonical bone to a model bone (or none). A model bone is used by one canonical bone at most. */
  setMappingEdit(canonical: string, bone: string | null): void
  setRigPath(path: RigPath): void
  setRig(rigJson: RigJson | null, glbUrl: string | null, result?: RigJobResult | null): void
  setView(view: 'markers' | 'rig'): void
  setTestPose(on: boolean): void
  setMirrorEdits(on: boolean): void
  setXray(on: boolean): void
  setViewerFlags(flags: Partial<ViewerFlags>): void
  resetRig(): void
}

const NO_VIEWER: ViewerFlags = { previewLoaded: false, rigLoaded: false, pose: null, poseSeq: 0, boneCount: 0 }

function withDraftMarkers(data: ProjectData, markers: MarkerMap | null): ProjectData {
  return { ...data, rigDraft: { ...(data.rigDraft ?? { markers: null }), markers } }
}

/** canonical -> model bone from a suggest_mapping result (first model bone wins). */
export function editsFromMapping(mapping: Record<string, string | null>): Record<string, string | null> {
  const edits: Record<string, string | null> = Object.fromEntries(MAPPABLE_BONES.map((c) => [c, null]))
  for (const [bone, canonical] of Object.entries(mapping)) {
    if (canonical && canonical in edits && edits[canonical] === null) edits[canonical] = bone
  }
  return edits
}

/** The rig job's `mapping` ({model bone: canonical or null}) for every model bone. */
export function mappingForJob(edits: Record<string, string | null>, modelBones: string[]): Record<string, string | null> {
  const out: Record<string, string | null> = Object.fromEntries(modelBones.map((b) => [b, null]))
  for (const [canonical, bone] of Object.entries(edits)) if (bone) out[bone] = canonical
  return out
}

export const initialRigState = () => ({
  importInfo: null,
  previewUrl: null,
  previewError: null,
  markers: null,
  suggested: null,
  markerWarnings: [] as string[],
  mapping: null,
  mappingEdits: {} as Record<string, string | null>,
  rigPath: 'auto' as RigPath,
  rigJson: null,
  glbUrl: null,
  rigResult: null,
  view: 'markers' as const,
  testPose: false,
  mirrorEdits: true,
  xray: true,
  viewer: { ...NO_VIEWER }
})

export const createRigSlice: SliceCreator<RigSlice> = (set, get) => ({
  ...initialRigState(),
  setImportInfo: (importInfo) => set({ importInfo }),
  setPreview: (previewUrl) => set({ previewUrl, previewError: null, viewer: { ...get().viewer, previewLoaded: false } }),
  setPreviewError: (previewError) => set({ previewError }),
  setMarkers: (markers, opts = {}) => {
    const { data } = get()
    const patch: Partial<Store> = { markers }
    if (opts.asSuggestion) patch.suggested = markers ? cloneMarkers(markers) : null
    if (opts.warnings) patch.markerWarnings = opts.warnings
    if (data) {
      patch.data = withDraftMarkers(data, markers)
      if (opts.dirty !== false) patch.dirty = true
    }
    set(patch)
  },
  moveMarker: (name, p) => {
    const { markers, mirrorEdits, data } = get()
    if (!markers?.[name]) return
    const next = moveMarker(markers, name, p, mirrorEdits)
    set(data ? { markers: next, data: withDraftMarkers(data, next), dirty: true } : { markers: next })
  },
  resetMarkersToSuggestion: () => {
    const { suggested } = get()
    if (!suggested) return false
    get().setMarkers(cloneMarkers(suggested))
    return true
  },
  setMappingSuggestion: (mapping) => set({ mapping, mappingEdits: mapping ? editsFromMapping(mapping.mapping) : {} }),
  setMappingEdit: (canonical, bone) => {
    const edits = { ...get().mappingEdits }
    if (bone) for (const [c, b] of Object.entries(edits)) if (b === bone) edits[c] = null
    edits[canonical] = bone
    set({ mappingEdits: edits })
  },
  setRigPath: (rigPath) => set({ rigPath }),
  setRig: (rigJson, glbUrl, result) =>
    set({
      rigJson,
      glbUrl,
      ...(result !== undefined ? { rigResult: result } : {}),
      view: rigJson ? 'rig' : 'markers',
      viewer: { ...get().viewer, rigLoaded: false, pose: null, boneCount: 0 }
    }),
  setView: (view) => set({ view }),
  setTestPose: (testPose) => set({ testPose }),
  setMirrorEdits: (mirrorEdits) => set({ mirrorEdits }),
  setXray: (xray) => set({ xray }),
  setViewerFlags: (flags) => set({ viewer: { ...get().viewer, ...flags } }),
  resetRig: () => set(initialRigState())
})
