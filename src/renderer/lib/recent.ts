// SPDX-License-Identifier: GPL-3.0-or-later
// Recent projects (up to 8) in localStorage. Every access is wrapped: storage may be unavailable.
export interface RecentProject {
  dir: string
  name: string
  openedAt: number
}

export const RECENT_KEY = 'mpm.recentProjects'
export const RECENT_MAX = 8

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function storage(): StorageLike | null {
  try {
    return (globalThis as { localStorage?: StorageLike }).localStorage ?? null
  } catch {
    return null
  }
}

/** Same folder, ignoring separators, a trailing separator and case. */
const normDir = (d: string): string => d.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
const sameDir = (a: string, b: string): boolean => normDir(a) === normDir(b)

export function loadRecent(store: StorageLike | null = storage()): RecentProject[] {
  try {
    const raw = store?.getItem(RECENT_KEY)
    if (!raw) return []
    const list = JSON.parse(raw) as unknown
    if (!Array.isArray(list)) return []
    return list
      .filter((r): r is RecentProject => !!r && typeof r.dir === 'string' && typeof r.name === 'string')
      .map((r) => ({ dir: r.dir, name: r.name, openedAt: Number(r.openedAt) || 0 }))
      .slice(0, RECENT_MAX)
  } catch {
    return []
  }
}

function saveRecent(list: RecentProject[], store: StorageLike | null): void {
  try {
    store?.setItem(RECENT_KEY, JSON.stringify(list))
  } catch {
    // storage full or blocked: recent projects are a convenience only
  }
}

/** Puts a project at the top of the list (no duplicates, at most 8) and returns the new list. */
export function addRecent(entry: { dir: string; name: string }, store: StorageLike | null = storage(), now = Date.now()): RecentProject[] {
  const list = [{ dir: entry.dir, name: entry.name, openedAt: now }, ...loadRecent(store).filter((r) => !sameDir(r.dir, entry.dir))].slice(
    0,
    RECENT_MAX
  )
  saveRecent(list, store)
  return list
}

export function removeRecent(dir: string, store: StorageLike | null = storage()): RecentProject[] {
  const list = loadRecent(store).filter((r) => !sameDir(r.dir, dir))
  saveRecent(list, store)
  return list
}
