// SPDX-License-Identifier: GPL-3.0-or-later
// jobs slice: the running job, its progress, the log tail (500 lines), the last result, the error banner.
import type { JobProgressPayload } from '../../shared/ipc'
import type { SliceCreator } from './types'

export const LOG_TAIL_MAX = 500

export interface ActiveJob {
  type: string
  label: string
  /** Known once job.run has answered; needed for Cancel. */
  jobId: string | null
}

export interface ErrorBanner {
  /** Job error code (E_...), or 'ERROR' for other failures. */
  code: string
  message: string
}

export interface JobsSlice {
  active: ActiveJob | null
  progress: JobProgressPayload | null
  log: string[]
  lastResult: { type: string; result: unknown } | null
  error: ErrorBanner | null
  jobStarted(type: string, label: string): void
  jobIdKnown(jobId: string): void
  jobProgress(progress: JobProgressPayload): void
  jobFinished(result?: { type: string; result: unknown }): void
  appendLog(line: string): void
  clearLog(): void
  setError(error: ErrorBanner): void
  dismissError(): void
}

/** Appends lines, keeping the last `max`. */
export function appendTail(tail: string[], lines: string[], max = LOG_TAIL_MAX): string[] {
  const next = tail.concat(lines)
  return next.length > max ? next.slice(next.length - max) : next
}

export const createJobsSlice: SliceCreator<JobsSlice> = (set, get) => ({
  active: null,
  progress: null,
  log: [],
  lastResult: null,
  error: null,
  jobStarted: (type, label) => set({ active: { type, label, jobId: null }, progress: { stage: 'start', fraction: 0, message: label } }),
  jobIdKnown: (jobId) => {
    const active = get().active
    if (active) set({ active: { ...active, jobId } })
  },
  jobProgress: (progress) => set({ progress }),
  jobFinished: (result) => set(result ? { active: null, progress: null, lastResult: result } : { active: null, progress: null }),
  appendLog: (line) => set({ log: appendTail(get().log, [line]) }),
  clearLog: () => set({ log: [] }),
  setError: (error) => set({ error }),
  dismissError: () => set({ error: null })
})
