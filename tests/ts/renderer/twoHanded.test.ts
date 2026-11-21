// SPDX-License-Identifier: GPL-3.0-or-later
// Step order (Import, Rig, Weapons, Hands, Pose, Export); two-handed weapons in the store (held with,
// both grips, what the weapon follows); the setup stance of the Weapons and Hands steps (shown and used by
// auto-grip, never stored); weapons drawn and baked from composePose weaponMatrices; arm edits after a
// clip (the user's report); the status bar's update offer.
import { CylinderGeometry, Group, Matrix4, Mesh, Quaternion, Vector3 } from 'three'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { projectUrl } from '../../../src/renderer/lib/paths'
import { updateOffer } from '../../../src/renderer/lib/update'
import { supportArmNote } from '../../../src/renderer/lib/weapons'
import { REST_INPUTS, setupInputs, showsSetupStance } from '../../../src/renderer/lib/pose'
import { useStore } from '../../../src/renderer/store'
import { createProject, openingStep, saveProject } from '../../../src/renderer/store/actions'
import { runBake } from '../../../src/renderer/store/exportActions'
import { choosePreset, runAutoGrip } from '../../../src/renderer/store/handActions'
import { clipCache, commitRotate, currentPose, currentPoseState, displayPose, selectClip } from '../../../src/renderer/store/poseActions'
import { STEPS } from '../../../src/renderer/store/ui'
import {
  addWeapon,
  gripToolFor,
  setAttachSide,
  setFollowMode,
  setGripPoint,
  setSupportGrip,
  setTwoHanded
} from '../../../src/renderer/store/weaponActions'
import { setWeaponScene } from '../../../src/renderer/viewer/weaponView'
import type { ClipFrame, PackClip, PackIndex } from '../../../src/shared/clip'
import { writeClipF32 } from '../../../src/shared/clip'
import type { QuatWXYZ } from '../../../src/shared/coords'
import type { Deltas } from '../../../src/shared/fk'
import { canonicalIndex, posedJoints, resolveDeltas } from '../../../src/shared/fk'
import type { ConvertWeaponResult } from '../../../src/shared/jobResults'
import { mul, q4, rotBetween, v3, wxyz } from '../../../src/shared/math'
import type { ProjectData, WeaponEntry } from '../../../src/shared/project'
import type { RigJson } from '../../../src/shared/rig'
import { attachFrame, holdingStance, mainGripPoint, type WeaponSupport } from '../../../src/shared/weaponPose'
import { autoRig } from '../helpers/skeletonRig'
import { installFakeMpm, type FakeMpm } from './fakeMpm'

const RIG = autoRig()
const ci = canonicalIndex(RIG)
const idx = (n: string): number => ci.get(n) as number
const S = () => useStore.getState()
const yes = () => true
const rot = (axis: [number, number, number], deg: number): QuatWXYZ =>
  wxyz(new Quaternion().setFromAxisAngle(new Vector3(...axis).normalize(), (deg * Math.PI) / 180))

// A 60 cm handle along the weapon's Z axis (a two-handed sword's grip and blade, as convert_weapon reports).
const CONVERTED: ConvertWeaponResult = {
  weapon_glb: 'weapons/long.glb',
  objects: ['Long'],
  tri_count: 96,
  bbox_m: [
    [-0.014, -0.014, -0.3],
    [0.014, 0.014, 0.3]
  ],
  dims_m: [0.028, 0.028, 0.6],
  principal_axis: [0, 0, 1],
  normal_maps: [],
  unit_scale_used: 1,
  suggested_unit_scale: 1,
  warnings: []
}

