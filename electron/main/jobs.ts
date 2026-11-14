// SPDX-License-Identifier: GPL-3.0-or-later
// Engine job runner (docs/contracts.md section 16): one Blender job at a time, FIFO queue, live
// progress, cancel and timeout. Node built-ins and tree-kill only; no Electron APIs here.
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createWriteStream, existsSync, promises as fs, statSync, type WriteStream } from 'node:fs'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { Readable } from 'node:stream'
import treeKill from 'tree-kill'
import { MpmError } from './errors'
import {
  JOB_ERROR_CODES,
  type JobErrorCode,
  type JobErrorPayload,
  type JobEvent,
  type JobProgressPayload
} from '../../src/shared/ipc'

export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000
export const KILL_GRACE_MS = 5000
/** Number of trailing log lines attached to an E_INTERNAL error after a crash. */
export const LOG_TAIL_LINES = 40
/** After 'exit', how long to wait for the stdio pipes to close before finishing the job anyway. */
const CLOSE_AFTER_EXIT_MS = 2000

const APPIMAGE_VARS = ['LD_LIBRARY_PATH', 'APPDIR', 'APPIMAGE', 'PYTHONHOME', 'PYTHONPATH']
const JOB_TYPE_RE = /^[a-z][a-z0-9_]*$/
const TAG_RE = /^@@(progress|result|error)(?:\s+(.*))?$/

// ---------------------------------------------------------------------------------------------------
// Pure helpers

export type ParsedLine =
  | { kind: 'progress'; payload: JobProgressPayload }
  | { kind: 'result'; payload: unknown }
  | { kind: 'error'; payload: JobErrorPayload }
  | { kind: 'log'; payload: string }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isErrorCode(code: unknown): code is JobErrorCode {
  return typeof code === 'string' && (JOB_ERROR_CODES as readonly string[]).includes(code)
}

/**
 * Parses one stdout line of the job protocol. Lines starting with `@@progress`, `@@result` or
 * `@@error` followed by valid JSON are protocol messages; everything else (including a tag with
 * broken JSON) is log text. A trailing `\r` is removed.
 */
export function parseLine(raw: string): ParsedLine {
  const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
  const log: ParsedLine = { kind: 'log', payload: line }
  const match = TAG_RE.exec(line)
  if (!match) return log
  let value: unknown
  try {
    value = JSON.parse(match[2] ?? '')
  } catch {
    return log
  }
  switch (match[1]) {
    case 'progress': {
      if (!isPlainObject(value)) return log
      const fraction = typeof value.fraction === 'number' && Number.isFinite(value.fraction) ? value.fraction : 0
      return {
        kind: 'progress',
        payload: {
          stage: typeof value.stage === 'string' ? value.stage : '',
          fraction: Math.min(1, Math.max(0, fraction)),
          message: typeof value.message === 'string' ? value.message : ''
        }
      }
    }
    case 'error': {
      if (!isPlainObject(value)) return log
      const detail = isPlainObject(value.detail) ? { ...value.detail } : {}
      let code: JobErrorCode = 'E_INTERNAL'
      if (isErrorCode(value.code)) code = value.code
      else detail.engine_code = value.code
      return {
        kind: 'error',
        payload: { code, message: typeof value.message === 'string' ? value.message : '', detail }
      }
    }
    default:
      return { kind: 'result', payload: value }
  }
}

/**
 * Environment for the Blender child. Inside a Linux AppImage (APPIMAGE is set) the AppImage's
 * library and Python variables would break Blender, so they are removed. Never mutates `env`.
 */
export function cleanEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env }
  if (env.APPIMAGE) {
    for (const key of APPIMAGE_VARS) delete out[key]
  }
  return out
}

/** The Blender command line after the executable (contracts section 16). */
export function blenderArgs(engineDir: string, type: string, jobFile: string): string[] {
  return [
    '-b',
    '--factory-startup',
    '--offline-mode',
    '--python-exit-code',
    '1',
    '-P',
    path.resolve(engineDir, 'jobs', `${type}.py`),
    '--',
    path.resolve(jobFile)
  ]
}

/** Job files (`cache/jobs/*.json`, `*.log`) older than this are pruned. */
export const JOB_FILE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000

