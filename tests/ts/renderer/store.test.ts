// SPDX-License-Identifier: GPL-3.0-or-later
// Renderer store slices and flows (src/renderer/store) against a fake window.mpm.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JobError } from '../../../src/renderer/api'
import { addRecent, loadRecent, RECENT_KEY, RECENT_MAX, removeRecent } from '../../../src/renderer/lib/recent'
import { useStore } from '../../../src/renderer/store'
import {
  buildRig,
  closeProject,
  createProject,
  findJoints,
  importModel,
  openProject,
  rerunImport,
  saveProject,
  suggestMapping
} from '../../../src/renderer/store/actions'
import { appendTail, LOG_TAIL_MAX } from '../../../src/renderer/store/jobs'
import { UNDO_MAX } from '../../../src/renderer/store/pose'
import { editsFromMapping, MAPPABLE_BONES, mappingForJob } from '../../../src/renderer/store/rig'
import type { ImportJobResult, RigJobResult, SuggestMarkersResult } from '../../../src/shared/jobResults'
import type { MarkerMap, ProjectData } from '../../../src/shared/project'
import type { RigJson } from '../../../src/shared/rig'
import { FakeMpm, installFakeMpm } from './fakeMpm'

const RIG = JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'rig_auto_apose.json'), 'utf8')) as RigJson
const yes = () => true
const S = () => useStore.getState()

function markers(): MarkerMap {
  return {
    pelvis: { p: [0, 0, 0.95], confidence: 0.95, source: 'auto' },
    shoulder_L: { p: [0.19, 0.03, 1.45], confidence: 0.45, source: 'auto' },
    shoulder_R: { p: [-0.19, 0.03, 1.45], confidence: 0.7, source: 'auto' }
  }
}

function importResult(orientation = { up: 'Z', forward: '-Y', unit_scale: 1 }): ImportJobResult {
  return {
    objects: [{ name: 'Body', verts: 10, tris: 12, materials: ['skin'] }],
    materials: ['skin'],
    normal_maps: [],
    has_armature: false,
    armature_bones: [],
    tri_count: 12,
    height_m: 1.8,
    suggested_orientation: { up: 'Z', forward: '-Y', unit_scale: 1, reason: 'toes point -Y' },
    orientation_used: orientation as ImportJobResult['orientation_used'],
    proxy: false,
    warnings: [],
    preview_glb: 'rig/preview.glb'
  }
}

let fake: FakeMpm

