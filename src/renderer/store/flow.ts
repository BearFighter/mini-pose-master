// SPDX-License-Identifier: GPL-3.0-or-later
// Helpers shared by the flow modules (actions.ts, poseActions.ts): store access, the error banner.
import { cleanError, JobError } from '../api'
import { useStore } from './index'

export const S = () => useStore.getState()

/** Asks before unsaved changes are thrown away. Replaced in tests and the e2e hook. */
export type ConfirmDiscard = (message: string) => boolean

export const defaultConfirm: ConfirmDiscard = (message) => {
  const c = (globalThis as { confirm?: (m: string) => boolean }).confirm
  return typeof c === 'function' ? c(message) : true
}

export function errorBanner(e: unknown): { code: string; message: string; detail?: Record<string, unknown> } {
  if (e instanceof JobError) return Object.keys(e.detail).length ? { code: e.code, message: e.message, detail: e.detail } : { code: e.code, message: e.message }
  return { code: 'ERROR', message: cleanError(e) }
}

/** Shows a failure in the error banner (cancellation is not an error) and rethrows it. */
export function fail(e: unknown): never {
  if (!(e instanceof JobError && e.code === 'E_CANCELLED')) S().setError(errorBanner(e))
  throw e
}

/** For UI handlers: run a flow and swallow its rejection (it is already in the banner). */
export function fire(p: Promise<unknown>): void {
  p.catch(() => {})
}

/** A cache-busting version for files that were just rewritten. */
let fileVersion = Date.now()
export const nextVersion = (): number => ++fileVersion
