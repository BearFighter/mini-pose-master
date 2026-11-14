// SPDX-License-Identifier: GPL-3.0-or-later
// WP8c: the pose slice (input snapshots, undo/redo, merge rule), project.pose save/load, rig-hash
// changes, gizmo delta maths, copy L->R, the thumbnail queue, the clip list, and per-frame timing.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Quaternion, Vector3 } from 'three'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  allTags,
  ClipCache,
  filterClips,
  thumbFrame,
  visibleRange
} from '../../../src/renderer/lib/clips'
import {
  appendRotate,
  computePose,
  copySideOps,
  effectiveInputs,
  gizmoDelta,
  helperPose,
  inputsFromProvenance,
  provenanceFromInputs,
  REST_INPUTS,
  removeBoneEdits,
  type PoseInputsState
} from '../../../src/renderer/lib/pose'
import { ThumbQueue, type ThumbJob } from '../../../src/renderer/lib/thumbs'
import { useStore } from '../../../src/renderer/store'
import { closeProject, createProject, openProject, saveProject } from '../../../src/renderer/store/actions'
import {
  clipCache,
  commitFrame,
  commitRotate,
  copySide,
  currentPose,
  currentPoseState,
  selectClip,
  togglePoseMirror,
  undoPose
} from '../../../src/renderer/store/poseActions'
import { UNDO_MAX } from '../../../src/renderer/store/pose'
import type { ClipFrame, PackClip, PackIndex } from '../../../src/shared/clip'
import { writeClipF32 } from '../../../src/shared/clip'
import type { EditOp } from '../../../src/shared/composePose'
import { composePose } from '../../../src/shared/composePose'
import type { QuatWXYZ } from '../../../src/shared/coords'
import type { Deltas } from '../../../src/shared/fk'
import { canonicalIndex, posedJoints, resolveDeltas } from '../../../src/shared/fk'
import { mul, q4, quatAngleDeg, rotBetween, v3, wxyz } from '../../../src/shared/math'
import { mirrorPose } from '../../../src/shared/mirror'
import type { ProjectData } from '../../../src/shared/project'
import type { RigJson } from '../../../src/shared/rig'
import { installFakeMpm, type FakeMpm } from './fakeMpm'

const RIG = JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'rig_auto_apose.json'), 'utf8')) as RigJson
const ci = canonicalIndex(RIG)
const idx = (n: string): number => ci.get(n) as number
const S = () => useStore.getState()
const yes = () => true
const rot = (axis: [number, number, number], deg: number): QuatWXYZ =>
  wxyz(new Quaternion().setFromAxisAngle(new Vector3(...axis).normalize(), (deg * Math.PI) / 180))
type RotateOp = Extract<EditOp, { kind: 'rotate' }>
const rotate = (bone: string, q: QuatWXYZ, chain = true): RotateOp => ({ kind: 'rotate', bone, q, chain })

/** A clip frame read off a posed rig (contracts section 9 rotation conventions), as in posemath.test.ts. */
function frameFromPose(rig: RigJson, deltas: Deltas, contacts = { L: true, R: true }): ClipFrame {
  const J = posedJoints(rig, deltas)
  const joints: ClipFrame['joints'] = {}
  for (const [k, v] of Object.entries(J)) joints[k] = [v.x, v.y, v.z]
  const res = resolveDeltas(rig, deltas)
  const D = (name: string): Quaternion => q4(res[String(idx(name))])
  const rotQ: ClipFrame['rot'] = { head: wxyz(D('head')), ankle_L: wxyz(D('foot.L')), ankle_R: wxyz(D('foot.R')) }
  for (const s of ['L', 'R'] as const) {
    rotQ[`wrist_${s}`] = wxyz(mul(D(`hand.${s}`), rotBetween(new Vector3(0, 0, -1), v3(rig.hands[s]!.palm_normal))))
  }
  return { joints, rot: rotQ, contacts }
}

// A 50-frame synthetic clip on the fixture rig: the left arm rises, the right knee bends late.
const JOINTS = Object.keys(posedJoints(RIG, {}))
const FRAMES: ClipFrame[] = Array.from({ length: 50 }, (_v, f) => {
  const d: Deltas = { [String(idx('upper_arm.L'))]: rot([0, -1, 0], f * 2) }
  if (f >= 30) d[String(idx('thigh.R'))] = rot([1, 0, 0], -(f - 30) * 2)
  return frameFromPose(RIG, d, { L: true, R: f < 30 })
})
const CLIP_BUF = writeClipF32(FRAMES, JOINTS)
const CLIP: PackClip = { id: 'wave', move: 'wave', style: 'normal', tags: ['test', 'arm'], frames: 50, fps: 15, key_frames: [10, 40] }
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
let clipAvailable = true