beforeEach(() => {
  fake = installFakeMpm()
  useStore.setState(useStore.getInitialState(), true)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('project slice', () => {
  it('updateProject marks dirty; markSaved clears it only for the saved state', () => {
    const data = { schemaVersion: 1 } as ProjectData
    S().setProject('C:/p/Hero', data)
    expect(S().dirty).toBe(false)
    S().updateProject((d) => ({ ...d, extra: 1 }))
    expect(S().dirty).toBe(true)
    const saved = S().data!
    S().updateProject((d) => ({ ...d, extra: 2 }))
    S().markSaved(saved) // an older state was saved: still dirty
    expect(S().dirty).toBe(true)
    S().markSaved(S().data!)
    expect(S().dirty).toBe(false)
  })
})

describe('rig slice', () => {
  it('writes markers through to project.rigDraft.markers', () => {
    S().setProject('C:/p/Hero', { schemaVersion: 1 } as ProjectData)
    S().setMarkers(markers(), { asSuggestion: true, warnings: ['w'] })
    expect(S().data!.rigDraft!.markers).toEqual(markers())
    expect(S().suggested).toEqual(markers())
    expect(S().markerWarnings).toEqual(['w'])
    expect(S().dirty).toBe(true)
  })

  it('moves markers (mirrored when "Mirror edits" is on) and resets to the suggestion', () => {
    S().setProject('C:/p/Hero', { schemaVersion: 1 } as ProjectData)
    S().setMarkers(markers(), { asSuggestion: true, dirty: false })
    expect(S().dirty).toBe(false)
    S().setMirrorEdits(true)
    S().moveMarker('shoulder_L', [0.22, 0.04, 1.47])
    expect(S().markers!.shoulder_R.p).toEqual([-0.22, 0.04, 1.47])
    expect(S().data!.rigDraft!.markers!.shoulder_R.source).toBe('user')
    expect(S().dirty).toBe(true)
    S().setMirrorEdits(false)
    S().moveMarker('shoulder_L', [0.3, 0.04, 1.47])
    expect(S().markers!.shoulder_R.p).toEqual([-0.22, 0.04, 1.47])
    expect(S().resetMarkersToSuggestion()).toBe(true)
    expect(S().markers).toEqual(markers())
    expect(S().data!.rigDraft!.markers).toEqual(markers())
    // the suggestion is a copy: editing the markers never changes it
    S().moveMarker('pelvis', [1, 1, 1])
    expect(S().suggested!.pelvis.p).toEqual([0, 0, 0.95])
  })

  it('maps each model bone to one canonical bone at most and builds the job mapping', () => {
    const edits = editsFromMapping({ Hips: 'hips', Spine: 'spine', Extra: null, Hips2: 'hips' })
    expect(edits.hips).toBe('Hips')
    expect(edits.spine).toBe('Spine')
    expect(edits.head).toBeNull()
    expect(Object.keys(edits).sort()).toEqual([...MAPPABLE_BONES].sort())
    expect(MAPPABLE_BONES).not.toContain('grip.L')
    useStore.setState({ mappingEdits: edits })
    S().setMappingEdit('chest', 'Spine') // takes Spine away from spine
    expect(S().mappingEdits.spine).toBeNull()
    expect(S().mappingEdits.chest).toBe('Spine')
    expect(mappingForJob(S().mappingEdits, ['Hips', 'Spine', 'Extra', 'Hips2'])).toEqual({
      Hips: 'hips',
      Spine: 'chest',
      Extra: null,
      Hips2: null
    })
  })
})

describe('jobs, pose and ui slices', () => {
  it('keeps the last 500 log lines', () => {
    for (let i = 0; i < LOG_TAIL_MAX + 20; i++) S().appendLog(`line ${i}`)
    expect(S().log.length).toBe(LOG_TAIL_MAX)
    expect(S().log[0]).toBe('line 20')
    expect(appendTail(['a'], ['b', 'c'], 2)).toEqual(['b', 'c'])
  })

  it('tracks the active job and the error banner', () => {
    S().jobStarted('rig', 'Building the rig')
    S().jobIdKnown('j1')
    S().jobProgress({ stage: 'skin', fraction: 0.2, message: 'weighting' })
    expect(S().active).toEqual({ type: 'rig', label: 'Building the rig', jobId: 'j1' })
    S().jobFinished({ type: 'rig', result: 1 })
    expect(S().active).toBeNull()
    expect(S().lastResult).toEqual({ type: 'rig', result: 1 })
    S().setError({ code: 'E_IO', message: 'disk full' })
    S().dismissError()
    expect(S().error).toBeNull()
  })

  it('pose undo/redo is capped at 100', () => {
    for (let i = 0; i < UNDO_MAX + 5; i++) S().setPose({ deltas: { '0': [1, 0, 0, 0] }, rootOffset: [i, 0, 0], provenance: null })
    expect(S().undo.length).toBe(UNDO_MAX)
    S().undoPose()
    expect(S().rootOffset[0]).toBe(UNDO_MAX + 3)
    S().redoPose()
    expect(S().rootOffset[0]).toBe(UNDO_MAX + 4)
  })

  it('focus requests get increasing sequence numbers', () => {
    S().requestFocus([0, 1, 0], 1)
    S().requestFocus([0, 1, 0], 1, false)
    expect(S().focus).toEqual({ center: [0, 1, 0], radius: 1, keepDirection: false, seq: 2 })
  })
})

describe('recent projects', () => {
  it('keeps up to 8, newest first, without duplicates, and survives broken storage', () => {
    const mem = new Map<string, string>()
    const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) }
    for (let i = 0; i < 10; i++) addRecent({ dir: `C:/p/P${i}`, name: `P${i}` }, store, i)
    addRecent({ dir: 'C:\\P\\p3\\', name: 'P3' }, store, 99) // same folder, other spelling
    const list = loadRecent(store)
    expect(list.length).toBe(RECENT_MAX)
    expect(list[0].name).toBe('P3')
    expect(list.filter((r) => r.name === 'P3').length).toBe(1)
    expect(removeRecent('C:/p/P9', store).some((r) => r.dir === 'C:/p/P9')).toBe(false)
    mem.set(RECENT_KEY, '{broken')
    expect(loadRecent(store)).toEqual([])
    const throwing = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      }
    }
    expect(loadRecent(throwing)).toEqual([])
    expect(() => addRecent({ dir: 'x', name: 'x' }, throwing)).not.toThrow()
  })
})