/** Deletes the files in a `cache/jobs` folder last modified more than `maxAgeMs` ago. Returns the count. */
export async function pruneJobFiles(jobsDir: string, maxAgeMs: number = JOB_FILE_MAX_AGE_MS, now: number = Date.now()): Promise<number> {
  let names: string[]
  try {
    names = await fs.readdir(jobsDir)
  } catch {
    return 0
  }
  let removed = 0
  for (const name of names) {
    const file = path.join(jobsDir, name)
    try {
      const stats = await fs.stat(file)
      if (stats.isFile() && now - stats.mtimeMs > maxAgeMs) {
        await fs.rm(file, { force: true })
        removed++
      }
    } catch {
      // gone already, or not ours to touch
    }
  }
  return removed
}

/** The job.json and log of a job, in `<dir>/cache/jobs/`. */
export function jobFiles(dir: string, jobId: string): string[] {
  const jobsDir = path.join(dir, 'cache', 'jobs')
  return [path.join(jobsDir, `${jobId}.json`), path.join(jobsDir, `${jobId}.log`)]
}

/** Splits a byte stream into lines (UTF-8, `\n` separated; a final unterminated line is flushed at end). */
function forEachLine(stream: Readable, onLine: (line: string) => void): () => void {
  const decoder = new StringDecoder('utf8')
  let buffer = ''
  let flushed = false
  const push = (text: string) => {
    buffer += text
    let nl: number
    while ((nl = buffer.indexOf('\n')) >= 0) {
      onLine(buffer.slice(0, nl))
      buffer = buffer.slice(nl + 1)
    }
  }
  const flush = () => {
    if (flushed) return
    flushed = true
    push(decoder.end())
    if (buffer !== '') onLine(buffer)
    buffer = ''
  }
  stream.on('data', (chunk: Buffer) => {
    if (!flushed) push(decoder.write(chunk))
  })
  stream.on('end', flush)
  return flush
}

// ---------------------------------------------------------------------------------------------------
// JobRunner

export interface JobSpec {
  /** Absolute project folder. */
  dir: string
  /** Job type; runs `<engineDir>/jobs/<type>.py`. */
  type: string
  args: Record<string, unknown>
}

export interface JobRunnerOptions {
  /** Absolute engine folder (contains `jobs/<type>.py`). */
  engineDir: string
  /** Returns the Blender executable when a job starts. Rejecting fails that job with E_BLENDER_VERSION. */
  resolveBlender: () => string | Promise<string>
  emit: (event: JobEvent) => void
  /** Default 30 min. */
  timeoutMs?: number
  /** Time between the tree kill and SIGKILL. Default 5 s. */
  killGraceMs?: number
  /** Base environment, cleaned with cleanEnv. Default process.env. */
  env?: NodeJS.ProcessEnv
  /** Arguments put before the Blender arguments (tests run `node <fake engine script> <Blender args>`). */
  launcherArgs?: string[]
}

interface Job {
  id: string
  spec: JobSpec
  cancelled: boolean
  timedOut: boolean
  finished: boolean
  child: ChildProcess | null
  /** First @@result / @@error seen on stdout; emitted when the process has exited. */
  terminal: ParsedLine | null
  tail: string[]
  log: WriteStream | null
  timers: NodeJS.Timeout[]
  flushers: (() => void)[]
  spawnError: Error | null
  done: Promise<void>
  resolveDone: () => void
}

function errorEvent(jobId: string, code: JobErrorCode, message: string, detail: Record<string, unknown> = {}): JobEvent {
  return { jobId, kind: 'error', payload: { code, message, detail } }
}

export class JobRunner {
  private readonly opts: Required<Omit<JobRunnerOptions, 'env'>> & { env: NodeJS.ProcessEnv }
  private readonly queue: Job[] = []
  private active: Job | null = null

  constructor(options: JobRunnerOptions) {
    this.opts = {
      engineDir: path.resolve(options.engineDir),
      resolveBlender: options.resolveBlender,
      emit: options.emit,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      killGraceMs: options.killGraceMs ?? KILL_GRACE_MS,
      launcherArgs: options.launcherArgs ?? [],
      env: options.env ?? process.env
    }
  }

  /** Id of the running job, or null. */
  get activeJobId(): string | null {
    return this.active?.id ?? null
  }

  /** Ids of the waiting jobs, in run order. */
  get queuedJobIds(): string[] {
    return this.queue.map((job) => job.id)
  }

