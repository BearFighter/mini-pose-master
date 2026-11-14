// SPDX-License-Identifier: GPL-3.0-or-later
// Shared helpers for the main-process tests.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { JobEvent } from '../../../src/shared/ipc'

export const HERE = path.dirname(fileURLToPath(import.meta.url))
export const FIXTURES = path.join(HERE, 'fixtures')
export const REPO = path.resolve(HERE, '..', '..', '..')

export function tempDir(prefix: string): string {
  return mkdtempSync(path.join(os.tmpdir(), `mpm-${prefix}-`))
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Every file below `dir` as sorted `/`-separated relative paths ([] when `dir` is missing). */
export function listFiles(dir: string, prefix = ''): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...listFiles(path.join(dir, entry.name), rel))
    else out.push(rel)
  }
  return out.sort()
}

/** Writes `files` (relative path → content) below `base`, creating folders. */
export function writeFiles(base: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(base, ...rel.split('/'))
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, content)
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Polls until the process is gone; true if it went away within `ms`. */
export async function waitGone(pid: number, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (!isAlive(pid)) return true
    await sleep(50)
  }
  return !isAlive(pid)
}

/** Collects job events and lets tests wait for a job's terminal event or any matching event. */
export class EventLog {
  readonly events: JobEvent[] = []
  private waiters: { match: (e: JobEvent) => boolean; resolve: (e: JobEvent) => void }[] = []

  readonly emit = (event: JobEvent): void => {
    this.events.push(event)
    this.waiters = this.waiters.filter((w) => {
      if (!w.match(event)) return true
      w.resolve(event)
      return false
    })
  }

  forJob(jobId: string): JobEvent[] {
    return this.events.filter((e) => e.jobId === jobId)
  }

  waitFor(match: (e: JobEvent) => boolean, ms = 15000): Promise<JobEvent> {
    const existing = this.events.find(match)
    if (existing) return Promise.resolve(existing)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for a job event')), ms)
      this.waiters.push({
        match,
        resolve: (e) => {
          clearTimeout(timer)
          resolve(e)
        }
      })
    })
  }

  terminal(jobId: string, ms?: number): Promise<JobEvent> {
    return this.waitFor((e) => e.jobId === jobId && (e.kind === 'result' || e.kind === 'error'), ms)
  }
}
