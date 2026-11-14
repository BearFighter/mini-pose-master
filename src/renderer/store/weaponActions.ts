// SPDX-License-Identifier: GPL-3.0-or-later
// Weapons step flows (contracts section 12): add (copy + convert_weapon), units, attach hand, print
// separately, scale, gizmo offsets, grip point, two-handed support grip, remove. Each change is one step
// of the pose history.
import type { Vec3 } from '../../shared/coords'
import type { FileFilter } from '../../shared/ipc'
import type { ConvertWeaponResult } from '../../shared/jobResults'
import type { WeaponEntry } from '../../shared/project'
import type { WeaponOffset } from '../../shared/weaponPose'
import { api } from '../api'
import { defaultOffset, flipAxis, nextWeaponId, supportFromHit, withGripPoint, withScale } from '../lib/weapons'
import { job, requireProject, saveProject, withJob } from './actions'
import { type ConfirmDiscard, defaultConfirm, fail, S } from './flow'
import { syncPoseToProject } from './poseActions'

export const WEAPON_FILTERS: FileFilter[] = [{ name: 'Weapon models', extensions: ['fbx', 'glb', 'gltf', 'obj', 'stl'] }]
export const UNIT_CHOICES: { value: number; label: string }[] = [
  { value: 1, label: 'metres' },
  { value: 0.01, label: 'centimetres' },
  { value: 0.001, label: 'millimetres' }
]

/** The source file of each weapon converted in this session (to convert it again with other units). */
const sourceOf = new Map<string, string>()

function commitWeapons(weapons: WeaponEntry[]): void {
  S().commitHistory({ weapons })
  syncPoseToProject(true)
}

function update(id: string, change: (w: WeaponEntry) => WeaponEntry): void {
  const weapons = S().weapons
  if (!weapons.some((w) => w.id === id)) return
  commitWeapons(weapons.map((w) => (w.id === id ? change(w) : w)))
}

const center = (r: ConvertWeaponResult): Vec3 => [0, 1, 2].map((k) => (r.bbox_m[0][k] + r.bbox_m[1][k]) / 2) as Vec3

/**
 * "Add weapon…": copies the file (and its sidecars) into weapons/, converts it, and attaches it to a
 * free hand socket with the default placement (principal axis along the grip, bbox centre on the socket).
 */
export function addWeapon(file: string): Promise<WeaponEntry> {
  return withJob('convert_weapon', 'Converting the weapon', async () => {
    const { dir } = requireProject()
    const added = await api.project.addWeapon(dir, file)
    const result = await job<ConvertWeaponResult>('convert_weapon', { file: added.weaponFile })
    const weapons = S().weapons
    const id = nextWeaponId(weapons.map((w) => w.id))
    const used = new Set(weapons.map((w) => w.attach_bone))
    const attach = used.has('grip.R') && !used.has('grip.L') ? 'grip.L' : 'grip.R'
    const entry: WeaponEntry = {
      id,
      file: result.weapon_glb,
      attach_bone: attach,
      offset: defaultOffset(result.principal_axis, center(result), 1),
      support: { enabled: false, side: attach === 'grip.R' ? 'L' : 'R', point: center(result), normal: [-1, 0, 0], axis: result.principal_axis },
      merge: true
    }
    sourceOf.set(id, added.weaponFile)
    S().setWeaponInfo(id, result)
    commitWeapons([...weapons, entry])
    S().selectWeapon(id)
    await saveProject()
    return entry
  })
}

export async function chooseAndAddWeapon(): Promise<void> {
  const file = await api.dialog.openFile(WEAPON_FILTERS).catch(fail)
  if (file) await addWeapon(file)
}