// A clip on the standard rig (as in pose.test.ts): the left arm rises, the right forearm is bent.
function frameFromPose(rig: RigJson, deltas: Deltas): ClipFrame {
  const J = posedJoints(rig, deltas)
  const joints: ClipFrame['joints'] = {}
  for (const [k, v] of Object.entries(J)) joints[k] = [v.x, v.y, v.z]
  const res = resolveDeltas(rig, deltas)
  const D = (name: string): Quaternion => q4(res[String(idx(name))])
  const r: ClipFrame['rot'] = { head: wxyz(D('head')), ankle_L: wxyz(D('foot.L')), ankle_R: wxyz(D('foot.R')) }
  for (const s of ['L', 'R'] as const) r[`wrist_${s}`] = wxyz(mul(D(`hand.${s}`), rotBetween(new Vector3(0, 0, -1), v3(rig.hands[s]!.palm_normal))))
  return { joints, rot: r, contacts: { L: true, R: true } }
}
const JOINTS = Object.keys(posedJoints(RIG, {}))
const FRAMES = Array.from({ length: 10 }, (_v, f) =>
  frameFromPose(RIG, { [String(idx('upper_arm.L'))]: rot([0, -1, 0], f * 5), [String(idx('forearm.R'))]: rot([1, 0, 0], 30) })
)
const CLIP_BUF = writeClipF32(FRAMES, JOINTS)
const CLIP: PackClip = { id: 'wave', move: 'wave', style: 'normal', tags: [], frames: 10, fps: 15, key_frames: [5] }
const INDEX: PackIndex = {
  schema: 'mpm.pack/1',
  pack: 'mine',
  title: 'My clips',
  license: 'Your own',
  license_url: '',
  exportable: true,
  joints: JOINTS,
  has_fingers: false,
  clips: [CLIP]
}

let fake: FakeMpm

async function riggedProject(): Promise<void> {
  await createProject('Hero', 'C:/p', yes)
  S().updateProject((d) => ({ ...d, rig: { kind: 'auto', hash: RIG.hash } }))
  S().setRig(RIG, 'mpm://project/rig/rig.glb?v=1', null)
  await saveProject()
}

/** The long weapon in the right hand, held with both hands: right grip 10 cm below the centre, left 15 cm further down. */
async function twoHandedWeapon(): Promise<WeaponEntry> {
  await addWeapon('D:/weapons/long.fbx')
  setGripPoint('w1', [0, 0, -0.1])
  setTwoHanded('w1', true)
  setSupportGrip('w1', [0, 0, -0.25], [1, 0, 0], [0, 0, 1])
  return S().weapons[0]
}

const maxDiff = (a: number[], b: number[]): number => Math.max(...a.map((x, k) => Math.abs(x - b[k])))