function stubFetch(): void {
  vi.stubGlobal('fetch', async (url: string) => {
    const u = url.split('?')[0]
    if (u === 'mpm://project/rig/rig.json') return new Response(JSON.stringify(RIG))
    if (u === 'mpm://library/packs/mine/index.json') return new Response(JSON.stringify(INDEX))
    if (u === 'mpm://library/packs/mine/clips/wave.f32' && clipAvailable) return new Response(CLIP_BUF.slice(0))
    return new Response('not found', { status: 404 })
  })
}

/** A project with the fixture rig built and shown. */
async function riggedProject(): Promise<void> {
  await createProject('Hero', 'C:/p', yes)
  S().updateProject((d) => ({ ...d, rig: { kind: 'auto', hash: RIG.hash } }))
  S().setRig(RIG, 'mpm://project/rig/rig.glb?v=1', null)
  await saveProject()
}

beforeEach(() => {
  fake = installFakeMpm()
  clipAvailable = true
  clipCache.clear()
  useStore.setState(useStore.getInitialState(), true)
  stubFetch()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('pose slice', () => {
  it('commits input snapshots; undo/redo keep at most 100; an unchanged commit is no step', () => {
    S().setProject('C:/p/Hero', { schemaVersion: 1 } as ProjectData)
    const at = (frame: number): PoseInputsState => ({ ...REST_INPUTS, source: { pack: 'p', clip: 'c', frame } })
    for (let f = 0; f < UNDO_MAX + 5; f++) S().commitPose(at(f))
    expect(S().undo.length).toBe(UNDO_MAX)
    expect(S().dirty).toBe(true)
    expect(S().undoPose()).toBe(true)
    expect(S().poseInputs.source?.frame).toBe(UNDO_MAX + 3)
    expect(S().redo.length).toBe(1)
    expect(S().redoPose()).toBe(true)
    expect(S().poseInputs.source?.frame).toBe(UNDO_MAX + 4)
    S().undoPose()
    S().commitPose(at(7))
    expect(S().redo.length).toBe(0)
    const before = S().undo.length
    S().commitPose(at(7))
    expect(S().undo.length).toBe(before)
    for (let k = 0; k < UNDO_MAX + 10; k++) S().undoPose()
    expect(S().undo.length).toBe(0)
    expect(S().undoPose()).toBe(false)
  })

  it('previews a frame or a drag on top of the committed inputs', () => {
    const inputs: PoseInputsState = { ...REST_INPUTS, source: { pack: 'p', clip: 'c', frame: 3 }, edits: [rotate('spine', rot([0, 0, 1], 10))] }
    const eff = effectiveInputs(inputs, { frame: 9, op: rotate('neck', rot([1, 0, 0], 5)) })
    expect(eff.source?.frame).toBe(9)
    expect(eff.edits.map((e) => (e.kind === 'rotate' ? e.bone : ''))).toEqual(['spine', 'neck'])
    expect(effectiveInputs(inputs, null)).toBe(inputs)
  })

  it('merges a drag into the previous one of the same bone and mode only', () => {
    const a = rotate('spine', rot([0, 0, 1], 20))
    const b = rotate('spine', rot([1, 0, 0], 15))
    const merged = appendRotate([a], b, true)
    expect(merged).toHaveLength(1)
    expect(quatAngleDeg(q4((merged[0] as RotateOp).q), q4(b.q).multiply(q4(a.q)))).toBeLessThan(1e-4)
    expect(appendRotate([a], b, false)).toHaveLength(2)
    expect(appendRotate([a], { ...b, chain: false }, true)).toHaveLength(2)
    expect(appendRotate([a], { ...b, bone: 'neck' }, true)).toHaveLength(2)
    // merged edits pose exactly like the two separate ones
    const one = composePose(RIG, { mirrored: false, planted: false, edits: merged }, null).deltas
    const two = composePose(RIG, { mirrored: false, planted: false, edits: [a, b] }, null).deltas
    for (const k of Object.keys(two)) expect(quatAngleDeg(q4(one[k]), q4(two[k]))).toBeLessThan(1e-4)
  })

  it('consecutive drags of one bone are one edit (each still an undo step); selecting another bone starts a new edit', async () => {
    await riggedProject()
    commitRotate('spine', rot([0, 0, 1], 10), true)
    commitRotate('spine', rot([0, 0, 1], 5), true)
    expect(S().poseInputs.edits).toHaveLength(1)
    expect(S().undo.length).toBe(2)
    undoPose()
    expect(S().poseInputs.edits).toHaveLength(1)
    expect(quatAngleDeg(q4((S().poseInputs.edits[0] as RotateOp).q), q4(rot([0, 0, 1], 10)))).toBeLessThan(1e-4)
    S().selectBone('neck')
    commitRotate('spine', rot([0, 0, 1], 5), true)
    expect(S().poseInputs.edits).toHaveLength(2)
  })

  it('"Reset bone" removes its rotations, and a hand also its reach', () => {
    const edits: EditOp[] = [rotate('spine', rot([0, 0, 1], 5)), rotate('hand.L', rot([1, 0, 0], 5)), { kind: 'reach', side: 'L', target: [0.3, 0, 1] }, rotate('neck', rot([1, 0, 0], 5))]
    expect(removeBoneEdits(edits, 'spine')).toHaveLength(3)
    expect(removeBoneEdits(edits, 'hand.L').map((e) => e.kind + (e.kind === 'rotate' ? e.bone : ''))).toEqual(['rotatespine', 'rotateneck'])
  })
})

describe('project.pose', () => {
  it('provenance round trip of the inputs', () => {
    const inputs: PoseInputsState = {
      source: { pack: 'mine', clip: 'wave', frame: 40 },
      mirrored: true,
      planted: false,
      edits: [rotate('spine', rot([0, 0, 1], 20)), { kind: 'reach', side: 'R', target: [-0.3, -0.2, 1.1] }]
    }
    expect(inputsFromProvenance(provenanceFromInputs(inputs))).toEqual(inputs)
    expect(inputsFromProvenance({ pack: null, clip: null, frame: null, mirrored: false, edits: [] })).toEqual(REST_INPUTS)
    expect(inputsFromProvenance(null)).toEqual(REST_INPUTS)
    // planted is absent in older provenance: true
    expect(inputsFromProvenance({ pack: 'p', clip: 'c', frame: 1, mirrored: false, edits: [] }).planted).toBe(true)
  })

  it('save, reload: same provenance and deltas within 1e-6', async () => {
    await riggedProject()
    await selectClip('mine', 'wave')
    expect(S().poseInputs.source).toEqual({ pack: 'mine', clip: 'wave', frame: 10 }) // first key frame
    commitFrame(40)
    commitRotate('spine', rot([0, 0, 1], 20), true)
    togglePoseMirror()
    expect(S().poseInputs.mirrored).toBe(true)
    undoPose()
    expect(S().poseInputs.mirrored).toBe(false)
    await saveProject()
    expect(S().dirty).toBe(false)
    const saved = (fake.saves.at(-1)!.project as ProjectData).pose!
    expect(saved.rig_hash).toBe(RIG.hash)
    expect(saved.root_offset).toEqual([0, 0, 0])
    expect(Object.keys(saved.deltas)).toHaveLength(RIG.bones.length)
    expect(saved.provenance).toEqual({ pack: 'mine', clip: 'wave', frame: 40, mirrored: false, planted: true, edits: [rotate('spine', rot([0, 0, 1], 20))] })

    closeProject(yes)
    await openProject('C:/p/Hero', yes)
    expect(S().step).toBe('pose')
    expect(S().poseNotice).toBeNull()
    expect(S().dirty).toBe(false)
    expect(provenanceFromInputs(S().poseInputs)).toEqual(saved.provenance)
    const again = currentPoseState()!
    for (const [k, q] of Object.entries(saved.deltas)) expect(quatAngleDeg(q4(again.deltas[k]), q4(q))).toBeLessThan(1e-4) // 1e-6 rad
    let worst = 0
    for (const [k, q] of Object.entries(saved.deltas)) worst = Math.max(worst, ...q.map((v, n) => Math.abs(v - again.deltas[k][n])))
    expect(worst).toBeLessThan(1e-6)
  })

  it('a rebuilt rig (other rig_hash) re-applies the pose and says so', async () => {
    await riggedProject()
    await selectClip('mine', 'wave')
    await saveProject()
    const stored = JSON.parse(String(fake.projects.get('C:/p/Hero')))
    stored.pose.rig_hash = 'an-older-rig'
    fake.projects.set('C:/p/Hero', JSON.stringify(stored))
    await openProject('C:/p/Hero', yes)
    expect(S().poseNotice).toBe('Pose re-applied to the rebuilt rig.')
    expect(S().dirty).toBe(true)
    expect(S().data!.pose!.rig_hash).toBe(RIG.hash)
  })

  it('a missing clip keeps rest + edits and names the pack to install', async () => {
    await riggedProject()
    await selectClip('mine', 'wave')
    commitRotate('spine', rot([0, 0, 1], 20), true)
    await saveProject()
    const stored = JSON.parse(String(fake.projects.get('C:/p/Hero')))
    stored.pose.rig_hash = 'an-older-rig'
    fake.projects.set('C:/p/Hero', JSON.stringify(stored))
    clipAvailable = false
    clipCache.clear()
    await openProject('C:/p/Hero', yes)
    expect(S().poseNotice).toMatch(/"wave" is not available/)
    expect(S().poseNotice).toMatch(/Install the "mine" pack/)
    expect(S().error).toBeNull()
    const restPlusEdits = composePose(RIG, { mirrored: false, planted: true, edits: [rotate('spine', rot([0, 0, 1], 20))] }, null).deltas
    const now = currentPose()!.deltas
    for (const k of Object.keys(restPlusEdits)) expect(quatAngleDeg(q4(now[k]), q4(restPlusEdits[k]))).toBeLessThan(1e-4)
  })

  it('with the same rig and the clip missing, saving keeps the stored pose', async () => {
    await riggedProject()
    await selectClip('mine', 'wave')
    commitFrame(40)
    await saveProject()
    const before = (fake.saves.at(-1)!.project as ProjectData).pose!
    clipAvailable = false
    clipCache.clear()
    await openProject('C:/p/Hero', yes)
    expect(S().poseNotice).toMatch(/not available/)
    await saveProject()
    expect((fake.saves.at(-1)!.project as ProjectData).pose).toEqual(before)
  })
})

describe('gizmo and copy', () => {
  it('a 30 degree gizmo drag about the helper X axis poses the limb as expected (1e-5 m)', () => {
    const start = composePose(RIG, { mirrored: false, planted: false, edits: [rotate('upper_arm.R', rot([0.3, 1, 0.2], 35))] }, null).deltas
    const i = idx('upper_arm.R')
    const helper = helperPose(RIG, start, i)
    // TransformControls in local space: the helper turns about its own X axis
    const now = helper.quaternion.clone().multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 6))
    const q = gizmoDelta(helper.quaternion, now)
    const after = composePose(
      RIG,
      { mirrored: false, planted: false, edits: [rotate('upper_arm.R', rot([0.3, 1, 0.2], 35)), rotate('upper_arm.R', q)] },
      null
    ).deltas
    // expected: the limb turns 30 degrees about the bone frame's X axis (Blender), through the posed head
    const axis = new Vector3(1, 0, 0).applyQuaternion(mul(q4(start[String(i)]), q4(RIG.bones[i].rest_q)))
    const turn = new Quaternion().setFromAxisAngle(axis, Math.PI / 6)
    const before = posedJoints(RIG, start)
    const got = posedJoints(RIG, after)
    const pivot = before.shoulder_R
    for (const j of ['shoulder_R', 'elbow_R', 'wrist_R', 'index_tip_R', 'thumb_tip_R']) {
      const exp = before[j].clone().sub(pivot).applyQuaternion(turn).add(pivot)
      expect(got[j].distanceTo(exp)).toBeLessThan(1e-5)
    }
    // the helper sits on the posed head
    const head = helper.position
    expect(Math.hypot(head.x - pivot.x, head.y - pivot.z, head.z + pivot.y)).toBeLessThan(1e-9)
  })

  it('copy L->R gives mirrorPose on the right side and leaves the left alone', () => {
    const edits: EditOp[] = [
      rotate('upper_arm.L', rot([0.2, -1, 0.1], 50)),
      rotate('forearm.L', rot([1, 0, 0], 40), false),
      rotate('hand.L', rot([0, 1, 0], 25), false),
      rotate('thigh.L', rot([1, 0.2, 0], -30)),
      rotate('upper_arm.R', rot([0, 1, 0], 70)),
      rotate('spine', rot([0, 0, 1], 15))
    ]
    const deltas = composePose(RIG, { mirrored: false, planted: false, edits }, null).deltas
    const ops = copySideOps(RIG, deltas, 'L')
    expect(ops.every((op) => op.kind === 'rotate' && op.bone.endsWith('.R') && !op.chain)).toBe(true)
    const after = composePose(RIG, { mirrored: false, planted: false, edits: [...edits, ...ops] }, null).deltas
    const mirrored = mirrorPose(RIG, deltas, [0, 0, 0]).deltas
    for (const b of RIG.bones) {
      const k = String(b.index)
      if (b.canonical?.endsWith('.R')) expect(quatAngleDeg(q4(after[k]), q4(mirrored[k]))).toBeLessThan(1e-4)
      else expect(quatAngleDeg(q4(after[k]), q4(deltas[k]))).toBeLessThan(1e-4)
    }
  })

  it('"Copy pose R->L" in the store is one undo step', async () => {
    await riggedProject()
    commitRotate('upper_arm.R', rot([0, 1, 0], 60), true)
    const steps = S().undo.length
    copySide('R')
    expect(S().undo.length).toBe(steps + 1)
    const d = currentPose()!.deltas
    const m = mirrorPose(RIG, d, [0, 0, 0]).deltas
    expect(quatAngleDeg(q4(d[String(idx('upper_arm.L'))]), q4(m[String(idx('upper_arm.L'))]))).toBeLessThan(1e-4)
  })
})

