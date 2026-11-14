// SPDX-License-Identifier: GPL-3.0-or-later
// Pose-library clips in the renderer (contracts section 9): pack index and clip loading over
// mpm://library, an 8-clip cache, and the clip-list filter.
import type { Clip, PackClip, PackIndex } from '../../shared/clip'
import { parseClipF32 } from '../../shared/clip'

export const CLIP_CACHE_SIZE = 8

const seg = (s: string): string => encodeURIComponent(s)

export function libraryUrl(...parts: string[]): string {
  return `mpm://library/${parts.map(seg).join('/')}`
}

export function indexUrl(packId: string, version?: number): string {
  return `${libraryUrl('packs', packId, 'index.json')}${version !== undefined ? `?v=${version}` : ''}`
}

export function clipUrl(packId: string, clipId: string): string {
  return libraryUrl('packs', packId, 'clips', `${clipId}.f32`)
}

export function thumbUrl(packId: string, clipId: string, frame: number, version?: number): string {
  return `${libraryUrl('packs', packId, 'thumbs', `${clipId}_${frame}.png`)}${version !== undefined ? `?v=${version}` : ''}`
}

/** The frame a clip's thumbnail shows: its first key frame, else frame 0. */
export function thumbFrame(clip: PackClip): number {
  const k = clip.key_frames?.[0]
  return typeof k === 'number' && k >= 0 && k < clip.frames ? k : 0
}

type Fetch = (url: string) => Promise<Response>
const defaultFetch: Fetch = (url) => fetch(url)

export async function fetchPackIndex(packId: string, version?: number, get: Fetch = defaultFetch): Promise<PackIndex> {
  const res = await get(indexUrl(packId, version))
  if (!res.ok) throw new Error(`pack ${packId} is not installed (index.json: HTTP ${res.status})`)
  const index = (await res.json()) as PackIndex
  if (!Array.isArray(index.clips) || !Array.isArray(index.joints)) throw new Error(`pack ${packId}: index.json is not a pack index`)
  return index
}

/** A parsed clip together with where it came from. */
export interface LoadedClip {
  packId: string
  clipId: string
  entry: PackClip
  clip: Clip
  frames: number
  frame: Clip['frame']
}

/** Least-recently-used cache of parsed clips (the last 8). */
export class ClipCache {
  private readonly map = new Map<string, LoadedClip>()

  constructor(
    private readonly size = CLIP_CACHE_SIZE,
    private readonly get: Fetch = defaultFetch
  ) {}

  has(packId: string, clipId: string): boolean {
    return this.map.has(`${packId}/${clipId}`)
  }

  keys(): string[] {
    return [...this.map.keys()]
  }

  clear(packId?: string): void {
    if (!packId) return this.map.clear()
    for (const k of [...this.map.keys()]) if (k.startsWith(`${packId}/`)) this.map.delete(k)
  }

  async load(packId: string, index: PackIndex, clipId: string): Promise<LoadedClip> {
    const key = `${packId}/${clipId}`
    const hit = this.map.get(key)
    if (hit) {
      this.map.delete(key)
      this.map.set(key, hit)
      return hit
    }
    const entry = index.clips.find((c) => c.id === clipId)
    if (!entry) throw new Error(`clip ${clipId} is not in pack ${packId}`)
    const res = await this.get(clipUrl(packId, clipId))
    if (!res.ok) throw new Error(`clip ${clipId}: HTTP ${res.status}`)
    const clip = parseClipF32(await res.arrayBuffer(), entry.joints ?? index.joints)
    const loaded: LoadedClip = { packId, clipId, entry, clip, frames: clip.frames, frame: (i) => clip.frame(i) }
    this.map.set(key, loaded)
    while (this.map.size > this.size) this.map.delete(this.map.keys().next().value as string)
    return loaded
  }
}

/** Every tag of a pack's clips, most used first. */
export function allTags(clips: PackClip[]): string[] {
  const count = new Map<string, number>()
  for (const c of clips) for (const t of c.tags ?? []) count.set(t, (count.get(t) ?? 0) + 1)
  return [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t)
}

/**
 * The clip-list filter: every word of `text` must appear in the id, move, style or a tag
 * (case-insensitive), and the clip must have every selected tag.
 */
export function filterClips(clips: PackClip[], text: string, tags: string[]): PackClip[] {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean)
  return clips.filter((c) => {
    const ctags = c.tags ?? []
    if (!tags.every((t) => ctags.includes(t))) return false
    if (words.length === 0) return true
    const hay = [c.id, c.move, c.style, ...ctags].join(' ').toLowerCase()
    return words.every((w) => hay.includes(w))
  })
}

/** Rows to render for a fixed-height virtual list (with `overscan` extra rows on each side). */
export function visibleRange(scrollTop: number, viewHeight: number, rowHeight: number, count: number, overscan = 6): [number, number] {
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan)
  const last = Math.min(count, Math.ceil((scrollTop + viewHeight) / rowHeight) + overscan)
  return [first, Math.max(first, last)]
}
