// SPDX-License-Identifier: GPL-3.0-or-later
// Parts of an imported file and the props left out of the character: the Import step's ticks, the
// re-import with a parts choice, props added as weapons, the "Find joints" hand warnings, and the
// e2e hook's plumbing. All against a fake window.mpm.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JobError } from '../../../src/renderer/api'
import { installTestHook, type MpmTestHook } from '../../../src/renderer/e2e'
import { warningHand } from '../../../src/renderer/lib/markers'
import { includedMap, partsChoice, partsDirty, partsOf, propRows, sameChoice, sameObjects, withTick } from '../../../src/renderer/lib/parts'
import { useStore } from '../../../src/renderer/store'
import {
  applyParts,
  closeProject,
  createProject,
  findJoints,
  importModel,
  openProject,
  rerunImport,
  saveProject,
  zoomToHand
} from '../../../src/renderer/store/actions'
import { clipCache } from '../../../src/renderer/store/poseActions'
import { addPropWeapon, addWeapon } from '../../../src/renderer/store/weaponActions'
import type { ConvertWeaponResult, ImportJobResult, SuggestMarkersResult } from '../../../src/shared/jobResults'
import type { MarkerMap, Orientation, PartsChoice, ProjectData } from '../../../src/shared/project'
import { autoRig } from '../helpers/skeletonRig'
import { installFakeMpm, type FakeMpm } from './fakeMpm'

const RIG = autoRig()
const S = () => useStore.getState()
const yes = () => true
const Z_UP: Orientation = { up: 'Z', forward: '-Y', unit_scale: 1 }
const PISTOL = 'props/Pistol.glb'

/** What the import job does by itself with the kit below: the pistol's two objects are props. */
const AUTO: PartsChoice = { Body: true, Hat: true, Pistol: false, Pistol_mag: false }

/** A kit of four objects: a character (body and hat) and a pistol on the floor made of two objects. */
function kit(included: PartsChoice = AUTO, orientation: Orientation = Z_UP): ImportJobResult & { source_file: string } {
  const all = [
    { name: 'Body', verts: 100, tris: 180, prop: false },
    { name: 'Hat', verts: 20, tris: 30, prop: false },
    { name: 'Pistol', verts: 40, tris: 60, prop: true },
    { name: 'Pistol_mag', verts: 8, tris: 12, prop: true }
  ].map((o) => ({ ...o, included: included[o.name] }))
  const kept = all.filter((o) => o.included)
  const pistolOut = !included.Pistol && !included.Pistol_mag
  return {
    objects: kept.map((o) => ({ name: o.name, verts: o.verts, tris: o.tris, materials: [] })),
    all_objects: all,
    props: pistolOut ? [{ file: PISTOL, objects: ['Pistol', 'Pistol_mag'], dims_m: [0.03, 0.184, 0.12] }] : [],
    materials: [],
    normal_maps: [],
    has_armature: false,
    armature_bones: [],
    tri_count: kept.reduce((n, o) => n + o.tris, 0),
    height_m: 1.8,
    suggested_orientation: { ...Z_UP, reason: 'toes point -Y' },
    orientation_used: orientation,
    proxy: false,
    warnings: pistolOut ? ['left out as props: Pistol, Pistol_mag'] : [],
    preview_glb: 'rig/preview.glb',
    source_file: 'source/hero.fbx'
  }
}

/** An import summary as an older version wrote it: no `all_objects`, no `props`. */
function olderSummary(): ImportJobResult {
  const { all_objects: _a, props: _p, ...rest } = kit()
  return rest
}

const CONVERTED: ConvertWeaponResult = {
  weapon_glb: 'weapons/Pistol.glb',
  objects: ['Pistol', 'Pistol_mag'],
  tri_count: 72,
  bbox_m: [
    [-0.015, -0.092, -0.06],
    [0.015, 0.092, 0.06]
  ],
  dims_m: [0.03, 0.184, 0.12],
  principal_axis: [0, 1, 0],
  normal_maps: [],
  unit_scale_used: 1,
  suggested_unit_scale: 1,
  warnings: []
}