  /**
   * Queues a job and returns its id. Throws (synchronously) for an invalid spec: `dir` must be an
   * existing absolute folder, `type` must name an engine job script, `args` must be an object.
   */
  run(spec: JobSpec): string {
    if (typeof spec?.dir !== 'string' || !path.isAbsolute(spec.dir)) throw new MpmError('E_ARGS', 'job dir must be an absolute path')
    if (!isDirectory(spec.dir)) throw new MpmError('E_ARGS', `project folder not found: ${spec.dir}`)
    if (typeof spec.type !== 'string' || !JOB_TYPE_RE.test(spec.type)) throw new MpmError('E_ARGS', `invalid job type: ${String(spec.type)}`)
    if (!existsSync(path.join(this.opts.engineDir, 'jobs', `${spec.type}.py`))) throw new MpmError('E_ARGS', `unknown job type: ${spec.type}`)
    if (!isPlainObject(spec.args)) throw new MpmError('E_ARGS', 'job args must be an object')

    let resolveDone!: () => void
    const done = new Promise<void>((resolve) => (resolveDone = resolve))
    const job: Job = {
      id: randomUUID(),
      spec: { dir: path.resolve(spec.dir), type: spec.type, args: spec.args },
      cancelled: false,
      timedOut: false,
      finished: false,
      child: null,
      terminal: null,
      tail: [],
      log: null,
      timers: [],
      flushers: [],
      spawnError: null,
      done,
      resolveDone
    }
    this.queue.push(job)
    // Start on a later tick so the caller has the id before the first event can arrive.
    setImmediate(() => this.pump())
    return job.id
  }

  /**
   * Cancels a job. A queued job is removed from the queue; a running job's process tree is killed
   * (SIGKILL after the grace period). Either way the job ends with error E_CANCELLED.
   * Unknown or finished jobs are ignored.
   */
  cancel(jobId: string): void {
    const index = this.queue.findIndex((job) => job.id === jobId)
    if (index >= 0) {
      const [job] = this.queue.splice(index, 1)
      job.cancelled = true
      void this.finish(job, errorEvent(job.id, 'E_CANCELLED', 'cancelled'))
      return
    }
    const job = this.active
    if (!job || job.id !== jobId || job.cancelled || job.finished) return
    job.cancelled = true
    if (job.child) this.kill(job)
    // Not spawned yet: start() sees the flag after its awaits and finishes the job.
  }

  /** Cancels everything and resolves when the running job (if any) has ended. For app shutdown. */
  async shutdown(): Promise<void> {
    for (const id of this.queuedJobIds) this.cancel(id)
    const job = this.active
    if (!job) return
    this.cancel(job.id)
    await job.done
  }

  private pump(): void {
    if (this.active) return
    const job = this.queue.shift()
    if (!job) return
    this.active = job
    void this.start(job)
  }

  private async start(job: Job): Promise<void> {
    const { id, spec } = job
    const jobsDir = path.join(spec.dir, 'cache', 'jobs')
    const jobFile = path.join(jobsDir, `${id}.json`)
    try {
      await fs.mkdir(jobsDir, { recursive: true })
      const jobJson = { schema: 'mpm.job/1', id, type: spec.type, project_dir: spec.dir, args: spec.args }
      await fs.writeFile(jobFile, JSON.stringify(jobJson, null, 2) + '\n', 'utf8')
    } catch (e) {
      return this.finish(job, errorEvent(id, 'E_IO', `cannot write the job file: ${(e as Error).message}`, { path: jobFile }))
    }

    let blender: string
    try {
      blender = await this.opts.resolveBlender()
    } catch (e) {
      return this.finish(job, errorEvent(id, 'E_BLENDER_VERSION', (e as Error).message || 'Blender 5.2 not found'))
    }
    if (job.cancelled) return this.finish(job, errorEvent(id, 'E_CANCELLED', 'cancelled'))

    const log = createWriteStream(path.join(jobsDir, `${id}.log`), { flags: 'w' })
    log.on('error', () => {}) // a log write failure must not crash the main process
    job.log = log

    let child: ChildProcess
    try {
      child = spawn(blender, [...this.opts.launcherArgs, ...blenderArgs(this.opts.engineDir, spec.type, jobFile)], {
        env: cleanEnv(this.opts.env),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })
    } catch (e) {
      return this.finish(job, errorEvent(id, 'E_INTERNAL', `cannot start Blender: ${(e as Error).message}`, { blender }))
    }
    job.child = child

    job.flushers.push(forEachLine(child.stdout!, (line) => this.onLine(job, line, 'stdout')))
    job.flushers.push(forEachLine(child.stderr!, (line) => this.onLine(job, line, 'stderr')))

    child.on('error', (err) => {
      if (child.pid === undefined) {
        job.spawnError = err
        void this.onClosed(job, null, null)
      }
    })
    child.on('exit', (code, signal) => {
      // Normally 'close' follows once the pipes are drained; don't hang if a grandchild keeps them open.
      job.timers.push(setTimeout(() => void this.onClosed(job, code, signal), CLOSE_AFTER_EXIT_MS))
    })
    child.on('close', (code, signal) => void this.onClosed(job, code, signal))

    job.timers.push(
      setTimeout(() => {
        if (job.finished || job.cancelled) return
        job.timedOut = true
        this.kill(job)
      }, this.opts.timeoutMs)
    )
  }

