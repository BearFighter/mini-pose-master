// SPDX-License-Identifier: GPL-3.0-or-later
// Small file-system helpers for the main process. Node built-ins only.
import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

// Windows reports these while a virus scanner or the indexer holds the target open for a moment.
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])
const RENAME_RETRIES = 10
const RENAME_RETRY_DELAY_MS = 50

function errorCode(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException | null)?.code
}

/** fs.rename, retried briefly when Windows reports the target as busy. */
export async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(from, to)
      return
    } catch (e) {
      if (attempt >= RENAME_RETRIES || !RENAME_RETRY_CODES.has(errorCode(e) ?? '')) throw e
      await new Promise((resolve) => setTimeout(resolve, RENAME_RETRY_DELAY_MS * (attempt + 1)))
    }
  }
}

/**
 * Writes `data` to `file` atomically: a temp file in the same folder (flushed to disk), then a rename
 * over the target. Readers see either the old or the new content, never a partial file.
 */
export async function writeFileAtomic(file: string, data: string | Uint8Array): Promise<void> {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`)
  try {
    const handle = await fs.open(tmp, 'w')
    try {
      await handle.writeFile(data)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await renameWithRetry(tmp, file)
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {})
    throw e
  }
}

export function isEnoent(e: unknown): boolean {
  return errorCode(e) === 'ENOENT'
}

/** True when both paths name the same location (after path.resolve; case-insensitive on Windows). */
export function samePath(a: string, b: string): boolean {
  return path.relative(path.resolve(a), path.resolve(b)) === ''
}

/** True when `child` is `parent` or lies inside it. */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}