describe('thumbnail queue', () => {
  function deferred<T>() {
    let resolve!: (v: T) => void
    let reject!: (e: unknown) => void
    const promise = new Promise<T>((a, b) => ((resolve = a), (reject = b)))
    return { promise, resolve, reject }
  }

  it('makes one thumbnail at a time, only for rows still in view, and never retries a failure', async () => {
    const renders: string[] = []
    const saves: string[] = []
    const pending = new Map<string, ReturnType<typeof deferred<Uint8Array>>>()
    const q = new ThumbQueue({
      render: (job: ThumbJob) => {
        renders.push(job.clipId)
        const d = deferred<Uint8Array>()
        pending.set(job.clipId, d)
        return d.promise
      },
      save: async (job) => {
        saves.push(`${job.clipId}_${job.frame}`)
      }
    })
    const results: string[] = []
    const job = (clipId: string): ThumbJob => ({ packId: 'mine', clipId, frame: 0 })
    q.request(job('a'), (ok) => results.push(`a:${ok}`))
    q.request(job('b'), (ok) => results.push(`b:${ok}`))
    const withdrawC = q.request(job('c'), (ok) => results.push(`c:${ok}`))
    q.request(job('d'), (ok) => results.push(`d:${ok}`))
    expect(renders).toEqual(['a'])
    expect(q.pending).toBe(3)
    withdrawC() // row c scrolled out of view before its turn
    pending.get('a')!.resolve(new Uint8Array([1]))
    await vi.waitFor(() => expect(renders).toEqual(['a', 'b']))
    pending.get('b')!.reject(new Error('no WebGL'))
    await vi.waitFor(() => expect(renders).toEqual(['a', 'b', 'd']))
    pending.get('d')!.resolve(new Uint8Array([2]))
    await q.whenIdle()
    expect(results).toEqual(['a:true', 'b:false', 'd:true'])
    expect(saves).toEqual(['a_0', 'd_0'])
    // made and failed ones answer at once, without rendering again
    q.request(job('a'), (ok) => results.push(`a2:${ok}`))
    q.request(job('b'), (ok) => results.push(`b2:${ok}`))
    expect(results.slice(-2)).toEqual(['a2:true', 'b2:false'])
    expect(renders).toEqual(['a', 'b', 'd'])
  })
})

