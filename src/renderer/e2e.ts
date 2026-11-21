// SPDX-License-Identifier: GPL-3.0-or-later
// window.__mpmTest: a small hook for tests/e2e/drive.mjs to drive the store. Installed only when
// the main process runs with MPM_E2E=1 (it then loads the page with ?e2e=1).
import { Quaternion, Vector3 } from 'three'
import type { Vec3 } from '../shared/coords'
import type { JobErrorCode } from '../shared/ipc'
import { wxyz } from '../shared/math'
import { applyPoseState } from '../shared/poseMath'
import { skinnedPositionsBlender } from '../shared/skinSample'
import { runJob } from './api'
import { useStore } from './store'
import { buildRig, createProject, findJoints, importModel, openProject, saveProject } from './store/actions'
import {
  commitRotate,
  currentPose,
  currentPoseState,
  commitFrame,
  importOwnBvh,
  redoPose,
  selectClip,
  togglePoseMirror,
  undoPose
} from './store/poseActions'
import type { Step } from './store/ui'
import { gizmoInfo, rigView } from './viewer/rigView'
import { vecB2T } from '../shared/coords'
import { canonicalIndex, posedJoints } from '../shared/fk'
import { attachFrame } from '../shared/weaponPose'
import type { BakeJobResult } from '../shared/jobResults'
import type { PartsChoice, WeaponEntry } from '../shared/project'
import { runBake } from './store/exportActions'
import { choosePreset, runAutoGrip } from './store/handActions'
import { clearEdits, clearSource, commitReach } from './store/poseActions'
import { addPropWeapon, addWeapon, setGripPoint, setSupport } from './store/weaponActions'
import type { WeaponTool } from './store/weapons'

/** Vertex indices (= _ORIG_INDEX) spread evenly over the rig's meshes, `count` in all. */
function sampleIndices(count: number): Record<string, number[]> {
  const rig = useStore.getState().rigJson
  if (!rig) throw new Error('no rig')
  const total = rig.meshes.reduce((n, m) => n + m.vertices, 0)
  const out: Record<string, number[]> = {}
  for (const m of rig.meshes) {
    const n = Math.max(1, Math.round((count * m.vertices) / total))
    const step = (m.vertices - 1) / Math.max(1, n - 1)
    out[m.name] = [...new Set(Array.from({ length: n }, (_v, k) => Math.round(k * step)))]
  }
  return out
}

/** A JSON-friendly summary of the store for assertions. */
export function testState() {
  const s = useStore.getState()
  return {
    blender: s.blender,
    project: s.dir
      ? {
          dir: s.dir,
          dirty: s.dirty,
          source: s.data?.source ?? null,
          rig: s.data?.rig ?? null,
          draftMarkers: s.data?.rigDraft?.markers ? Object.keys(s.data.rigDraft.markers).length : 0
        }
      : null,
    step: s.step,
    view: s.view,
    import: s.importInfo
      ? {
          objects: s.importInfo.objects.length,
          tri_count: s.importInfo.tri_count,
          height_m: s.importInfo.height_m,
          has_armature: s.importInfo.has_armature,
          materials: s.importInfo.materials.length,
          warnings: s.importInfo.warnings,
          all_objects: s.importInfo.all_objects ?? null,
          props: s.importInfo.props ?? null
        }
      : null,
    markers: s.markers ? Object.keys(s.markers).length : 0,
    rig: {
      loaded: s.viewer.rigLoaded,
      bones: s.viewer.boneCount,
      kind: s.rigJson?.kind ?? null,
      hash: s.rigJson?.hash ?? null,
      follow: s.rigResult?.follow ?? null
    },
    viewer: s.viewer,
    testPose: s.testPose,
    weapons: s.weapons,
    hands: s.hands,
    bake: s.bakeResult ? { stl: s.bakeResult.stl, preview: s.bakeResult.preview_glb, seconds: s.bakeResult.seconds } : null,
    pose: {
      inputs: s.poseInputs,
      undo: s.undo.length,
      redo: s.redo.length,
      notice: s.poseNotice,
      selected: s.boneSelection,
      saved: s.data?.pose ?? null
    },
    library: {
      packs: (s.packs ?? []).map((p) => ({ id: p.id, installed: p.installed, clips: p.clips })),
      selectedPack: s.selectedPack,
      indexClips: s.packIndex?.clips.map((c) => c.id) ?? [],
      loadedClip: s.loadedClip ? `${s.loadedClip.packId}/${s.loadedClip.clipId}` : null
    },
    job: s.active,
    error: s.error
  }
}

