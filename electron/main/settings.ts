// SPDX-License-Identifier: GPL-3.0-or-later
// App settings: a JSON file at dataDir()/settings.json. Node built-ins only.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { isEnoent, writeFileAtomic } from './fsutil'
import { dataDir } from './paths'

/** A recorded license acceptance for one pose pack (contracts section 20). */
export interface LicenseAcceptance {
  license: string
  /** ISO 8601 time of the acceptance. */
  acceptedAt: string
}

export interface Settings {
  /** Blender executable chosen by the user, or the one the app downloaded. */
  blenderPath?: string
  /** Pose-pack license acceptances, by pack id. */
  licenses?: Record<string, LicenseAcceptance>
}

export function settingsFile(dir: string = dataDir()): string {
  return path.join(dir, 'settings.json')
}

function sanitizeLicenses(raw: unknown): Record<string, LicenseAcceptance> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, LicenseAcceptance> = {}
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    const { license, acceptedAt } = (value ?? {}) as Record<string, unknown>
    if (typeof license === 'string' && typeof acceptedAt === 'string') out[id] = { license, acceptedAt }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function sanitize(raw: unknown): Settings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const settings: Settings = {}
  const { blenderPath, licenses } = raw as Record<string, unknown>
  if (typeof blenderPath === 'string' && blenderPath !== '') settings.blenderPath = blenderPath
  const cleanLicenses = sanitizeLicenses(licenses)
  if (cleanLicenses) settings.licenses = cleanLicenses
  return settings
}

/** Reads the settings. A missing or unreadable (corrupt) file gives the defaults `{}`. */
export async function loadSettings(file: string = settingsFile()): Promise<Settings> {
  let text: string
  try {
    text = await fs.readFile(file, 'utf8')
  } catch (e) {
    if (isEnoent(e)) return {}
    throw e
  }
  try {
    return sanitize(JSON.parse(text))
  } catch {
    return {}
  }
}

/** Writes the settings atomically (temp file + rename), creating the data folder if needed. */
export async function saveSettings(settings: Settings, file: string = settingsFile()): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await writeFileAtomic(file, JSON.stringify(sanitize(settings), null, 2) + '\n')
}

// Read-modify-write updates of one file run one after another, so concurrent updates
// (a Blender path and a license acceptance, say) never overwrite each other.
const updateChains = new Map<string, Promise<unknown>>()

/** Loads, applies `change` and saves, serialised per settings file. Returns the new settings. */
export function modifySettings(change: (current: Settings) => Settings, file: string = settingsFile()): Promise<Settings> {
  const key = path.resolve(file)
  const previous = updateChains.get(key) ?? Promise.resolve()
  const next = previous
    .catch(() => {})
    .then(async () => {
      const updated = change(await loadSettings(file))
      await saveSettings(updated, file)
      return sanitize(updated)
    })
  updateChains.set(key, next)
  void next.finally(() => {
    if (updateChains.get(key) === next) updateChains.delete(key)
  }).catch(() => {})
  return next
}

/** Applies `patch` (an `undefined` value removes the key). Returns the new settings. */
export function updateSettings(patch: Partial<Settings>, file: string = settingsFile()): Promise<Settings> {
  return modifySettings((current) => {
    const next: Settings = { ...current, ...patch }
    for (const key of Object.keys(next) as (keyof Settings)[]) {
      if (next[key] === undefined) delete next[key]
    }
    return next
  }, file)
}