describe('flows', () => {
  it('a project save/load round trip keeps rigDraft', async () => {
    await createProject('Hero', 'C:/p', yes)
    expect(S().dir).toBe('C:/p/Hero')
    fake.script('suggest_markers', {
      events: [{ kind: 'result', payload: { markers: markers(), warnings: [] } satisfies SuggestMarkersResult }]
    })
    await findJoints()
    S().setMirrorEdits(true)
    S().moveMarker('shoulder_L', [0.25, 0.03, 1.44])
    expect(S().dirty).toBe(true)
    await saveProject()
    expect(S().dirty).toBe(false)
    const savedDraft = (fake.saves.at(-1)!.project as ProjectData).rigDraft!
    expect(savedDraft.markers!.shoulder_R).toEqual({ p: [-0.25, 0.03, 1.44], confidence: 0.7, source: 'user' })

    expect(closeProject(yes)).toBe(true)
    expect(S().data).toBeNull()
    await openProject('C:/p/Hero', yes)
    expect(S().data!.rigDraft).toEqual(savedDraft)
    expect(S().markers).toEqual(savedDraft.markers)
    expect(S().dirty).toBe(false)
  })

  it('asks before discarding unsaved changes', async () => {
    await createProject('Hero', 'C:/p', yes)
    S().updateProject((d) => ({ ...d, extra: 1 }))
    expect(await openProject('C:/p/Hero', () => false)).toBe(false)
    expect(S().data!.extra).toBe(1)
    expect(closeProject(() => false)).toBe(false)
  })

  it('imports a model: copies it, runs the import job, stores the orientation, saves', async () => {
    await createProject('Hero', 'C:/p', yes)
    fake.script('import', {
      events: [
        { kind: 'progress', payload: { stage: 'import', fraction: 0.2, message: 'importing' } },
        { kind: 'result', payload: importResult() }
      ]
    })
    const result = await importModel('D:/models/hero.fbx')
    expect(result.tri_count).toBe(12)
    expect(fake.runs.at(-1)).toEqual({ dir: 'C:/p/Hero', type: 'import', args: { file: 'source/hero.fbx' } })
    expect(S().data!.source).toEqual({ file: 'source/hero.fbx', orientation: { up: 'Z', forward: '-Y', unit_scale: 1 } })
    expect(S().importInfo?.tri_count).toBe(12)
    expect(S().previewUrl).toMatch(/^mpm:\/\/project\/rig\/preview\.glb\?v=\d+$/)
    expect(S().dirty).toBe(false)
    expect(S().active).toBeNull()
    expect(S().lastResult?.type).toBe('import')
  })

  it('"Apply" with a new orientation re-imports and drops markers and rig; the same one keeps them', async () => {
    await createProject('Hero', 'C:/p', yes)
    fake.script('import', { events: [{ kind: 'result', payload: importResult() }] })
    await importModel('D:/models/hero.fbx')
    S().setMarkers(markers())
    fake.script('import', { events: [{ kind: 'result', payload: importResult() }] })
    await rerunImport()
    expect(fake.runs.at(-1)!.args.orientation).toEqual({ up: 'Z', forward: '-Y', unit_scale: 1 })
    expect(S().markers).toEqual(markers())
    fake.script('import', { events: [{ kind: 'result', payload: importResult({ up: 'Y', forward: '-Z', unit_scale: 0.01 }) }] })
    await rerunImport({ up: 'Y', forward: '-Z', unit_scale: 0.01 })
    expect(fake.runs.at(-1)!.args.orientation).toEqual({ up: 'Y', forward: '-Z', unit_scale: 0.01 })
    expect(S().data!.source!.orientation).toEqual({ up: 'Y', forward: '-Z', unit_scale: 0.01 })
    expect(S().markers).toBeNull()
    expect(S().data!.rigDraft!.markers).toBeNull()
  })

  it('builds the auto rig from the markers, records project.rig and loads rig.json', async () => {
    await createProject('Hero', 'C:/p', yes)
    fake.script('suggest_markers', { events: [{ kind: 'result', payload: { markers: markers(), warnings: [] } }] })
    await findJoints()
    S().moveMarker('pelvis', [0, 0.01, 0.96])
    const rigResult: RigJobResult = {
      rig_json: 'rig/rig.json',
      rig_glb: 'rig/rig.glb',
      follow: { moved_fraction: 0.4, worst_drift: 0.001, grow: 1 },
      bones: RIG.bones.length,
      hash: RIG.hash,
      seconds: 3
    }
    fake.script('rig', { events: [{ kind: 'result', payload: rigResult }] })
    const fetched: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      fetched.push(url)
      return new Response(JSON.stringify(RIG), { status: 200 })
    })
    await buildRig('auto')
    const run = fake.runs.at(-1)!
    expect(run.type).toBe('rig')
    expect((run.args.markers as MarkerMap).pelvis.p).toEqual([0, 0.01, 0.96])
    // the edited markers were saved (rig/markers.json is written by project.save) before the job
    const saveBeforeRig = fake.saves.at(-2)!.project as ProjectData
    expect(saveBeforeRig.rigDraft!.markers!.pelvis.p).toEqual([0, 0.01, 0.96])
    expect(S().data!.rig).toEqual({ kind: 'auto', hash: RIG.hash })
    expect(S().rigJson?.hash).toBe(RIG.hash)
    expect(S().glbUrl).toMatch(/^mpm:\/\/project\/rig\/rig\.glb\?v=\d+$/)
    expect(fetched[0]).toMatch(/^mpm:\/\/project\/rig\/rig\.json\?v=\d+$/)
    expect(S().rigResult?.follow.moved_fraction).toBe(0.4)
    expect(S().view).toBe('rig')
    expect(S().dirty).toBe(false)
  })

  it('maps an imported skeleton: suggest_mapping, then rig with {bone: canonical}', async () => {
    await createProject('Hero', 'C:/p', yes)
    fake.script('suggest_mapping', {
      events: [
        {
          kind: 'result',
          payload: { convention: 'mixamo', mapping: { 'mixamorig:Hips': 'hips', 'mixamorig:Spine': 'spine', 'mixamorig:Tail': null }, unmapped_canonical: [], confidence: 0.9 }
        }
      ]
    })
    await suggestMapping()
    expect(S().mappingEdits.hips).toBe('mixamorig:Hips')
    S().setMappingEdit('head', 'mixamorig:Tail')
    fake.script('rig', {
      events: [{ kind: 'result', payload: { rig_json: '', rig_glb: '', follow: { moved_fraction: 0.3, worst_drift: 0, grow: 1 }, bones: 3, hash: RIG.hash, seconds: 1 } }]
    })
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ ...RIG, kind: 'imported' }), { status: 200 }))
    await buildRig('imported')
    expect(fake.runs.at(-1)!.args).toEqual({
      mapping: { 'mixamorig:Hips': 'hips', 'mixamorig:Spine': 'spine', 'mixamorig:Tail': 'head' }
    })
    expect(S().data!.rig).toEqual({ kind: 'imported', hash: RIG.hash })
  })

  it('shows job errors in the banner and rejects; cancellation is not an error', async () => {
    await createProject('Hero', 'C:/p', yes)
    fake.script('suggest_markers', {
      events: [{ kind: 'error', payload: { code: 'E_IO', message: 'rig/scene.blend not found', detail: {} } }]
    })
    await expect(findJoints()).rejects.toBeInstanceOf(JobError)
    expect(S().error).toEqual({ code: 'E_IO', message: 'rig/scene.blend not found' })
    expect(S().active).toBeNull()
    S().dismissError()
    fake.script('suggest_markers', { events: [{ kind: 'error', payload: { code: 'E_CANCELLED', message: 'cancelled', detail: {} } }] })
    await expect(findJoints()).rejects.toBeInstanceOf(JobError)
    expect(S().error).toBeNull()
  })

  it('refuses a second job while one runs', async () => {
    await createProject('Hero', 'C:/p', yes)
    S().jobStarted('rig', 'Building the rig')
    await expect(findJoints()).rejects.toThrow(/still running/)
    expect(fake.runs.length).toBe(0)
  })
})
