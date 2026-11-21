// SPDX-License-Identifier: GPL-3.0-or-later
// User flows that span slices and talk to the main process (through api.ts only):
// Blender status, projects (new/open/save), import, find joints, bone mapping, build rig.
import { Vector3 } from 'three'
import { vecB2T } from '../../shared/coords'
import type { BlenderStatus, FileFilter } from '../../shared/ipc'
import type {
  ImportJobResult,
  RigJobResult,
  SuggestMappingResult,
  SuggestMarkersResult
} from '../../shared/jobResults'
import type { Orientation, PartsChoice, ProjectData } from '../../shared/project'
import type { RigJson } from '../../shared/rig'
import { api, cleanError, runJob, setJobProjectDir } from '../api'
import { handMarkerNames, isFingerMarker, markerHeight } from '../lib/markers'
import { pickOrientation, sameOrientation } from '../lib/orientation'
import { sameChoice, sameObjects } from '../lib/parts'
import { projectName, projectUrl } from '../lib/paths'
import { NO_HANDS, normaliseHands } from '../lib/hands'
import { addRecent } from '../lib/recent'
import { defaultConfirm, errorBanner, fail, fire, nextVersion, S, type ConfirmDiscard } from './flow'
import { restorePoseFromProject, syncPoseToProject } from './poseActions'
import { mappingForJob } from './rig'

export const MODEL_FILTERS: FileFilter[] = [
  { name: '3D models', extensions: ['fbx', 'glb', 'gltf', 'obj', 'stl', 'ply'] },
  { name: 'All files', extensions: ['*'] }
]
export const PROJECT_FILTERS: FileFilter[] = [{ name: 'Mini Pose Master project', extensions: ['mposer'] }]

export { fire }
export type { ConfirmDiscard }

// ---------------------------------------------------------------------------------------------------
// App and Blender

export async function loadAppInfo(): Promise<void> {
  try {
    S().setAppInfo(await api.app.info())
  } catch (e) {
    S().setError(errorBanner(e))
  }
}

export async function refreshBlender(): Promise<BlenderStatus> {
  const status = await api.blender.status()
  S().setBlenderStatus(status)
  if (!status.found) S().setShowBlenderSetup(true)
  return status
}

/** Subscribes the store to main-process events. Returns the unsubscribe function. */
export function subscribeEvents(): () => void {
  const offs = [
    api.on('job:event', (event) => {
      if (event.kind === 'log') S().appendLog(event.payload)
    }),
    api.on('update:event', (update) => S().setUpdate(update)),
    api.on('library:progress', ({ packId, stage, fraction }) => {
      if (stage === 'done') return
      if (S().installs[packId]) S().setInstallProgress(packId, { stage, fraction })
    }),
    api.on('app:open-project', ({ path }) => fire(openProject(path)))
  ]
  return () => offs.forEach((off) => off())
}

/**
 * Runs one job-backed flow: marks the job active (only one at a time from the UI), forwards
 * progress, records the result and shows failures in the banner.
 */
export async function withJob<T>(type: string, label: string, body: () => Promise<T>): Promise<T> {
  if (S().active) throw fail(new Error('Another job is still running'))
  S().jobStarted(type, label)
  try {
    const result = await body()
    S().jobFinished({ type, result })
    return result
  } catch (e) {
    S().jobFinished()
    return fail(e)
  }
}

export function job<T>(type: string, args: Record<string, unknown>): Promise<T> {
  return runJob<T>(type, args, (p) => S().jobProgress(p), { onStart: (id) => S().jobIdKnown(id) })
}

export async function cancelActiveJob(): Promise<void> {
  const id = S().active?.jobId
  if (id) await api.job.cancel(id).catch(fail)
}

// ---------------------------------------------------------------------------------------------------
// Projects