function markers(): MarkerMap {
  return {
    pelvis: { p: [0, 0, 0.95], confidence: 0.95, source: 'auto' },
    wrist_R: { p: [-0.7, 0, 1.4], confidence: 0.9, source: 'auto' },
    index_0_R: { p: [-0.78, -0.02, 1.4], confidence: 0.4, source: 'auto' },
    index_tip_R: { p: [-0.86, -0.02, 1.4], confidence: 0.4, source: 'auto' },
    wrist_L: { p: [0.7, 0, 1.4], confidence: 0.9, source: 'auto' }
  }
}

let fake: FakeMpm
/** What `rig/import.json` holds (the fake main process does not write it). */
let importJson: unknown = null

function scriptImport(result: ImportJobResult): void {
  importJson = result
  fake.script('import', { events: [{ kind: 'result', payload: result }] })
}

const lastRun = () => fake.runs.at(-1)!
const savedSource = () => (fake.saves.at(-1)!.project as ProjectData).source

/** A project with the kit imported the automatic way. */
async function kitProject(): Promise<void> {
  await createProject('Hero', 'C:/p', yes)
  scriptImport(kit())
  await importModel('D:/models/hero.fbx')
}

/** Markers and a built rig on top of the imported kit. */
function giveRig(): void {
  S().setMarkers(markers())
  S().updateProject((d) => ({ ...d, rig: { kind: 'auto', hash: RIG.hash } }))
  S().setRig(RIG, 'mpm://project/rig/rig.glb?v=1', null)
}