  private onLine(job: Job, raw: string, stream: 'stdout' | 'stderr'): void {
    if (job.finished) return
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    job.log?.write(line + '\n')
    const parsed: ParsedLine = stream === 'stdout' ? parseLine(line) : { kind: 'log', payload: line }
    if (parsed.kind === 'result' || parsed.kind === 'error') {
      if (!job.terminal) {
        job.terminal = parsed
        return
      }
      // A second terminal message breaks the protocol; keep the first and log the rest.
      this.pushLog(job, line)
      return
    }
    if (parsed.kind === 'progress') {
      this.opts.emit({ jobId: job.id, kind: 'progress', payload: parsed.payload })
      return
    }
    this.pushLog(job, line)
  }

  private pushLog(job: Job, line: string): void {
    job.tail.push(line)
    if (job.tail.length > LOG_TAIL_LINES) job.tail.shift()
    if (line.trim() !== '') this.opts.emit({ jobId: job.id, kind: 'log', payload: line })
  }

  private kill(job: Job): void {
    const child = job.child
    if (!child || child.pid === undefined || hasExited(child)) return
    const pid = child.pid
    treeKill(pid, 'SIGTERM', () => {})
    job.timers.push(
      setTimeout(() => {
        if (hasExited(child)) return
        treeKill(pid, 'SIGKILL', () => {})
        try {
          child.kill('SIGKILL')
        } catch {
          // already gone
        }
        // Never block the queue on a process that cannot be reaped.
        job.timers.push(setTimeout(() => void this.onClosed(job, null, 'SIGKILL'), this.opts.killGraceMs))
      }, this.opts.killGraceMs)
    )
  }

  private async onClosed(job: Job, code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    if (job.finished) return
    for (const flush of job.flushers) flush()
    const { id } = job
    let event: JobEvent
    if (job.cancelled) {
      event = errorEvent(id, 'E_CANCELLED', 'cancelled')
    } else if (job.timedOut) {
      event = errorEvent(id, 'E_INTERNAL', 'timeout', { timeout_ms: this.opts.timeoutMs, log_tail: [...job.tail] })
    } else if (job.spawnError) {
      event = errorEvent(id, 'E_INTERNAL', `cannot start Blender: ${job.spawnError.message}`)
    } else if (job.terminal?.kind === 'error') {
      event = { jobId: id, kind: 'error', payload: job.terminal.payload }
    } else if (code === 0 && job.terminal?.kind === 'result') {
      event = { jobId: id, kind: 'result', payload: job.terminal.payload }
    } else if (code === 0) {
      event = errorEvent(id, 'E_INTERNAL', 'no result', { exit_code: 0, log_tail: [...job.tail] })
    } else {
      const how = code !== null ? `exited with code ${code}` : `was terminated (${signal ?? 'unknown signal'})`
      event = errorEvent(id, 'E_INTERNAL', `Blender ${how}`, { exit_code: code, signal, log_tail: [...job.tail] })
    }
    await this.finish(job, event)
  }

  /** Emits the job's single terminal event (after the log file is flushed) and starts the next job. */
  private async finish(job: Job, event: JobEvent): Promise<void> {
    if (job.finished) return
    job.finished = true
    for (const timer of job.timers) clearTimeout(timer)
    job.timers = []
    if (job.log) await endStream(job.log)
    this.opts.emit(event)
    job.resolveDone()
    if (this.active === job) {
      this.active = null
      this.pump()
    }
  }
}

/** Ends a write stream and resolves once its file is closed (or the stream failed). */
function endStream(stream: WriteStream): Promise<void> {
  return new Promise((resolve) => {
    if (stream.destroyed || stream.closed) return resolve()
    stream.once('close', () => resolve())
    stream.once('error', () => resolve())
    stream.end()
  })
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

function isDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory()
  } catch {
    return false
  }
}