/** Converts the weapon again with a unit scale; grip and support points scale with it. */
export function setWeaponUnits(id: string, unitScale: number): Promise<void> {
  return withJob('convert_weapon', 'Converting the weapon', async () => {
    const src = sourceOf.get(id)
    const w = S().weapons.find((x) => x.id === id)
    if (!src || !w) throw new Error('Add the weapon again to change its units')
    const before = S().weaponInfo[id]?.unit_scale_used ?? 1
    const result = await job<ConvertWeaponResult>('convert_weapon', { file: src, unit_scale: unitScale, out: w.file })
    const k = result.unit_scale_used / before
    S().setWeaponInfo(id, result)
    S().bumpWeaponVersion(id)
    update(id, (x) => ({
      ...x,
      offset: { ...x.offset, t: x.offset.t.map((v) => v * k) as Vec3 },
      support: x.support ? { ...x.support, point: x.support.point.map((v) => v * k) as Vec3 } : x.support
    }))
  })
}

export function setAttachSide(id: string, side: 'L' | 'R'): void {
  update(id, (w) => ({
    ...w,
    attach_bone: `grip.${side}`,
    support: w.support ? { ...w.support, side: side === 'R' ? 'L' : 'R' } : w.support
  }))
}

export function setPrintSeparately(id: string, separate: boolean): void {
  update(id, (w) => ({ ...w, merge: !separate }))
}

export function setWeaponScale(id: string, s: number): void {
  const clamped = Math.min(4, Math.max(0.25, s))
  update(id, (w) => ({ ...w, offset: withScale(w.offset, clamped) }))
}

/** The gizmo is being dragged: preview the offset (the support hand follows live). */
export function previewWeaponOffset(id: string, offset: WeaponOffset): void {
  S().setPosePreview({ weapons: S().weapons.map((w) => (w.id === id ? { ...w, offset } : w)) })
}

export function commitWeaponOffset(id: string, offset: WeaponOffset): void {
  update(id, (w) => ({ ...w, offset }))
}

/** "Set grip point": the clicked weapon-local point moves to the hand's socket. */
export function setGripPoint(id: string, point: Vec3): void {
  update(id, (w) => ({ ...w, offset: withGripPoint(w.offset, point) }))
  S().setWeaponTool('move')
}

/** Two-handed: the other hand supports. */
export function setTwoHanded(id: string, on: boolean): void {
  update(id, (w) => {
    const side = w.attach_bone === 'grip.L' ? 'R' : 'L'
    const info = S().weaponInfo[id]
    const support = w.support ?? { enabled: false, side, point: [0, 0, 0] as Vec3, normal: [-1, 0, 0] as Vec3, axis: info?.principal_axis ?? [0, 0, 1] }
    return { ...w, support: { ...support, enabled: on, side } }
  })
}

/** "Set support grip": point = clicked point, palm into the weapon, axis = the weapon's principal axis. */
export function setSupportGrip(id: string, point: Vec3, surfaceNormal: Vec3, axis: Vec3): void {
  update(id, (w) => {
    const side = w.attach_bone === 'grip.L' ? 'R' : 'L'
    return { ...w, support: { enabled: true, side, ...supportFromHit(point, surfaceNormal, w.support?.axis ?? axis) } }
  })
  S().setWeaponTool('move')
}

/** Sets the support grip exactly (e.g. from a weapon's known grip data). */
export function setSupport(id: string, support: { point: Vec3; normal: Vec3; axis: Vec3 }): void {
  update(id, (w) => ({ ...w, support: { enabled: true, side: w.attach_bone === 'grip.L' ? 'R' : 'L', ...support } }))
}

export function flipSupportAxis(id: string): void {
  update(id, (w) => (w.support ? { ...w, support: { ...w.support, axis: flipAxis(w.support.axis) } } : w))
}

export function removeWeapon(id: string, confirm: ConfirmDiscard = defaultConfirm): boolean {
  const w = S().weapons.find((x) => x.id === id)
  if (!w || !confirm(`Remove the weapon ${w.file}?`)) return false
  commitWeapons(S().weapons.filter((x) => x.id !== id))
  if (S().weaponSelection === id) S().selectWeapon(null)
  return true
}