beforeEach(() => {
  fake = installFakeMpm()
  importJson = null
  clipCache.clear()
  useStore.setState(useStore.getInitialState(), true)
  vi.stubGlobal('fetch', async (url: string) => {
    const file = url.split('?')[0]
    if (file === 'mpm://project/rig/rig.json') return new Response(JSON.stringify(RIG))
    if (file === 'mpm://project/rig/import.json' && importJson) return new Response(JSON.stringify(importJson))
    return new Response('', { status: 404 })
  })
  fake.script('convert_weapon', { events: [{ kind: 'result', payload: CONVERTED }] })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('parts list', () => {
  it('offers the objects of a file with more than one; none for one object or an older summary', () => {
    const info = kit()
    expect(partsOf(info).map((p) => p.name)).toEqual(['Body', 'Hat', 'Pistol', 'Pistol_mag'])
    expect(partsOf(info)).toBe(partsOf(info)) // the same list between renders
    expect(partsOf({ all_objects: [info.all_objects![0]] })).toEqual([])
    expect(partsOf(olderSummary())).toEqual([])
    expect(partsOf(null)).toEqual([])
  })

  it('starts from what the import included and is dirty only while a tick differs', () => {
    const parts = partsOf(kit())
    const ticks = includedMap(parts)
    expect(ticks).toEqual(AUTO)
    expect(parts.filter((p) => p.prop).map((p) => p.name)).toEqual(['Pistol', 'Pistol_mag'])
    expect(partsDirty(parts, ticks)).toBe(false)
    const unticked = withTick(ticks, 'Hat', false)
    expect(ticks.Hat).toBe(true) // a new map: the old ticks are untouched
    expect(partsDirty(parts, unticked)).toBe(true)
    expect(partsDirty(parts, withTick(unticked, 'Hat', true))).toBe(false)
    expect(partsDirty(parts, withTick(ticks, 'Pistol', true))).toBe(true)
    expect(partsDirty(parts, {})).toBe(false) // a part without a tick keeps its value
  })

  it('sends a boolean for every object', () => {
    const parts = partsOf(kit())
    expect(partsChoice(parts, withTick(includedMap(parts), 'Hat', false))).toEqual({ Body: true, Hat: false, Pistol: false, Pistol_mag: false })
    expect(partsChoice(parts, { Pistol: true })).toEqual({ Body: true, Hat: true, Pistol: true, Pistol_mag: false })
  })

  it('compares parts choices and the objects two imports kept', () => {
    expect(sameChoice(undefined, undefined)).toBe(true)
    expect(sameChoice(undefined, {})).toBe(true)
    expect(sameChoice(AUTO, { ...AUTO })).toBe(true)
    expect(sameChoice(AUTO, { ...AUTO, Hat: false })).toBe(false)
    expect(sameChoice(undefined, AUTO)).toBe(false)
    expect(sameChoice({ Body: true }, { Hat: true })).toBe(false)
    expect(sameObjects([{ name: 'Body' }, { name: 'Hat' }], [{ name: 'Hat' }, { name: 'Body' }])).toBe(true)
    expect(sameObjects([{ name: 'Body' }, { name: 'Hat' }], [{ name: 'Body' }])).toBe(false)
    expect(sameObjects([{ name: 'Body' }], [{ name: 'Hat' }])).toBe(false)
  })
})

describe('import with a parts choice', () => {
  it('a new model is imported without a choice and none is saved', async () => {
    await kitProject()
    expect(lastRun()).toEqual({ dir: 'C:/p/Hero', type: 'import', args: { file: 'source/hero.fbx' } })
    expect(S().data!.source).toEqual({ file: 'source/hero.fbx', orientation: Z_UP })
    expect(S().importInfo!.all_objects).toHaveLength(4)
    expect(S().importInfo!.props).toEqual([{ file: PISTOL, objects: ['Pistol', 'Pistol_mag'], dims_m: [0.03, 0.184, 0.12] }])
    expect(S().importInfo!.warnings).toEqual(['left out as props: Pistol, Pistol_mag'])
  })

  it('"Apply" sends the whole map with the current orientation, saves it as source.objects and resets rig and markers', async () => {
    await kitProject()
    giveRig()
    const parts = partsOf(S().importInfo)
    const choice = partsChoice(parts, withTick(includedMap(parts), 'Hat', false))
    scriptImport(kit(choice))
    const result = await applyParts(choice)
    expect(lastRun().args).toEqual({
      file: 'source/hero.fbx',
      orientation: Z_UP,
      objects: { Body: true, Hat: false, Pistol: false, Pistol_mag: false }
    })
    expect(result.objects.map((o) => o.name)).toEqual(['Body'])
    expect(S().data!.source).toEqual({ file: 'source/hero.fbx', orientation: Z_UP, objects: choice })
    expect(savedSource()).toEqual(S().data!.source) // and the project was saved with it
    expect(S().dirty).toBe(false)
    // other parts in the character: what was made from the old scene is gone
    expect(S().markers).toBeNull()
    expect(S().data!.rigDraft!.markers).toBeNull()
    expect(S().data!.rig).toBeNull()
    expect(S().rigJson).toBeNull()
    // the list now shows the new state, so "Apply" is off again
    const now = partsOf(S().importInfo)
    expect(includedMap(now)).toEqual(choice)
    expect(partsDirty(now, includedMap(now))).toBe(false)
    expect(S().previewUrl).toMatch(/^mpm:\/\/project\/rig\/preview\.glb\?v=\d+$/)
  })

  it('later imports of the source send the saved choice: a re-run keeps rig and markers, a new orientation drops them', async () => {
    await kitProject()
    const choice: PartsChoice = { ...AUTO, Hat: false }
    scriptImport(kit(choice))
    await applyParts(choice)
    giveRig()
    scriptImport(kit(choice))
    await rerunImport() // "Run the import again"
    expect(lastRun().args).toEqual({ file: 'source/hero.fbx', orientation: Z_UP, objects: choice })
    expect(S().markers).toEqual(markers())
    expect(S().data!.rig).toEqual({ kind: 'auto', hash: RIG.hash })
    expect(S().data!.source!.objects).toEqual(choice)

    const yUp: Orientation = { up: 'Y', forward: '-Z', unit_scale: 0.01 }
    scriptImport(kit(choice, yUp))
    await rerunImport(yUp) // the orientation panel's "Apply"
    expect(lastRun().args).toEqual({ file: 'source/hero.fbx', orientation: yUp, objects: choice })
    expect(S().data!.source).toEqual({ file: 'source/hero.fbx', orientation: yUp, objects: choice })
    expect(S().markers).toBeNull()
    expect(S().data!.rig).toBeNull()
  })

  it('a choice that keeps the same objects in the character keeps rig and markers', async () => {
    await kitProject()
    giveRig()
    scriptImport(kit()) // the automatic result again
    await applyParts({ ...AUTO })
    expect(lastRun().args.objects).toEqual(AUTO)
    expect(S().data!.source!.objects).toEqual(AUTO)
    expect(S().markers).toEqual(markers())
    expect(S().data!.rig).toEqual({ kind: 'auto', hash: RIG.hash })
  })

  it('the map that was sent is a copy: later ticks do not change the saved choice', async () => {
    await kitProject()
    const choice: PartsChoice = { ...AUTO, Hat: false }
    scriptImport(kit(choice))
    await applyParts(choice)
    choice.Hat = true
    expect(S().data!.source!.objects!.Hat).toBe(false)
    expect((lastRun().args.objects as PartsChoice).Hat).toBe(false)
  })

  it('leaving everything out fails with E_NO_MESH and changes nothing', async () => {
    await kitProject()
    giveRig()
    await saveProject()
    const saves = fake.saves.length
    fake.script('import', { events: [{ kind: 'error', payload: { code: 'E_NO_MESH', message: 'no mesh is left in the character', detail: {} } }] })
    const none: PartsChoice = { Body: false, Hat: false, Pistol: false, Pistol_mag: false }
    await expect(applyParts(none)).rejects.toBeInstanceOf(JobError)
    expect(lastRun().args.objects).toEqual(none)
    expect(S().error).toEqual({ code: 'E_NO_MESH', message: 'no mesh is left in the character' })
    expect(S().data!.source).toEqual({ file: 'source/hero.fbx', orientation: Z_UP })
    expect(includedMap(partsOf(S().importInfo))).toEqual(AUTO)
    expect(S().markers).toEqual(markers())
    expect(S().data!.rig).toEqual({ kind: 'auto', hash: RIG.hash })
    expect(fake.saves.length).toBe(saves)
    expect(S().active).toBeNull()
  })

  it('reopening restores the choice and the parts, and the next import sends it', async () => {
    await kitProject()
    const choice: PartsChoice = { ...AUTO, Pistol: true, Pistol_mag: true }
    scriptImport(kit(choice))
    await applyParts(choice)
    expect(S().importInfo!.props).toEqual([])
    expect(closeProject(yes)).toBe(true)
    expect(S().importInfo).toBeNull()

    await openProject('C:/p/Hero', yes)
    expect(S().data!.source).toEqual({ file: 'source/hero.fbx', orientation: Z_UP, objects: choice })
    expect(includedMap(partsOf(S().importInfo))).toEqual(choice) // from rig/import.json
    expect(S().dirty).toBe(false)
    scriptImport(kit(choice))
    await rerunImport()
    expect(lastRun().args).toEqual({ file: 'source/hero.fbx', orientation: Z_UP, objects: choice })
  })

  it('a project whose import summary is older has no parts and no props', async () => {
    await kitProject()
    importJson = { ...olderSummary(), source_file: 'source/hero.fbx' }
    closeProject(yes)
    await openProject('C:/p/Hero', yes)
    expect(S().importInfo!.objects.map((o) => o.name)).toEqual(['Body', 'Hat'])
    expect(S().importInfo!.all_objects).toBeUndefined()
    expect(partsOf(S().importInfo)).toEqual([])
    expect(propRows(S().importInfo, [])).toEqual([])
  })

  it('choosing a new model clears the choice', async () => {
    await kitProject()
    const choice: PartsChoice = { ...AUTO, Hat: false }
    scriptImport(kit(choice))
    await applyParts(choice)
    expect(S().data!.source!.objects).toEqual(choice)
    scriptImport({ ...kit(), source_file: 'source/other.fbx' } as ImportJobResult)
    await importModel('D:/models/other.fbx')
    expect(lastRun().args).toEqual({ file: 'source/other.fbx' })
    expect(S().data!.source).toEqual({ file: 'source/other.fbx', orientation: Z_UP })
    expect(savedSource()).toEqual({ file: 'source/other.fbx', orientation: Z_UP })
  })
})

describe('props as weapons', () => {
  it('lists each left-out prop with its objects and its longest side in cm', () => {
    const rows = propRows(kit(), [])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ file: PISTOL, objects: ['Pistol', 'Pistol_mag'], added: false })
    expect(rows[0].longestCm).toBeCloseTo(18.4, 9)
    expect(propRows(kit({ ...AUTO, Pistol: true, Pistol_mag: true }), [])).toEqual([])
    expect(propRows(null, [])).toEqual([])
  })

  it('"Add as weapon" converts the prop where it is and goes on like "Add weapon"', async () => {
    await kitProject()
    giveRig()
    const copy = vi.spyOn(fake.api.project, 'addWeapon')
    expect(propRows(S().importInfo, S().weapons)[0].added).toBe(false)
    const w = await addPropWeapon(PISTOL)
    expect(lastRun()).toEqual({ dir: 'C:/p/Hero', type: 'convert_weapon', args: { file: PISTOL } })
    expect(copy).not.toHaveBeenCalled() // the file is already inside the project
    expect(w).toEqual({
      id: 'w1',
      file: 'weapons/Pistol.glb',
      source: PISTOL,
      unit_scale: 1,
      attach_bone: 'grip.R',
      offset: S().weapons[0].offset,
      support: { enabled: false, side: 'L', point: [0, 0, 0], normal: [-1, 0, 0], axis: [0, 1, 0] },
      merge: true
    })
    expect(w.offset.s).toBe(1)
    expect(S().weapons).toEqual([w])
    expect(S().weaponSelection).toBe('w1')
    expect(S().weaponInfo.w1).toEqual(CONVERTED)
    expect(S().undo.length).toBe(1) // one step of the history, like any weapon change
    expect((fake.saves.at(-1)!.project as ProjectData).weapons).toEqual([w])
    expect(S().dirty).toBe(false)
    expect(S().active).toBeNull()
    // the row now says "added"
    expect(propRows(S().importInfo, S().weapons)[0]).toMatchObject({ file: PISTOL, added: true })
  })

  it('takes the free hand socket and stays "added" after the project is reopened', async () => {
    await kitProject()
    giveRig()
    await saveProject()
    const first = await addWeapon('D:/weapons/handle.fbx')
    expect(first.attach_bone).toBe('grip.R')
    expect(propRows(S().importInfo, S().weapons)[0].added).toBe(false) // another weapon's source
    const w = await addPropWeapon(PISTOL)
    expect(w).toMatchObject({ id: 'w2', attach_bone: 'grip.L', source: PISTOL, support: { side: 'R' } })
    closeProject(yes)
    await openProject('C:/p/Hero', yes)
    expect(S().weapons.map((x) => x.source)).toEqual(['weapons/x/x.glb', PISTOL])
    expect(propRows(S().importInfo, S().weapons)[0].added).toBe(true)
  })

  it('a failed conversion adds nothing', async () => {
    await kitProject()
    giveRig()
    fake.script('convert_weapon', { events: [{ kind: 'error', payload: { code: 'E_IO', message: 'props/Pistol.glb not found', detail: {} } }] })
    await expect(addPropWeapon(PISTOL)).rejects.toBeInstanceOf(JobError)
    expect(S().weapons).toEqual([])
    expect(S().error).toEqual({ code: 'E_IO', message: 'props/Pistol.glb not found' })
    expect(propRows(S().importInfo, S().weapons)[0].added).toBe(false)
  })
})