describe('clip list', () => {
  const clips: PackClip[] = [
    { id: 'dataset-1_walk_normal_001', move: 'walk', style: 'normal', tags: ['locomotion'], frames: 100, fps: 15, key_frames: [5] },
    { id: 'dataset-1_walk_happy_001', move: 'walk', style: 'happy', tags: ['locomotion', 'emotion'], frames: 90, fps: 15, key_frames: [] },
    { id: 'dataset-1_punch_angry_002', move: 'punch', style: 'angry', tags: ['fight', 'emotion'], frames: 40, fps: 15, key_frames: [12] },
    { id: 'aiming1_subject1', move: 'aiming1', style: '', tags: [], frames: 3000, fps: 15, key_frames: [] }
  ]

  it('filters by words over id, move, style and tags, and by selected tags', () => {
    const ids = (c: PackClip[]) => c.map((x) => x.id)
    expect(filterClips(clips, '', [])).toHaveLength(4)
    expect(ids(filterClips(clips, 'WALK', []))).toEqual(['dataset-1_walk_normal_001', 'dataset-1_walk_happy_001'])
    expect(ids(filterClips(clips, 'walk happy', []))).toEqual(['dataset-1_walk_happy_001'])
    expect(ids(filterClips(clips, 'subject1', []))).toEqual(['aiming1_subject1'])
    expect(ids(filterClips(clips, '', ['emotion']))).toEqual(['dataset-1_walk_happy_001', 'dataset-1_punch_angry_002'])
    expect(ids(filterClips(clips, 'punch', ['emotion', 'fight']))).toEqual(['dataset-1_punch_angry_002'])
    expect(filterClips(clips, 'nothing', [])).toEqual([])
    expect(allTags(clips)).toEqual(['emotion', 'locomotion', 'fight'])
    expect(thumbFrame(clips[0])).toBe(5)
    expect(thumbFrame(clips[1])).toBe(0)
  })

  it('virtualises with a visible window plus overscan', () => {
    expect(visibleRange(0, 560, 56, 5000, 6)).toEqual([0, 16])
    expect(visibleRange(56 * 1000, 560, 56, 5000, 6)).toEqual([994, 1016])
    expect(visibleRange(56 * 4995, 560, 56, 5000, 6)).toEqual([4989, 5000])
  })

  it('keeps the last 8 clips', async () => {
    const fetched: string[] = []
    const index: PackIndex = { ...INDEX, clips: Array.from({ length: 10 }, (_v, k) => ({ ...CLIP, id: `c${k}` })) }
    const cache = new ClipCache(8, async (url) => {
      fetched.push(url)
      return new Response(CLIP_BUF.slice(0))
    })
    for (let k = 0; k < 9; k++) await cache.load('mine', index, `c${k}`)
    expect(cache.keys()).toHaveLength(8)
    expect(cache.has('mine', 'c0')).toBe(false)
    await cache.load('mine', index, 'c1') // a hit: no fetch, now the newest
    expect(fetched).toHaveLength(9)
    await cache.load('mine', index, 'c9')
    expect(cache.has('mine', 'c1')).toBe(true)
    expect(cache.has('mine', 'c2')).toBe(false)
    const c = await cache.load('mine', index, 'c9')
    expect(c.frames).toBe(50)
    expect(c.frame(40).contacts).toEqual({ L: true, R: false })
  })
})

