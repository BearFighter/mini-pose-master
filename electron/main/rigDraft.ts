// SPDX-License-Identifier: GPL-3.0-or-later
// Writes rig/markers.json (contracts section 4) from the project's `rigDraft.markers` as part of
// project.save, so edited markers reach the file without an extra IPC channel. Node built-ins only.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { MARKERS_SCHEMA, type MarkerEntry, type MarkerMap, type MarkersFile } from '../../src/shared/project'
import { writeFileAtomic } from './fsutil'

const JOINT_NAME_RE = /^[A-Za-z0-9_]+$/

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function marker(name: string, raw: unknown): MarkerEntry {
  const bad = (why: string) => new Error(`rigDraft.markers.${name}: ${why}`)
  if (!isPlainObject(raw)) throw bad('must be an object')
  const { p, confidence, source } = raw
  if (!Array.isArray(p) || p.length !== 3 || !p.every((v) => typeof v === 'number' && Number.isFinite(v))) {
    throw bad('p must be 3 finite numbers')
  }
  if (typeof confidence !== 'number' || !(confidence >= 0 && confidence <= 1)) throw bad('confidence must be in [0, 1]')
  if (source !== 'auto' && source !== 'user') throw bad('source must be "auto" or "user"')
  return { p: [p[0], p[1], p[2]], confidence, source }
}

/**
 * The markers file for a project, or null when the project has no draft markers.
 * Throws when `rigDraft.markers` is present but malformed (the save is then refused).
 */
export function draftMarkersFile(project: unknown): MarkersFile | null {
  if (!isPlainObject(project)) return null
  const draft = project.rigDraft
  if (draft === undefined || draft === null) return null
  if (!isPlainObject(draft)) throw new Error('rigDraft must be an object')
  const raw = draft.markers
  if (raw === undefined || raw === null) return null
  if (!isPlainObject(raw)) throw new Error('rigDraft.markers must be an object')
  const markers: MarkerMap = {}
  for (const [name, entry] of Object.entries(raw)) {
    if (!JOINT_NAME_RE.test(name)) throw new Error(`rigDraft.markers: invalid joint name ${JSON.stringify(name)}`)
    markers[name] = marker(name, entry)
  }
  return { schema: MARKERS_SCHEMA, markers }
}

/** Writes `<dir>/rig/markers.json` atomically. */
export async function writeMarkersFile(dir: string, file: MarkersFile): Promise<void> {
  const rigDir = path.join(path.resolve(dir), 'rig')
  await fs.mkdir(rigDir, { recursive: true })
  await writeFileAtomic(path.join(rigDir, 'markers.json'), JSON.stringify(file, null, 1) + '\n')
}