describe('"Find joints" warnings', () => {
  const WARNINGS = [
    'hand R: fingers not found (hand too small); mirrored from the left hand - check them',
    'hand L: ring finger followed only part of the way (fingers touching); knuckle estimated',
    'feet: toes not found; estimated from the ankles'
  ]

  it('knows which hand a warning is about', () => {
    expect(WARNINGS.map(warningHand)).toEqual(['R', 'L', null])
    expect(warningHand('hand R')).toBe('R')
    expect(warningHand('hand Left: x')).toBeNull()
    expect(warningHand('the hand L: x')).toBeNull()
    expect(warningHand('Hand L: x')).toBeNull()
  })

  it('the Rig step lists every warning of the job; a hand warning zooms to that hand', async () => {
    await createProject('Hero', 'C:/p', yes)
    fake.script('suggest_markers', { events: [{ kind: 'result', payload: { markers: markers(), warnings: WARNINGS } satisfies SuggestMarkersResult }] })
    await findJoints()
    expect(S().markerWarnings).toEqual(WARNINGS)
    const side = warningHand(S().markerWarnings[0])!
    zoomToHand(side)
    const focus = S().focus!
    // three.js frame: Blender (x, y, z) -> (x, z, -y); the centre of wrist_R, index_0_R and index_tip_R
    expect(focus.center[0]).toBeCloseTo(-0.78, 9)
    expect(focus.center[1]).toBeCloseTo(1.4, 9)
    expect(focus.radius).toBeGreaterThan(0.08)
    expect(focus.radius).toBeLessThan(0.2)
    // a new "Find joints" replaces the list
    fake.script('suggest_markers', { events: [{ kind: 'result', payload: { markers: markers(), warnings: [] } }] })
    await findJoints()
    expect(S().markerWarnings).toEqual([])
  })
})

