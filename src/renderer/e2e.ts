// SPDX-License-Identifier: GPL-3.0-or-later
// window.__mpmTest: a small hook for tests/e2e/drive.mjs to drive the store. Installed only when
// the main process runs with MPM_E2E=1 (it then loads the page with ?e2e=1).
import { buildRig, createProject, findJoints, importModel, openProject, saveProject } from './store/actions'
import { useStore } from './store'

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
    state: testState
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