export interface MpmTestHook {
  newProject(dir: string, name?: string): Promise<ReturnType<typeof testState>>
  openProject(path: string): Promise<ReturnType<typeof testState>>
  /** `objects`: the parts choice `{object name: part of the character}` sent to the import job. */
  importModel(path: string, objects?: PartsChoice): Promise<ReturnType<typeof testState>>
  findJoints(): Promise<ReturnType<typeof testState>>
  buildRig(): Promise<ReturnType<typeof testState>>
  testPose(on: boolean): ReturnType<typeof testState>
  save(): Promise<ReturnType<typeof testState>>
  state(): ReturnType<typeof testState>
  setStep(step: Step): ReturnType<typeof testState>
  importClip(file: string): Promise<{ packId: string; clipIds: string[] }>
  selectClip(packId: string, clipId: string): Promise<ReturnType<typeof testState>>
  scrubTo(frame: number): ReturnType<typeof testState>
  /** Rotates a canonical bone `degrees` about a Blender armature-space axis (one committed edit). */
  rotateBone(bone: string, axis: Vec3, degrees: number, chain?: boolean): ReturnType<typeof testState>
  selectBone(bone: string | null): ReturnType<typeof testState>
  toggleMirror(): ReturnType<typeof testState>
  undo(): ReturnType<typeof testState>
  redo(): ReturnType<typeof testState>
  /** project.pose for the current inputs (what a save writes). */
  poseState(): ReturnType<typeof currentPoseState>
  /** The renderer's posed positions (Blender frame, metres) of `count` sampled vertices, by _ORIG_INDEX. */
  posedSample(count: number): { sample: Record<string, number[]>; positions: Record<string, Vec3[]> }
  /** Where the gizmo is on screen and which axis the pointer hovers. */
  gizmo(): ReturnType<typeof gizmoInfo>
  addWeapon(file: string): Promise<WeaponEntry>
  /** "Add as weapon" for a prop the import left out; `file` is its `props/<name>.glb`. */
  addPropWeapon(file: string): Promise<WeaponEntry>
  setGripPoint(id: string, point: Vec3): ReturnType<typeof testState>
  setSupport(id: string, support: { point: Vec3; normal: Vec3; axis: Vec3 }): ReturnType<typeof testState>
  selectWeapon(id: string | null, tool?: WeaponTool): ReturnType<typeof testState>
  reach(side: 'L' | 'R', target: Vec3): ReturnType<typeof testState>
  /** "Rest pose" + "Clear edits". */
  clearPose(): ReturnType<typeof testState>
  preset(side: 'L' | 'R', name: string): ReturnType<typeof testState>
  autoGrip(side: 'L' | 'R'): Promise<{
    fingers: Record<string, { touching: boolean; maxed: boolean; minDistance_m: number; locked: boolean; reopened: boolean; startDistance_m: number; stepTravel_m: number }>
    ms: number
    unitMm: number
  }>
  /** Per weapon id, how far the support hand falls short (metres). */
  supportShort(): Record<string, number>
  /** rig.json index of a canonical bone. */
  boneIndex(canonical: string): number
  /** The renderer's attach frame of a canonical bone, as 4x4 rows (Blender armature space). */
  attachFrame(canonical: string): number[][] | null
  /** Points the camera at a posed joint (Blender name), `radius` metres around it. */
  focusJoint(joint: string, radius: number): ReturnType<typeof testState>
  bake(heightMm: number): Promise<BakeJobResult & { wall_s: number }>
  setShowBaked(on: boolean): ReturnType<typeof testState>
  /** Runs the dump_skinned job with the current pose state. */
  dumpSkinned(sample: Record<string, number[]>): Promise<{ meshes: Record<string, { indices: number[]; positions: Vec3[] }> } | { error: { code: JobErrorCode; message: string } }>
}

