// SPDX-License-Identifier: GPL-3.0-or-later
// WP9 flows against a fake window.mpm: one history for pose, hands and weapons; project save/load of
// hands and weapons; the weapon and hand flows; auto-grip through the store; the bake job call.
import { CylinderGeometry, Group, Matrix4, Mesh, Vector3 } from 'three'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { projectUrl } from '../../../src/renderer/lib/paths'
import { useStore } from '../../../src/renderer/store'
import { closeProject, createProject, openProject, saveProject } from '../../../src/renderer/store/actions'
import { runBake } from '../../../src/renderer/store/exportActions'
import { choosePreset, commitHand, copyHandSide, previewHand, resetHand, runAutoGrip, setFingerKeep } from '../../../src/renderer/store/handActions'
import { clipCache, commitReach, commitRotate, currentPose, currentPoseState, redoPose, undoPose } from '../../../src/renderer/store/poseActions'
import {
  addWeapon,
  removeWeapon,
  setAttachSide,
  setGripPoint,
  setPrintSeparately,
  setSupport,
  setTwoHanded,
  setWeaponScale,
  setWeaponUnits
} from '../../../src/renderer/store/weaponActions'
import { setWeaponScene } from '../../../src/renderer/viewer/weaponView'
import type { ConvertWeaponResult } from '../../../src/shared/jobResults'
import { FINGERS } from '../../../src/shared/handPose'
import type { ProjectData } from '../../../src/shared/project'
import { attachFrame, weaponMatrix } from '../../../src/shared/weaponPose'
import { autoRig } from '../helpers/skeletonRig'
import { installFakeMpm, type FakeMpm } from './fakeMpm'

const RIG = autoRig()
const S = () => useStore.getState()
const yes = () => true

// A 30 cm handle along the weapon's Z axis, 14 mm radius (what convert_weapon would report).
const CONVERTED: ConvertWeaponResult = {
  weapon_glb: 'weapons/handle.glb',
  objects: ['Handle'],
  tri_count: 96,
  bbox_m: [
    [-0.014, -0.014, -0.15],
    [0.014, 0.014, 0.15]
  ],
  dims_m: [0.028, 0.028, 0.3],
  principal_axis: [0, 0, 1],
  normal_maps: [],
  unit_scale_used: 1,
  suggested_unit_scale: 1,
  warnings: []
}

let fake: FakeMpm

async function riggedProject(): Promise<void> {
  await createProject('Hero', 'C:/p', yes)
  S().updateProject((d) => ({ ...d, rig: { kind: 'auto', hash: RIG.hash } }))
  S().setRig(RIG, 'mpm://project/rig/rig.glb?v=1', null)
  await saveProject()
}

