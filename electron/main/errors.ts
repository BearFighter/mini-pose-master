// SPDX-License-Identifier: GPL-3.0-or-later
// Main-process error convention (docs/contracts.md section 17): every IPC invoke rejection carries
// "<CODE>: message", where CODE is one of the section 16 error codes. No Electron APIs here.
import { JOB_ERROR_CODES, type JobErrorCode } from '../../src/shared/ipc'

/** An error with a section 16 code. Its message starts with the code, so it survives IPC. */
export class MpmError extends Error {
  constructor(
    readonly code: JobErrorCode,
    readonly text: string,
    readonly detail: Record<string, unknown> = {}
  ) {
    super(`${code}: ${text}`)
    this.name = 'MpmError'
  }
}

const CODED_RE = /^(E_[A-Z_]+): /

/** The code at the start of a message, if it is a known one. */
export function codeOf(message: string): JobErrorCode | null {
  const m = CODED_RE.exec(message)
  return m && (JOB_ERROR_CODES as readonly string[]).includes(m[1]) ? (m[1] as JobErrorCode) : null
}

/**
 * The "<CODE>: message" form of any thrown value: coded messages pass through, Node system errors
 * (ENOENT, EACCES, ENOSPC, ...) become E_IO, anything else E_INTERNAL.
 */
export function codedMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (codeOf(message)) return message
  const errno = (error as NodeJS.ErrnoException | null)?.code
  if (typeof errno === 'string' && /^E[A-Z]+$/.test(errno)) return `E_IO: ${message}`
  return `E_INTERNAL: ${message}`
}

/** `error` as an MpmError, using `fallback` for errors that carry no code. */
export function asMpmError(error: unknown, fallback: JobErrorCode): MpmError {
  if (error instanceof MpmError) return error
  const message = error instanceof Error ? error.message : String(error)
  const code = codeOf(message)
  return code ? new MpmError(code, message.slice(code.length + 2)) : new MpmError(fallback, message)
}