export function installTestHook(): void {
  const hook: MpmTestHook = {
    newProject: async (dir, name = 'E2E Kit') => {
      await createProject(name, dir, () => true)
      return testState()
    },
    openProject: async (path) => {
      await openProject(path, () => true)
      return testState()
    },
    importModel: async (path, objects) => {
      useStore.getState().setStep('import')
      await importModel(path, objects)
      return testState()
    },
    findJoints: async () => {
      useStore.getState().setStep('rig')
      useStore.getState().setRigPath('auto')
      await findJoints()
      return testState()
    },
    buildRig: async () => {
      useStore.getState().setStep('rig')
      await buildRig('auto')
      return testState()
    },
    testPose: (on) => {
      useStore.getState().setTestPose(on)
      return testState()
    },
    save: async () => {
      await saveProject()
      return testState()
    },
    state: testState,
    setStep: (step) => {
      useStore.getState().setStep(step)
      return testState()
    },
    importClip: (file) => importOwnBvh(file),
    selectClip: async (packId, clipId) => {
      useStore.getState().setStep('pose')
      await selectClip(packId, clipId)
      return testState()
    },
    scrubTo: (frame) => {
      commitFrame(frame)
      return testState()
    },
    rotateBone: (bone, axis, degrees, chain = true) => {
      useStore.getState().selectBone(bone)
      const q = new Quaternion().setFromAxisAngle(new Vector3(...axis).normalize(), (degrees * Math.PI) / 180)
      commitRotate(bone, wxyz(q), chain)
      return testState()
    },
    selectBone: (bone) => {
      useStore.getState().selectBone(bone)
      return testState()
    },
    toggleMirror: () => {
      togglePoseMirror()
      return testState()
    },
    undo: () => {
      undoPose()
      return testState()
    },
    redo: () => {
      redoPose()
      return testState()
    },
    poseState: () => currentPoseState(),
    addWeapon: (file) => addWeapon(file),
    addPropWeapon: (file) => addPropWeapon(file),
    setGripPoint: (id, point) => {
      setGripPoint(id, point)
      return testState()
    },
    setSupport: (id, support) => {
      setSupport(id, support)
      return testState()
    },
    selectWeapon: (id, tool) => {
      useStore.getState().selectWeapon(id)
      if (tool) useStore.getState().setWeaponTool(tool)
      return testState()
    },
    clearPose: () => {
      clearSource()
      clearEdits()
      return testState()
    },
    reach: (side, target) => {
      commitReach(side, target)
      return testState()
    },
    preset: (side, name) => {
      choosePreset(side, name)
      return testState()
    },
    autoGrip: async (side) => {
      const r = await runAutoGrip(side)
      const report = useStore.getState().gripReport[side]
      return { fingers: r.fingers, ms: report?.ms ?? 0, unitMm: report?.unitMm ?? 0 }
    },
    supportShort: () => currentPose(false)?.supportShort ?? {},
    boneIndex: (canonical) => {
      const rig = useStore.getState().rigJson
      return rig ? canonicalIndex(rig).get(canonical) ?? -1 : -1
    },
    attachFrame: (canonical) => {
      const rig = useStore.getState().rigJson
      const pose = currentPose(false)
      const A = rig && pose ? attachFrame(rig, pose.deltas, canonical) : null
      if (!A) return null
      const e = A.elements // column-major
      return [0, 1, 2, 3].map((r) => [0, 1, 2, 3].map((c) => e[c * 4 + r]))
    },
    focusJoint: (joint, radius) => {
      const s = useStore.getState()
      const pose = currentPose(false)
      if (s.rigJson && pose) {
        const j = posedJoints(s.rigJson, pose.deltas)[joint]
        if (j) {
          const t = vecB2T([j.x, j.y, j.z])
          s.requestFocus([t.x, t.y, t.z + 0], radius, true)
        }
      }
      return testState()
    },
    bake: async (heightMm) => {
      useStore.getState().setStep('export')
      useStore.getState().updateBake({ scale: { mode: 'height_mm', height_mm: heightMm } })
      const t0 = performance.now()
      const r = await runBake()
      return { ...r, wall_s: (performance.now() - t0) / 1000 }
    },
    setShowBaked: (on) => {
      useStore.getState().setShowBaked(on)
      return testState()
    },
    gizmo: () => gizmoInfo(),
    posedSample: (count) => {
      const bound = rigView.bound
      const pose = currentPose(false)
      if (!bound || !pose) throw new Error('the rig is not shown')
      applyPoseState(bound, pose.deltas) // the same pose the viewer shows
      const sample = sampleIndices(count)
      const positions: Record<string, Vec3[]> = {}
      for (const [mesh, idx] of Object.entries(sample)) positions[mesh] = skinnedPositionsBlender(bound, mesh, idx)
      return { sample, positions }
    },
    dumpSkinned: async (sample) => {
      const pose = currentPoseState()
      if (!pose) throw new Error('no pose')
      try {
        return await runJob('dump_skinned', { pose, sample })
      } catch (e) {
        const err = e as { code?: JobErrorCode; message?: string }
        return { error: { code: err.code ?? 'E_INTERNAL', message: err.message ?? String(e) } }
      }
    }
  }
  ;(window as unknown as { __mpmTest: MpmTestHook }).__mpmTest = hook
}

export function isE2e(): boolean {
  try {
    return new URLSearchParams(window.location.search).get('e2e') === '1'
  } catch {
    return false
  }
}
