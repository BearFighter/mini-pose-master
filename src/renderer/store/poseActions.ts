// SPDX-License-Identifier: GPL-3.0-or-later
// Pose step flows: the pose library (list, install, remove, own BVH, clips) and pose edits
// (frame, gizmo rotate/reach, mirror, plant, reset, copy side, undo/redo), plus project.pose.
import type { ComposeResult, EditOp } from '../../shared/composePose'
import { toggleMirror } from '../../shared/composePose'
import type { QuatWXYZ, Vec3 } from '../../shared/coords'
import type { FileFilter } from '../../shared/ipc'
import type { PoseState } from '../../shared/poseState'
import type { ProjectData } from '../../shared/project'
import { api } from '../api'
import { ClipCache, fetchPackIndex, thumbFrame } from '../lib/clips'
import { normaliseHands } from '../lib/hands'
import {
  appendReach,
  appendRotate,
  clipMissing,
  computePose,
  copySideOps,
  inputsFromProvenance,
  poseStateFor,
  provenanceFromInputs,
  removeBoneEdits,
  setupInputs,
  showsSetupStance,
  type PoseInputsState
} from '../lib/pose'
import { type ConfirmDiscard, defaultConfirm, fail, S } from './flow'
import { useStore } from './index'

export const BVH_FILTERS: FileFilter[] = [{ name: 'BVH motion capture', extensions: ['bvh'] }]

/** The last 8 clips (contracts: "Cache the last 8 clips"). */
export const clipCache = new ClipCache()

// ---------------------------------------------------------------------------------------------------
// Library

export async function refreshPacks(): Promise<void> {
  try {
    S().setPacks(await api.library.list())
  } catch (e) {
    fail(e)
  }
}

/** Selects a pack and loads its index.json (null clears the selection). */
export async function selectPack(packId: string | null): Promise<void> {
  S().setSelectedPack(packId)
  if (!packId) return
  try {
    const index = await fetchPackIndex(packId, S().libraryVersion)
    if (S().selectedPack === packId) S().setSelectedPack(packId, index)
  } catch (e) {
    fail(e)
  }
}

function packTitle(packId: string): string {
  return S().packs?.find((p) => p.id === packId)?.title ?? packId
}

async function afterInstall(packId: string, result: { clips: number; failed: { file: string; error: string }[] }): Promise<void> {
  clipCache.clear(packId)
  S().bumpLibraryVersion()
  await refreshPacks()
  if (S().selectedPack === packId || !S().selectedPack) await selectPack(packId)
  if (result.failed.length) {
    const first = result.failed[0]
    S().setError({
      code: 'E_IMPORT_FAILED',
      message: `${packTitle(packId)}: ${result.clips} clips installed, ${result.failed.length} could not be converted (${first.file}: ${first.error})`
    })
  }
}

async function withInstall<T>(packId: string, body: () => Promise<T>): Promise<T> {
  S().setInstallProgress(packId, { stage: 'start', fraction: 0 })
  try {
    return await body()
  } catch (e) {
    return fail(e)
  } finally {
    S().setInstallProgress(packId, null)
  }
}

/** A downloadable pack, after the license was accepted in the dialog. */
export function installPack(packId: string): Promise<void> {
  return withInstall(packId, async () => afterInstall(packId, await api.library.install(packId)))
}

/** A user-supplied pack from chosen .zip / .bvh files or folders. */
export function installPackFromFiles(packId: string, files: string[], append = false): Promise<void> {
  return withInstall(packId, async () => afterInstall(packId, await api.library.installFromFile(packId, files, append)))
}

/** "Update": converts the pack's sources again (after a converter update). */
export function updatePack(packId: string): Promise<void> {
  return withInstall(packId, async () => afterInstall(packId, await api.library.reconvert(packId)))
}

export async function cancelInstall(packId: string): Promise<void> {
  await api.library.cancel(packId).catch(fail)
}

export async function removePack(packId: string, confirm: ConfirmDiscard = defaultConfirm): Promise<boolean> {
  if (!confirm(`Remove "${packTitle(packId)}" and its clips from the library?`)) return false
  try {
    await api.library.remove(packId)
  } catch (e) {
    fail(e)
  }
  clipCache.clear(packId)
  if (S().loadedClip?.packId === packId) S().setLoadedClip(null)
  S().bumpLibraryVersion()
  await refreshPacks()
  if (S().selectedPack === packId) S().setSelectedPack(null)
  return true
}

