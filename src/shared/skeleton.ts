// SPDX-License-Identifier: GPL-3.0-or-later
// Loads resources/skeleton.json and expands it. Mirrors engine/mpm/skeleton.py.
import skeleton from '../../resources/skeleton.json'

export interface Joint {
  name: string
  editable: boolean
}

export interface Bone {
  name: string
  head: string
  tail: string
  parent: string | null
  connected: boolean
  deform: boolean
}

interface Side {
  s: string
  S: string
  sign: number
}

const sides: readonly Side[] = skeleton.sides

const isSided = (entry: unknown): boolean => /\{[sS]\}/.test(JSON.stringify(entry))

function sub(text: string, side: Side | null): string {
  if (side === null) return text
  return text.replaceAll('{s}', side.s).replaceAll('{S}', side.S)
}

// Entries with {s}/{S} are emitted once per side (L then R) in place; others once.
function expandEntries<E, R>(entries: readonly E[], build: (entry: E, side: Side | null) => R): R[] {
  const out: R[] = []
  for (const entry of entries) {
    if (isSided(entry)) {
      for (const side of sides) out.push(build(entry, side))
    } else {
      out.push(build(entry, null))
    }
  }
  return out
}

export const JOINTS: Joint[] = expandEntries(skeleton.joints, (j, side) => ({
  name: sub(j.name, side),
  editable: j.editable
}))

export const BONES: Bone[] = expandEntries(skeleton.bones, (b, side) => ({
  name: sub(b.name, side),
  head: sub(b.head, side),
  tail: sub(b.tail, side),
  parent: b.parent === null ? null : sub(b.parent, side),
  connected: b.connected,
  deform: b.deform
}))

/** Index of a bone in BONES, or -1 if unknown. */
export function boneIndex(name: string): number {
  return BONES.findIndex((b) => b.name === name)
}

/** Swaps a trailing .L/.R or _L/_R. Other names are returned unchanged. */
export function mirrorName(name: string): string {
  const m = /^(.*)([._])([LR])$/.exec(name)
  if (!m) return name
  return m[1] + m[2] + (m[3] === 'L' ? 'R' : 'L')
}