function initSlicesFromProject(data: ProjectData): void {
  const s = S()
  s.resetRig()
  s.resetPoseInputs()
  s.setPoseNotice(null)
  s.setLoadedClip(null)
  s.selectBone(null)
  s.setHands(normaliseHands(data.hands))
  s.setWeapons(Array.isArray(data.weapons) ? data.weapons : [])
  s.selectWeapon(null)
  s.setBake(data.bake ?? null)
  s.setBakeResult(null)
}

async function adoptProject(dir: string, data: ProjectData): Promise<void> {
  const s = S()
  setJobProjectDir(dir)
  s.setProject(dir, data)
  initSlicesFromProject(data)
  s.select(null)
  s.setStep(data.rig ? (data.pose ? 'pose' : 'rig') : 'import')
  addRecent({ dir, name: projectName(dir) })
  const markers = data.rigDraft?.markers ?? null
  if (markers) S().setMarkers(markers, { dirty: false })
  S().setRigPath(data.rig?.kind === 'imported' ? 'imported' : 'auto')
  if (data.source) {
    S().setPreview(projectUrl('rig/preview.glb', nextVersion()))
    await loadImportSummary(data.source.file)
  }
  if (data.rig) {
    try {
      await loadRigFiles(nextVersion())
      await restorePoseFromProject(data)
    } catch (e) {
      S().setError({ code: 'ERROR', message: `The rig files could not be loaded: ${cleanError(e)}` })
    }
  }
}

/** The last import job's summary (rig/import.json), when it belongs to the current source model. */
async function loadImportSummary(sourceFile: string): Promise<void> {
  try {
    const res = await fetch(projectUrl('rig/import.json', nextVersion()))
    if (!res.ok) return
    const info = (await res.json()) as ImportJobResult & { source_file?: string }
    if (info.source_file !== undefined && info.source_file !== sourceFile) return
    if (!Array.isArray(info.objects) || typeof info.tri_count !== 'number') return
    S().setImportInfo(info)
  } catch {
    // no summary yet (or an older project): the Import step offers to run the import again
  }
}

function confirmDiscardIfDirty(confirm: ConfirmDiscard): boolean {
  if (!S().dirty) return true
  return confirm('The project has unsaved changes. Discard them?')
}

export async function createProject(name: string, parentDir: string, confirm: ConfirmDiscard = defaultConfirm): Promise<boolean> {
  if (S().active) throw fail(new Error('Wait for the running job to finish'))
  if (!confirmDiscardIfDirty(confirm)) return false
  try {
    const handle = await api.project.create(name, parentDir)
    await adoptProject(handle.dir, handle.project)
    return true
  } catch (e) {
    return fail(e)
  }
}

/** Opens a `.mposer` file or a project folder. */
export async function openProject(path: string, confirm: ConfirmDiscard = defaultConfirm): Promise<boolean> {
  if (S().active) throw fail(new Error('Wait for the running job to finish'))
  if (!confirmDiscardIfDirty(confirm)) return false
  try {
    const handle = await api.project.open(path)
    await adoptProject(handle.dir, handle.project)
    return true
  } catch (e) {
    return fail(e)
  }
}

export async function chooseAndOpenProject(): Promise<void> {
  const file = await api.dialog.openFile(PROJECT_FILTERS).catch(fail)
  if (file) await openProject(file)
}

export function closeProject(confirm: ConfirmDiscard = defaultConfirm): boolean {
  if (S().active) return false
  if (!confirmDiscardIfDirty(confirm)) return false
  setJobProjectDir(null)
  S().closeProject()
  S().resetRig()
  S().resetPoseInputs()
  S().setLoadedClip(null)
  S().setPoseNotice(null)
  S().setHands(NO_HANDS)
  S().setWeapons([])
  S().selectWeapon(null)
  S().setBake(null)
  S().setBakeResult(null)
  S().setStep('import')
  return true
}

