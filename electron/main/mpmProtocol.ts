// SPDX-License-Identifier: GPL-3.0-or-later
// mpm:// file protocol: contracts section 17.
import { net } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { libraryDir } from './paths'

export interface MpmRoots {
  project: string | null
  library: string
}

let projectRoot: string | null = null

export function setProjectRoot(dir: string | null): void {
  projectRoot = dir
}

export function getRoots(): MpmRoots {
  return { project: projectRoot, library: libraryDir() }
}

const PREFIX = 'mpm://'

/**
 * Maps an mpm:// URL to an absolute file path inside one of the roots.
 * Returns null when the root is missing or the path escapes it.
 * The URL is split by hand: WHATWG URL parsing would silently remove `..` segments.
 */
export function resolveMpmUrl(url: string, roots: MpmRoots): string | null {
  if (!url.startsWith(PREFIX)) return null
  const rest = url.slice(PREFIX.length)
  const slash = rest.indexOf('/')
  if (slash < 0) return null

  const host = rest.slice(0, slash)
  const root = host === 'project' ? roots.project : host === 'library' ? roots.library : null
  if (!root) return null

  let rel: string
  try {
    rel = decodeURIComponent(rest.slice(slash + 1))
  } catch {
    return null
  }
  if (path.isAbsolute(rel)) return null

  const abs = path.resolve(root, rel)
  const inside = path.relative(root, abs)
  if (inside.startsWith('..') || path.isAbsolute(inside)) return null
  return abs
}

/** Handler for protocol.handle('mpm', ...). Answers 403 for anything outside the roots. */
export async function handleMpmRequest(request: Request): Promise<Response> {
  const file = resolveMpmUrl(request.url, getRoots())
  if (file === null) return new Response('Forbidden', { status: 403 })
  return net.fetch(pathToFileURL(file).toString())
}
