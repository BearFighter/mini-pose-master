// SPDX-License-Identifier: GPL-3.0-or-later
// Path and URL helpers for the renderer (no Node path module here).

/** Last segment of a Windows or POSIX path. */
export function basename(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '')
  const i = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return i >= 0 ? trimmed.slice(i + 1) : trimmed
}

/** Everything before the last segment ('' when there is none). */
export function dirname(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '')
  const i = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (i < 0) return ''
  const head = trimmed.slice(0, i)
  // keep the root of "C:\x" and "/x"
  return /^[A-Za-z]:$/.test(head) ? head + trimmed[i] : head === '' ? trimmed[i] : head
}

/** Project display name: the project folder's name. */
export function projectName(dir: string): string {
  return basename(dir) || dir
}

/**
 * `mpm://project/<relative path>` (contracts section 17), each segment URL-encoded, with an optional
 * cache-busting `?v=` after a job has rewritten the file.
 */
export function projectUrl(relPath: string, version?: number | string): string {
  const encoded = relPath
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s !== '')
    .map(encodeURIComponent)
    .join('/')
  return `mpm://project/${encoded}${version !== undefined ? `?v=${encodeURIComponent(String(version))}` : ''}`
}