/** Saves the project JSON (and, in the main process, rig/markers.json from rigDraft.markers). */
export async function saveProject(): Promise<void> {
  if (!S().dir || !S().data) return
  syncPoseToProject(false) // project.pose from the pose inputs (contracts section 13)
  const { dir, data } = S()
  if (!dir || !data) return
  try {
    await api.project.save(dir, data)
    S().markSaved(data)
  } catch (e) {
    fail(e)
  }
}

// ---------------------------------------------------------------------------------------------------
// Import step

export function requireProject(): { dir: string; data: ProjectData } {
  const { dir, data } = S()
  if (!dir || !data) throw new Error('No project is open')
  return { dir, data }
}

/**
 * Copies a model into the project, then runs the import job with the automatic orientation. A new
 * model starts without a parts choice (the job separates props by itself) unless `objects` gives one.
 */
export function importModel(file: string, objects?: PartsChoice): Promise<ImportJobResult> {
  return withJob('import', 'Importing the model', async () => {
    const { dir } = requireProject()
    const copied = await api.project.importModel(dir, file)
    // The main process saved the project with the new source and rig = null; keep our other edits.
    const source = copied.project.source && objects ? { ...copied.project.source, objects: { ...objects } } : copied.project.source
    S().updateProject((d) => ({ ...d, source, rig: null, rigDraft: { markers: null } }))
    S().resetRig()
    await saveProject()
    return importJob(undefined)
  })
}

export async function chooseAndImportModel(): Promise<void> {
  const file = await api.dialog.openFile(MODEL_FILTERS).catch(fail)
  if (file) await importModel(file)
}

/**
 * Re-runs the import job with an explicit orientation ("Apply"), or with the saved/automatic one;
 * `objects` is a new parts choice (else the saved one is sent again).
 */
export function rerunImport(orientation?: Orientation, objects?: PartsChoice): Promise<ImportJobResult> {
  return withJob('import', 'Importing the model', () => importJob(orientation ?? S().data?.source?.orientation ?? undefined, objects))
}

/** The Parts list's "Apply": imports again with `objects` (a boolean per object) and the current orientation. */
export function applyParts(objects: PartsChoice): Promise<ImportJobResult> {
  return rerunImport(undefined, objects)
}

async function importJob(orientation: Orientation | undefined, objects?: PartsChoice): Promise<ImportJobResult> {
  const { data } = requireProject()
  if (!data.source) throw new Error('Choose a model first')
  const saved = data.source.objects
  const choice = objects ?? saved
  const args: Record<string, unknown> = { file: data.source.file }
  if (orientation) args.orientation = pickOrientation(orientation)
  if (choice) args.objects = { ...choice }
  const before = S().importInfo
  const result = await job<ImportJobResult>('import', args)
  const s = S()
  const used = pickOrientation(result.orientation_used)
  // scene.blend was rebuilt. With a new orientation or other parts in the character, markers and any
  // rig made from the old scene no longer apply; with the same ones (a re-run) they stay valid.
  // Without the last summary to compare with, a changed parts choice counts as other parts.
  const partsChanged = before ? !sameObjects(before.objects, result.objects) : !sameChoice(saved, choice)
  const changed = partsChanged || !sameOrientation(s.data?.source?.orientation, used)
  const withImport = (d: ProjectData): ProjectData['source'] =>
    d.source ? { ...d.source, orientation: used, ...(choice ? { objects: { ...choice } } : {}) } : d.source
  if (changed) {
    s.resetRig()
    s.updateProject((d) => ({ ...d, source: withImport(d), rig: null, rigDraft: { markers: null } }))
  } else {
    s.updateProject((d) => ({ ...d, source: withImport(d) }))
  }
  s.setImportInfo(result)
  s.setPreview(projectUrl(result.preview_glb || 'rig/preview.glb', nextVersion()))
  await saveProject()
  return result
}

// ---------------------------------------------------------------------------------------------------
// Rig step