/** "Import my own BVH…": converts one file into the `mine` pack and selects it. */
export async function importOwnBvh(file?: string): Promise<{ packId: string; clipIds: string[] }> {
  const path = file ?? (await api.dialog.openFile(BVH_FILTERS).catch(fail))
  if (!path) return { packId: 'mine', clipIds: [] }
  const result = await withInstall('mine', () => api.library.importClip(path))
  clipCache.clear(result.packId)
  S().bumpLibraryVersion()
  await refreshPacks()
  await selectPack(result.packId)
  return result
}

/** Loads a clip of the selected (or given) pack into loadedClip. */
async function loadClip(packId: string, clipId: string): Promise<boolean> {
  let index = S().selectedPack === packId ? S().packIndex : null
  if (!index) index = await fetchPackIndex(packId, S().libraryVersion)
  S().setLoadingClip(`${packId}/${clipId}`)
  try {
    S().setLoadedClip(await clipCache.load(packId, index, clipId))
    return true
  } finally {
    S().setLoadingClip(null)
  }
}

/** Picks a clip as the pose source (at its first key frame); edits, mirror and plant are kept. */
export async function selectClip(packId: string, clipId: string): Promise<void> {
  try {
    await loadClip(packId, clipId)
  } catch (e) {
    fail(e)
  }
  const loaded = S().loadedClip
  if (!loaded) return
  const { poseInputs } = S()
  S().commitPose({ ...poseInputs, source: { pack: packId, clip: clipId, frame: thumbFrame(loaded.entry) } })
  syncPoseToProject(true)
  S().setPoseNotice(null)
  S().requestFrame()
}

/** "No clip": back to the rest pose (edits kept). */
export function clearSource(): void {
  S().commitPose({ ...S().poseInputs, source: null })
}

// ---------------------------------------------------------------------------------------------------
// The derived pose

/** composePose of the committed inputs plus any preview; null without a rig. */
export function currentPose(withPreview = true): ComposeResult | null {
  const s = S()
  if (!s.rigJson) return null
  return computePose(s.rigJson, s.poseInputs, withPreview ? s.posePreview : null, s.loadedClip, s.hands, s.weapons)
}

/**
 * The pose the viewer shows: the setup stance in the Weapons and Hands steps (lib/pose setupInputs, never
 * stored), else currentPose. Hands, weapons and any preview are included.
 */
export function displayPose(withPreview = true): ComposeResult | null {
  const s = S()
  if (!s.rigJson) return null
  if (!showsSetupStance(s.step)) return currentPose(withPreview)
  return computePose(s.rigJson, setupInputs(s.rigJson, s.weapons), withPreview ? s.posePreview : null, null, s.hands, s.weapons)
}

/** project.pose for the committed inputs; null without a rig. */
export function currentPoseState(): PoseState | null {
  const s = S()
  const pose = currentPose(false)
  return s.rigJson && pose ? poseStateFor(s.rigJson, pose.deltas, s.poseInputs) : null
}

/**
 * Writes project.pose (deltas from composePose with hands and weapons), project.hands and
 * project.weapons from the pose history's current state. When the source clip is not available and the
 * inputs are the ones the project was saved with, the stored pose (made with the clip) is kept as it is.
 */
export function syncPoseToProject(markDirty: boolean): void {
  const s = S()
  if (!s.data) return
  const hands = { L: s.hands.L, R: s.hands.R, locked: { L: [...s.hands.locked.L], R: [...s.hands.locked.R] } }
  let pose = s.data.pose
  if (s.rigJson) {
    const missing = clipMissing(s.poseInputs, s.loadedClip)
    const keep =
      missing &&
      pose &&
      JSON.stringify(pose.provenance) === JSON.stringify(provenanceFromInputs(s.poseInputs)) &&
      JSON.stringify(normaliseHands(s.data.hands)) === JSON.stringify(hands) &&
      JSON.stringify(s.data.weapons ?? []) === JSON.stringify(s.weapons)
    if (!keep) pose = currentPoseState() ?? pose
  }
  const data: ProjectData = { ...s.data, pose, hands, weapons: s.weapons }
  useStore.setState(markDirty ? { data, dirty: true } : { data })
}