beforeEach(() => {
  fake = installFakeMpm()
  clipCache.clear()
  useStore.setState(useStore.getInitialState(), true)
  vi.stubGlobal('fetch', async (url: string) => {
    const u = url.split('?')[0]
    if (u === 'mpm://project/rig/rig.json') return new Response(JSON.stringify(RIG))
    if (u === 'mpm://library/packs/mine/index.json') return new Response(JSON.stringify(INDEX))
    if (u === 'mpm://library/packs/mine/clips/wave.f32') return new Response(CLIP_BUF.slice(0))
    return new Response('not found', { status: 404 })
  })
  fake.script('convert_weapon', { events: [{ kind: 'result', payload: CONVERTED }] })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('step order', () => {
  it('is Import, Rig, Weapons, Hands, Pose, Export', () => {
    expect([...STEPS]).toEqual(['import', 'rig', 'weapons', 'hands', 'pose', 'export'])
    expect(showsSetupStance('weapons')).toBe(true)
    expect(showsSetupStance('hands')).toBe(true)
    expect(showsSetupStance('pose')).toBe(false)
  })

  it('a project opens on the furthest step started', () => {
    const base = { schemaVersion: 1 } as ProjectData
    const rig = { kind: 'auto' as const, hash: 'h' }
    const pose = (clip: string | null, edits: unknown[] = []) =>
      ({ provenance: { pack: clip ? 'mine' : null, clip, frame: clip ? 0 : null, mirrored: false, planted: true, edits } }) as unknown as ProjectData['pose']
    const weapon = { id: 'w1' } as WeaponEntry
    expect(openingStep(base)).toBe('import')
    expect(openingStep({ ...base, rig })).toBe('rig')
    expect(openingStep({ ...base, rig, weapons: [weapon], pose: pose(null) })).toBe('weapons')
    expect(openingStep({ ...base, rig, weapons: [weapon], pose: pose('wave') })).toBe('pose')
    expect(openingStep({ ...base, rig, pose: pose(null) })).toBe('pose')
  })
})

describe('two-handed weapons', () => {
  it('held with two hands: both grips, either hand as the main hand, and what the weapon follows', async () => {
    await riggedProject()
    const w = await twoHandedWeapon()
    expect(w.support).toMatchObject({ enabled: true, side: 'L', point: [0, 0, -0.25] })
    // the main-hand tool is the grip point, the other hand's is the support grip
    expect(gripToolFor(w, 'R')).toBe('grip')
    expect(gripToolFor(w, 'L')).toBe('support')
    // "both" by default (no mode stored); "the main hand only" is "reach", kept by a new support grip
    expect((w.support as WeaponSupport).mode ?? 'both').toBe('both')
    setFollowMode('w1', 'reach')
    setSupportGrip('w1', [0, 0, -0.26], [1, 0, 0], [0, 0, 1])
    expect((S().weapons[0].support as WeaponSupport).mode).toBe('reach')
    // the left hand as the main hand swaps the tools
    setAttachSide('w1', 'L')
    expect(S().weapons[0].support?.side).toBe('R')
    expect(gripToolFor(S().weapons[0], 'L')).toBe('grip')
    expect(gripToolFor(S().weapons[0], 'R')).toBe('support')
  })

  it('the Weapons and Hands steps show the holding stance, which never reaches the stored pose', async () => {
    await riggedProject()
    await addWeapon('D:/weapons/long.fbx')
    // one-handed: the rest pose
    expect(setupInputs(RIG, S().weapons)).toBe(REST_INPUTS)
    await twoHandedWeapon()
    const stance = setupInputs(RIG, S().weapons)
    expect(stance).toBe(setupInputs(RIG, S().weapons)) // same object: memoised compositions
    expect(stance.edits).toEqual(holdingStance(RIG, 'R').map((h) => ({ kind: 'reach', side: h.side, target: h.target })))
    S().setStep('weapons')
    const shown = displayPose(false)!
    const stored = currentPose(false)!
    expect(shown.deltas).not.toEqual(stored.deltas)
    // both hands in front of the body, the left hand on its grip
    expect(shown.supportShort.w1).toBeLessThan(1e-6)
    const W = new Matrix4().fromArray(shown.weaponMatrices.w1)
    const leftGrip = new Vector3(0, 0, -0.25).applyMatrix4(W)
    expect(posedJoints(RIG, shown.deltas).wrist_L.distanceTo(leftGrip)).toBeLessThan(0.15)
    // nothing of it is stored: the user's pose has no edits and the saved pose is the rest pose + IK
    expect(S().poseInputs.edits).toEqual([])
    await saveProject()
    const saved = fake.saves.at(-1)!.project as ProjectData
    expect(saved.pose!.provenance.edits).toEqual([])
    expect(saved.pose!.deltas).toEqual(currentPoseState()!.deltas)
    S().setStep('pose')
    expect(displayPose(false)).toBe(currentPose(false))
  })

  it('auto-grip runs in the stance, on the weapon as composePose places it', async () => {
    await riggedProject()
    await twoHandedWeapon()
    const scene = new Group()
    const long = new Mesh(new CylinderGeometry(0.014, 0.014, 0.6, 24)) // three Y = weapon Z
    scene.add(long)
    setWeaponScene('w1', projectUrl('weapons/long.glb'), scene)
    S().setStep('hands')
    choosePreset('L', 'sword')
    const r = await runAutoGrip('L')
    // the support hand closes on the long handle in the stance
    expect(Object.values(r.fingers).some((f) => f.touching)).toBe(true)
    expect(S().poseInputs.edits).toEqual([])
  })

  it('the bake gets each weapon with its matrix for the final pose', async () => {
    await riggedProject()
    await twoHandedWeapon()
    commitRotate('upper_arm.R', rot([1, 0, 0], -40), true)
    fake.script('bake', { events: [{ kind: 'result', payload: { stl: 'exports/Hero.stl', preview_glb: 'exports/p.glb', report: {}, weapons: [], gates: {} } }] })
    S().setStep('export')
    await runBake().catch(() => null)
    const run = fake.runs.find((x) => x.type === 'bake')!
    const sent = (run.args.weapons as (WeaponEntry & { matrix: number[] })[])[0]
    expect(maxDiff(sent.matrix, currentPose(false)!.weaponMatrices.w1)).toBe(0)
    // the final pose, not the setup stance
    S().setStep('weapons')
    expect(maxDiff(sent.matrix, displayPose(false)!.weaponMatrices.w1)).toBeGreaterThan(1e-3)
  })
})

describe('arm edits after a clip (the Pose step report)', () => {
  it('rotating upper_arm.R after selecting a clip moves the posed wrist', async () => {
    await riggedProject()
    await selectClip('mine', 'wave')
    expect(S().poseInputs.source?.clip).toBe('wave')
    for (const chain of [true, false]) {
      const before = posedJoints(RIG, currentPose(false)!.deltas).wrist_R.clone()
      commitRotate('upper_arm.R', rot([1, 0, 0], 25), chain)
      const after = posedJoints(RIG, currentPose(false)!.deltas).wrist_R
      expect(before.distanceTo(after)).toBeGreaterThan(0.05)
      S().selectBone(null) // the next drag is a new edit
    }
    expect(S().poseInputs.edits).toHaveLength(2)
  })

  it('with a two-handed weapon: the main arm carries it, and turning the support arm turns it ("both")', async () => {
    await riggedProject()
    await twoHandedWeapon()
    await selectClip('mine', 'wave')
    S().setStep('pose')
    const w0 = currentPose(false)!.weaponMatrices.w1
    const wristR0 = posedJoints(RIG, currentPose(false)!.deltas).wrist_R.clone()
    commitRotate('upper_arm.R', rot([1, 0, 0], 25), true)
    const p1 = currentPose(false)!
    expect(posedJoints(RIG, p1.deltas).wrist_R.distanceTo(wristR0)).toBeGreaterThan(0.05)
    expect(maxDiff(p1.weaponMatrices.w1, w0)).toBeGreaterThan(1e-3)
    // the main grip stays on the right hand's socket
    const W1 = new Matrix4().fromArray(p1.weaponMatrices.w1)
    const socket = new Vector3().setFromMatrixPosition(attachFrame(RIG, p1.deltas, 'grip.R')!)
    expect(mainGripPoint(S().weapons[0]).applyMatrix4(W1).distanceTo(socket)).toBeLessThan(1e-6)
    // the support arm: turning it turns the weapon (it points at where the arm puts the hand)
    S().selectBone(null)
    commitRotate('upper_arm.L', rot([0, 1, 0], 30), true)
    const p2 = currentPose(false)!
    const dir = (m: number[]) => new Vector3(0, 0, -1).transformDirection(new Matrix4().fromArray(m))
    expect(dir(p2.weaponMatrices.w1).angleTo(dir(p1.weaponMatrices.w1))).toBeGreaterThan(0.02)
    // "the main hand only": the support arm no longer turns it
    setFollowMode('w1', 'reach')
    const p3 = currentPose(false)!
    S().selectBone(null)
    commitRotate('upper_arm.L', rot([0, 1, 0], 20), true)
    expect(maxDiff(currentPose(false)!.weaponMatrices.w1, p3.weaponMatrices.w1)).toBeLessThan(1e-9)
  })

  it('the Pose step explains the support arm', () => {
    const w = { id: 'w1', file: 'weapons/long.glb', attach_bone: 'grip.R', support: { enabled: true, side: 'L' } } as WeaponEntry
    expect(supportArmNote('upper_arm.L', [w])).toMatch(/turning the arm turns the weapon/)
    expect(supportArmNote('forearm.R', [w])).toBeNull()
    expect(supportArmNote('spine', [w])).toBeNull()
    const reach = { ...w, support: { ...w.support, mode: 'reach' } } as WeaponEntry
    expect(supportArmNote('hand.L', [reach])).toMatch(/reaches for the grip/)
  })
})

describe('updates in the status bar', () => {
  it('"Restart to update" once downloaded; "Download" on macOS; only the note otherwise', () => {
    expect(updateOffer(null, 'win32')).toBeNull()
    expect(updateOffer({ kind: 'none' }, 'win32')).toBeNull()
    expect(updateOffer({ kind: 'downloaded', version: '0.2.0' }, 'win32')).toEqual({ text: 'Update 0.2.0 ready', button: 'restart' })
    expect(updateOffer({ kind: 'downloaded', version: '0.2.0' }, 'linux')).toMatchObject({ button: 'restart' })
    expect(updateOffer({ kind: 'available', version: '0.2.0' }, 'darwin')).toEqual({ text: 'Update 0.2.0 available', button: 'download' })
    expect(updateOffer({ kind: 'available', version: '0.2.0' }, 'win32')).toEqual({ text: 'Update 0.2.0 available', button: null })
  })
})
