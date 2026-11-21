// SPDX-License-Identifier: GPL-3.0-or-later
// Pure helpers for the parts of an imported file: the Import step's "Parts" ticks (which objects are
// the character) and the props the import job left out (offered as weapons in the Weapons step).
import type { ImportJobResult, ImportObjectInfo } from '../../shared/jobResults'
import type { PartsChoice, WeaponEntry } from '../../shared/project'

const NO_PARTS: ImportObjectInfo[] = []

/**
 * The objects the "Parts" list offers: every mesh of the file when it has more than one. Empty for a
 * one-object file and for an import summary written before parts existed. Returns the summary's own
 * array, so the list keeps its identity between renders.
 */
export function partsOf(info: Pick<ImportJobResult, 'all_objects'> | null | undefined): ImportObjectInfo[] {
  const all = info?.all_objects
  return Array.isArray(all) && all.length > 1 ? all : NO_PARTS
}

/** `{name: included}` for every part: the ticks as the last import left them. */
export function includedMap(parts: ImportObjectInfo[]): PartsChoice {
  const out: PartsChoice = {}
  for (const p of parts) out[p.name] = p.included === true
  return out
}

/** The ticks with one part switched. */
export function withTick(ticks: PartsChoice, name: string, on: boolean): PartsChoice {
  return { ...ticks, [name]: on }
}

/** The import job's `objects` argument: a boolean for every part (a part without a tick keeps `included`). */
export function partsChoice(parts: ImportObjectInfo[], ticks: PartsChoice): PartsChoice {
  const out: PartsChoice = {}
  for (const p of parts) out[p.name] = ticks[p.name] ?? p.included === true
  return out
}

/** "Apply" is offered only when a tick differs from what the last import included. */
export function partsDirty(parts: ImportObjectInfo[], ticks: PartsChoice): boolean {
  return parts.some((p) => (ticks[p.name] ?? p.included === true) !== (p.included === true))
}

/** Two parts choices name the same objects with the same values (absent = no choice made). */
export function sameChoice(a: PartsChoice | null | undefined, b: PartsChoice | null | undefined): boolean {
  const x = a ?? {}
  const y = b ?? {}
  const keys = Object.keys(x)
  return keys.length === Object.keys(y).length && keys.every((k) => k in y && x[k] === y[k])
}

/** Two imports kept the same objects in the character (in any order). */
export function sameObjects(a: { name: string }[], b: { name: string }[]): boolean {
  if (a.length !== b.length) return false
  const names = new Set(a.map((o) => o.name))
  return b.every((o) => names.has(o.name))
}

export interface PropRow {
  /** Project-relative `props/<name>.glb`. */
  file: string
  objects: string[]
  /** Longest side of the prop's box, in centimetres. */
  longestCm: number
  /** A weapon made from this prop exists (matched by the weapon's `source`). */
  added: boolean
}

/** The Weapons step's "From this model" rows. Empty when the import summary has no props. */
export function propRows(info: Pick<ImportJobResult, 'props'> | null | undefined, weapons: Pick<WeaponEntry, 'source'>[]): PropRow[] {
  const props = info?.props
  if (!Array.isArray(props)) return []
  return props.map((p) => ({
    file: p.file,
    objects: Array.isArray(p.objects) ? p.objects : [],
    longestCm: Math.max(0, ...(Array.isArray(p.dims_m) ? p.dims_m : [])) * 100,
    added: weapons.some((w) => w.source === p.file)
  }))
}