describe('per-frame cost', () => {
  it('retarget + compose of one frame takes under 5 ms on the fixture rig', () => {
    const inputs = { mirrored: false, planted: true, edits: [rotate('spine', rot([0, 0, 1], 20)), rotate('upper_arm.R', rot([0, 1, 0], 30))] }
    for (let k = 0; k < 20; k++) composePose(RIG, inputs, FRAMES[k % FRAMES.length]) // warm up
    const n = 200
    const t0 = performance.now()
    for (let k = 0; k < n; k++) composePose(RIG, { ...inputs, mirrored: k % 2 === 1 }, FRAMES[k % FRAMES.length])
    const ms = (performance.now() - t0) / n
    console.log(`[timing] retarget + compose, one frame: ${ms.toFixed(3)} ms (fixture rig, ${RIG.bones.length} bones)`)
    expect(ms).toBeLessThan(5)
  })

  it('computePose is memoised on its inputs', () => {
    const inputs: PoseInputsState = { ...REST_INPUTS, edits: [rotate('spine', rot([0, 0, 1], 20))] }
    const a = computePose(RIG, inputs, null, null, null)
    expect(computePose(RIG, inputs, null, null, null)).toBe(a)
    expect(computePose(RIG, { ...inputs }, null, null, null)).not.toBe(a)
  })
})