/**
 * After a project (and its rig) loaded: restores the inputs from project.pose.provenance, loads the
 * clip, and tells the user when the pose had to be re-applied or the clip is missing.
 */
export async function restorePoseFromProject(data: ProjectData): Promise<void> {
  const s = S()
  s.setLoadedClip(null)
  s.setPoseNotice(null)
  const inputs = inputsFromProvenance(data.pose?.provenance)
  s.resetPoseInputs(inputs)
  if (!data.pose || !s.rigJson) return
  let haveClip = true
  if (inputs.source) {
    try {
      await refreshPacks()
      await selectPack(inputs.source.pack)
      haveClip = await loadClip(inputs.source.pack, inputs.source.clip)
    } catch {
      haveClip = false
      S().dismissError()
    }
  }
  const rebuilt = data.pose.rig_hash !== S().rigJson?.hash
  if (inputs.source && !haveClip) {
    S().setPoseNotice(
      `The clip "${inputs.source.clip}" is not available: showing the rest pose with your edits. Install the "${packTitle(inputs.source.pack)}" pack to restore it.`
    )
    if (rebuilt) syncPoseToProject(true)
  } else if (rebuilt) {
    S().setPoseNotice('Pose re-applied to the rebuilt rig.')
    syncPoseToProject(true)
  }
}

// ---------------------------------------------------------------------------------------------------
// Edits (each commit is one undo step)

function commit(next: PoseInputsState, gestureBone: string | null = null): void {
  S().commitPose(next, { gestureBone })
  syncPoseToProject(true)
}

export function previewFrame(frame: number): void {
  const p = S().posePreview
  S().setPosePreview({ ...(p ?? {}), frame })
}

export function commitFrame(frame: number): void {
  const { poseInputs, loadedClip } = S()
  if (!poseInputs.source) return
  const max = loadedClip ? loadedClip.frames - 1 : frame
  commit({ ...poseInputs, source: { ...poseInputs.source, frame: Math.max(0, Math.min(max, Math.round(frame))) } })
}

/** The gizmo is being dragged: show the rotation without committing it. */
export function previewRotate(bone: string, q: QuatWXYZ, chain: boolean): void {
  S().setPosePreview({ op: { kind: 'rotate', bone, q, chain } })
}

/** Gizmo released: commit the rotation, merged with the previous drag of the same bone and mode. */
export function commitRotate(bone: string, q: QuatWXYZ, chain: boolean): void {
  const { poseInputs, gestureBone } = S()
  const edits = appendRotate(poseInputs.edits, { kind: 'rotate', bone, q, chain }, gestureBone === bone)
  commit({ ...poseInputs, edits }, bone)
}

export function previewReach(side: 'L' | 'R', target: Vec3): void {
  S().setPosePreview({ op: { kind: 'reach', side, target } })
}

export function commitReach(side: 'L' | 'R', target: Vec3): void {
  const { poseInputs } = S()
  commit({ ...poseInputs, edits: appendReach(poseInputs.edits, { kind: 'reach', side, target }) })
}

export function cancelPreview(): void {
  S().setPosePreview(null)
}

export function togglePoseMirror(): void {
  const { poseInputs } = S()
  commit({ ...poseInputs, ...toggleMirror(poseInputs), source: poseInputs.source })
}

export function setPlanted(planted: boolean): void {
  commit({ ...S().poseInputs, planted })
}

export function resetBone(bone: string): void {
  const { poseInputs } = S()
  commit({ ...poseInputs, edits: removeBoneEdits(poseInputs.edits, bone) })
}

export function clearEdits(): void {
  commit({ ...S().poseInputs, edits: [] })
}

/** "Copy pose L→R" (from 'L') / "R→L". */
export function copySide(from: 'L' | 'R'): void {
  const s = S()
  const pose = currentPose(false)
  if (!s.rigJson || !pose) return
  const ops: EditOp[] = copySideOps(s.rigJson, pose.deltas, from)
  if (ops.length) commit({ ...s.poseInputs, edits: [...s.poseInputs.edits, ...ops] })
}

export function undoPose(): void {
  if (S().undoPose()) syncPoseToProject(true)
}

export function redoPose(): void {
  if (S().redoPose()) syncPoseToProject(true)
}
