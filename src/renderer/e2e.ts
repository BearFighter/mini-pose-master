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
          warnings: s.importInfo.warnings
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
  importModel(path: string): Promise<ReturnType<typeof testState>>
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
  /** Runs the dump_skinned job with the current pose state. */
  dumpSkinned(sample: Record<string, number[]>): Promise<{ meshes: Record<string, { indices: number[]; positions: Vec3[] }> } | { error: { code: JobErrorCode; message: string } }>
}

export function installTestHook(): void {
  const hook: MpmTestHook = {
    newProject: async (dir, name = 'E2E Fixture') => {
      await createProject(name, dir, () => true)
      return testState()
    },
    openProject: async (path) => {
      await openProject(path, () => true)
      return testState()
    },
    importModel: async (path) => {
      useStore.getState().setStep('import')
      await importModel(path)
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