/** "Find joints": suggest_markers; the markers become the draft and the suggestion. */
export function findJoints(): Promise<SuggestMarkersResult> {
  return withJob('suggest_markers', 'Finding joints', async () => {
    requireProject()
    const result = await job<SuggestMarkersResult>('suggest_markers', {})
    S().setMarkers(result.markers, { asSuggestion: true, warnings: result.warnings ?? [] })
    S().setView('markers')
    S().select(null)
    await saveProject()
    return result
  })
}

/** "Reset to suggestion": the last suggestion, or a new "Find joints" when none is in memory. */
export async function resetMarkers(): Promise<void> {
  if (!S().resetMarkersToSuggestion()) await findJoints()
}

export function suggestMapping(): Promise<SuggestMappingResult> {
  return withJob('suggest_mapping', 'Reading the skeleton', async () => {
    requireProject()
    const result = await job<SuggestMappingResult>('suggest_mapping', {})
    S().setMappingSuggestion(result)
    return result
  })
}

/** Model bone names, from the import summary or the mapping suggestion. */
export function modelBoneNames(): string[] {
  const s = S()
  const names = new Set<string>()
  for (const b of s.importInfo?.armature_bones ?? []) names.add(b.name)
  for (const b of Object.keys(s.mapping?.mapping ?? {})) names.add(b)
  return [...names]
}

/** Builds the rig from the markers ("auto") or the bone mapping ("imported"), then loads it. */
export function buildRig(path: 'auto' | 'imported' = S().rigPath): Promise<RigJobResult> {
  return withJob('rig', 'Building the rig', async () => {
    requireProject()
    let args: Record<string, unknown>
    if (path === 'auto') {
      const markers = S().markers
      if (!markers) throw new Error('Run "Find joints" first')
      await saveProject() // writes rig/markers.json with the edited markers
      args = { markers }
    } else {
      const edits = S().mappingEdits
      args = { mapping: Object.keys(edits).length ? mappingForJob(edits, modelBoneNames()) : {} }
    }
    const result = await job<RigJobResult>('rig', args)
    S().updateProject((d) => ({ ...d, rig: { kind: path, hash: result.hash } }))
    S().setRigPath(path)
    await loadRigFiles(nextVersion(), result)
    await saveProject()
    return result
  })
}

/** Loads rig/rig.json and points the viewer at rig/rig.glb. */
export async function loadRigFiles(version: number, result?: RigJobResult): Promise<void> {
  const res = await fetch(projectUrl('rig/rig.json', version))
  if (!res.ok) throw new Error(`rig/rig.json: HTTP ${res.status}`)
  const rig = (await res.json()) as RigJson
  if (rig.schema !== 'mpm.rig/1' || !Array.isArray(rig.bones)) throw new Error('rig/rig.json is not a rig file')
  S().setRig(rig, projectUrl('rig/rig.glb', version), result)
}

// ---------------------------------------------------------------------------------------------------
// Camera helpers

/** Focuses the camera on one marker. */
export function focusMarker(name: string): void {
  const s = S()
  const m = s.markers?.[name]
  if (!m) return
  s.select(name)
  const t = vecB2T(m.p)
  s.requestFocus([t.x, t.y, t.z], (isFingerMarker(name) ? 0.04 : 0.12) * markerHeight(s.markers ?? {}))
}

/** "Zoom to hand L/R": frames the wrist and finger markers of one side. */
export function zoomToHand(side: 'L' | 'R'): void {
  const s = S()
  const markers = s.markers
  if (!markers) return
  const pts = handMarkerNames(markers, side).map((n) => vecB2T(markers[n].p))
  if (pts.length === 0) return
  const c = pts.reduce((acc, p) => acc.add(p), new Vector3()).multiplyScalar(1 / pts.length)
  const r = Math.max(0.03, ...pts.map((p) => p.distanceTo(c)))
  s.requestFocus([c.x, c.y, c.z], r * 1.4)
}