beforeEach(() => {
  fake = installFakeMpm()
  clipCache.clear()
  useStore.setState(useStore.getInitialState(), true)
  vi.stubGlobal('fetch', async (url: string) =>
    url.split('?')[0] === 'mpm://project/rig/rig.json' ? new Response(JSON.stringify(RIG)) : new Response('', { status: 404 })
  )
  fake.script('convert_weapon', { events: [{ kind: 'result', payload: CONVERTED }] })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('one history', () => {
  it('bone edits, hand poses and weapon changes undo and redo in one stack', async () => {
    await riggedProject()
    commitRotate('spine', [Math.cos(0.1), 0, 0, Math.sin(0.1)], true)
    choosePreset('R', 'fist')
    await addWeapon('D:/weapons/handle.fbx')
    setWeaponScale('w1', 2)
    expect(S().undo.length).toBe(4)
    undoPose()
    expect(S().weapons[0].offset.s).toBe(1)
    undoPose()
    expect(S().weapons).toHaveLength(0)
    undoPose()
    expect(S().hands.R).toBeNull()
    expect(S().poseInputs.edits).toHaveLength(1)
    undoPose()
    expect(S().poseInputs.edits).toHaveLength(0)
    redoPose()
    redoPose()
    expect(S().hands.R?.name).toBe('fist')
    expect(S().poseInputs.edits).toHaveLength(1)
  })

  it('a slider preview does not commit; the release is one step', async () => {
    await riggedProject()
    choosePreset('R', 'relaxed')
    const steps = S().undo.length
    const pose = { ...S().hands.R!, fingers: { ...S().hands.R!.fingers, index: { flex: [50, 60, 40] as [number, number, number], spread: 0 } } }
    previewHand('R', pose)
    expect(S().undo.length).toBe(steps)
    expect(S().hands.R!.fingers.index.flex).toEqual([15, 20, 10])
    expect(currentPose()!.deltas).not.toEqual(currentPose(false)!.deltas)
    commitHand('R', pose)
    expect(S().undo.length).toBe(steps + 1)
    expect(S().posePreview).toBeNull()
    expect(S().hands.R!.fingers.index.flex).toEqual([50, 60, 40])
  })

  it('save writes pose (with weapons and hands), hands and weapons; reopening restores them', async () => {
    await riggedProject()
    commitReach('R', [-0.03, -0.3, 1.2])
    await addWeapon('D:/weapons/handle.fbx')
    setSupport('w1', { point: [0, 0, -0.06], normal: [-1, 0, 0], axis: [0, 0, 1] })
    choosePreset('L', 'grip')
    setFingerKeep('L', 'index', true)
    await saveProject()
    const saved = fake.saves.at(-1)!.project as ProjectData
    expect(saved.weapons).toEqual(S().weapons)
    expect(saved.hands).toEqual({ L: S().hands.L, R: null, locked: { L: ['index'], R: [] } })
    expect(saved.pose!.deltas).toEqual(currentPoseState()!.deltas)
    // the saved deltas include the two-hand IK: the left socket sits on the support point of the weapon
    // as the pose places it (composePose weaponMatrices; "both" mode turns it towards the left hand)
    const W = new Matrix4().fromArray(currentPose(false)!.weaponMatrices.w1)
    const target = new Vector3(0, 0, -0.06).applyMatrix4(W)
    const socket = new Vector3().setFromMatrixPosition(attachFrame(RIG, saved.pose!.deltas, 'grip.L')!)
    expect(currentPose()!.supportShort.w1).toBeLessThan(1e-6)
    expect(socket.distanceTo(target)).toBeLessThan(1e-4)

    closeProject(yes)
    expect(S().weapons).toEqual([])
    await openProject('C:/p/Hero', yes)
    const json = (v: unknown) => JSON.parse(JSON.stringify(v)) // the file has no -0
    expect(S().weapons).toEqual(json(saved.weapons))
    expect(S().hands.L).toEqual(saved.hands!.L)
    expect(S().hands.locked.L).toEqual(['index'])
    expect(S().undo.length).toBe(0)
    expect(json(currentPoseState()!.deltas)).toEqual(json(saved.pose!.deltas))
  })
})

describe('weapon flows', () => {
  it('adds a weapon on a free socket with the default placement', async () => {
    await riggedProject()
    const w = await addWeapon('D:/weapons/handle.fbx')
    expect(fake.runs.at(-1)).toMatchObject({ type: 'convert_weapon', args: { file: 'weapons/x/x.glb' } })
    expect(w).toMatchObject({
      id: 'w1',
      file: 'weapons/handle.glb',
      source: 'weapons/x/x.glb',
      unit_scale: 1,
      attach_bone: 'grip.R',
      merge: true,
      support: { enabled: false, side: 'L' }
    })
    expect(S().weaponSelection).toBe('w1')
    expect(S().weaponInfo.w1.principal_axis).toEqual([0, 0, 1])
    // the bbox centre sits on the socket
    const d = currentPose()!.deltas
    const centre = new Vector3(0, 0, 0).applyMatrix4(weaponMatrix(RIG, d, w)!)
    expect(centre.distanceTo(new Vector3().setFromMatrixPosition(attachFrame(RIG, d, 'grip.R')!))).toBeLessThan(1e-9)
    const second = await addWeapon('D:/weapons/handle.fbx')
    expect(second.id).toBe('w2')
    expect(second.attach_bone).toBe('grip.L')
    expect(second.support?.side).toBe('R')
  })

  it('grip point, scale, hand, two-handed, print separately, remove', async () => {
    await riggedProject()
    await addWeapon('D:/weapons/handle.fbx')
    setGripPoint('w1', [0, 0, 0.1])
    let w = S().weapons[0]
    const d = currentPose()!.deltas
    const gp = new Vector3(0, 0, 0.1).applyMatrix4(weaponMatrix(RIG, d, w)!)
    expect(gp.distanceTo(new Vector3().setFromMatrixPosition(attachFrame(RIG, d, 'grip.R')!))).toBeLessThan(1e-9)
    setWeaponScale('w1', 9)
    expect(S().weapons[0].offset.s).toBe(4)
    setWeaponScale('w1', 0.01)
    expect(S().weapons[0].offset.s).toBe(0.25)
    setTwoHanded('w1', true)
    expect(S().weapons[0].support).toMatchObject({ enabled: true, side: 'L' })
    expect(currentPose()!.supportShort.w1).toBeGreaterThan(0) // the left hand can't reach a weapon hanging at the side
    setAttachSide('w1', 'L')
    w = S().weapons[0]
    expect(w.attach_bone).toBe('grip.L')
    expect(w.support?.side).toBe('R')
    setPrintSeparately('w1', true)
    expect(S().weapons[0].merge).toBe(false)
    expect(removeWeapon('w1', () => false)).toBe(false)
    expect(removeWeapon('w1', yes)).toBe(true)
    expect(S().weapons).toEqual([])
  })
})

describe('weapon units', () => {
  it('Units converts the recorded source again, also after the project was reopened', async () => {
    await riggedProject()
    await addWeapon('D:/weapons/handle.fbx')
    setGripPoint('w1', [0, 0, 0.1])
    setSupport('w1', { point: [0, 0, -0.06], normal: [-1, 0, 0], axis: [0, 0, 1] })
    await saveProject()
    closeProject(yes)
    await openProject('C:/p/Hero', yes)
    expect(S().weaponInfo.w1).toBeUndefined() // nothing from the session that added it
    const before = S().weapons[0]
    fake.script('convert_weapon', { events: [{ kind: 'result', payload: { ...CONVERTED, unit_scale_used: 0.01 } }] })
    await setWeaponUnits('w1', 0.01)
    expect(fake.runs.at(-1)).toMatchObject({ type: 'convert_weapon', args: { file: 'weapons/x/x.glb', unit_scale: 0.01, out: 'weapons/handle.glb' } })
    const after = S().weapons[0]
    expect(after.unit_scale).toBe(0.01)
    after.offset.t.forEach((v, k) => expect(v).toBeCloseTo(before.offset.t[k] * 0.01, 12))
    after.support!.point.forEach((v, k) => expect(v).toBeCloseTo(before.support!.point[k] * 0.01, 12))
    expect(S().weaponVersion.w1).toBeGreaterThan(0)
  })

  it('an older entry without source keeps Units unavailable', async () => {
    await riggedProject()
    await addWeapon('D:/weapons/handle.fbx')
    S().setWeapons(S().weapons.map(({ source: _s, unit_scale: _u, ...w }) => w))
    await expect(setWeaponUnits('w1', 0.01)).rejects.toThrow(/older version/)
  })
})

describe('hand flows', () => {
  it('presets set the keep list; copy and reset', async () => {
    await riggedProject()
    choosePreset('R', 'rifle_trigger_off')
    expect(S().hands.locked.R).toEqual(['index'])
    expect(S().hands.R!.name).toBe('rifle_trigger_off')
    copyHandSide('R')
    expect(S().hands.L).toEqual(S().hands.R)
    expect(S().hands.locked.L).toEqual(['index'])
    resetHand('R')
    expect(S().hands.R).toBeNull()
    expect(S().hands.locked.R).toEqual([])
  })

  it('auto-grip closes the hand that holds the weapon (one undo step) and reports every finger', async () => {
    await riggedProject()
    commitReach('R', [-0.03, -0.3, 1.2])
    await addWeapon('D:/weapons/handle.fbx')
    // the weapon GLB the viewer would show: the handle in three.js coordinates (Blender Z = three Y)
    const scene = new Group()
    scene.add(new Mesh(new CylinderGeometry(0.014, 0.014, 0.3, 24)))
    setWeaponScene('w1', projectUrl('weapons/handle.glb'), scene)
    choosePreset('R', 'sword')
    const steps = S().undo.length
    const r = await runAutoGrip('R')
    expect(S().undo.length).toBe(steps + 1)
    expect(S().hands.R).toEqual(r.pose)
    for (const f of FINGERS) expect(r.fingers[f].touching || r.fingers[f].maxed).toBe(true)
    expect(S().gripReport.R?.fingers.index).toEqual(r.fingers.index)
    expect(S().gripReport.R!.ms).toBeGreaterThan(0)
    await expect(runAutoGrip('L')).rejects.toThrow(/Attach a weapon/)
  })
})

describe('bake', () => {
  it('saves, then runs the bake job with the pose state, hands, weapons and settings', async () => {
    await riggedProject()
    await addWeapon('D:/weapons/handle.fbx')
    S().updateBake({ scale: { mode: 'height_mm', height_mm: 32 } })
    expect(S().data!.bake!.scale).toEqual({ mode: 'height_mm', height_mm: 32 })
    expect(S().dirty).toBe(true)
    const result = {
      stl: 'exports/Hero.stl',
      preview_glb: 'exports/Hero_preview.glb',
      report: { name: 'Hero', final_dims_mm: [10, 8, 32], tris: 1000, stl: 'exports/Hero.stl', stl_mb: 0.1, thin_area_pct: 1, min_thickness_mm: 0.6, pieces: 1, seconds: 3, summary: 'Hero' },
      weapons: [],
      gates: { follow: { moved_fraction: 0.4, worst_drift: 0.001, grow: 1 }, posed: true, faces: 1000, levels_lowered: 0, voxel_coarsened_to: null },
      detail: {},
      unit_mm: 17.6,
      standing_mm: 32,
      weights_transferred: [],
      seconds: 5
    }
    fake.script('bake', { events: [{ kind: 'result', payload: result }] })
    await runBake()
    const run = fake.runs.at(-1)!
    expect(run.type).toBe('bake')
    expect(run.args.name).toBe('Hero')
    expect(Object.keys((run.args.pose as { deltas: object }).deltas)).toHaveLength(RIG.bones.length)
    // each weapon carries its transform for the pose (composePose weaponMatrices)
    const matrices = currentPose(false)!.weaponMatrices
    expect(run.args.weapons).toEqual(S().weapons.map((w) => ({ ...w, matrix: matrices[w.id] })))
    expect((run.args.weapons as { matrix: number[] }[])[0].matrix).toHaveLength(16)
    expect((run.args.bake as { scale: unknown }).scale).toEqual({ mode: 'height_mm', height_mm: 32 })
    expect(S().dirty).toBe(false) // saved before baking
    expect(S().bakeResult?.stl).toBe('exports/Hero.stl')
    expect(S().showBaked).toBe(true)
  })
})