describe('e2e hook', () => {
  const hook = (): MpmTestHook => (globalThis as unknown as { window: { __mpmTest: MpmTestHook } }).window.__mpmTest

  it('importModel passes the parts choice; state().import reports all_objects and props', async () => {
    installTestHook()
    await hook().newProject('C:/p', 'Hero')
    const choice: PartsChoice = { ...AUTO, Hat: false }
    scriptImport(kit(choice))
    const state = await hook().importModel('D:/models/hero.fbx', choice)
    expect(lastRun().args).toEqual({ file: 'source/hero.fbx', objects: choice })
    expect(state.step).toBe('import')
    expect(state.project!.source).toEqual({ file: 'source/hero.fbx', orientation: Z_UP, objects: choice })
    expect(state.import!.objects).toBe(1)
    expect(state.import!.all_objects).toEqual(kit(choice).all_objects)
    expect(state.import!.props).toEqual([{ file: PISTOL, objects: ['Pistol', 'Pistol_mag'], dims_m: [0.03, 0.184, 0.12] }])
    expect(state.import!.warnings).toEqual(['left out as props: Pistol, Pistol_mag'])
    expect(hook().state().import).toEqual(state.import)
  })

  it('importModel without a choice sends none; an older summary reports null for the new fields', async () => {
    installTestHook()
    await hook().newProject('C:/p', 'Hero')
    scriptImport(olderSummary())
    const state = await hook().importModel('D:/models/hero.fbx')
    expect(lastRun().args).toEqual({ file: 'source/hero.fbx' })
    expect(state.project!.source).toEqual({ file: 'source/hero.fbx', orientation: Z_UP })
    expect(state.import!.all_objects).toBeNull()
    expect(state.import!.props).toBeNull()
  })

  it('addPropWeapon runs the prop flow', async () => {
    installTestHook()
    await hook().newProject('C:/p', 'Hero')
    scriptImport(kit())
    await hook().importModel('D:/models/hero.fbx')
    giveRig()
    const w = await hook().addPropWeapon(PISTOL)
    expect(lastRun()).toMatchObject({ type: 'convert_weapon', args: { file: PISTOL } })
    expect(w).toMatchObject({ id: 'w1', file: 'weapons/Pistol.glb', source: PISTOL })
    expect(hook().state().weapons).toEqual([w])
  })
})
