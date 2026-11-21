// SPDX-License-Identifier: GPL-3.0-or-later
// Pose library (docs/contracts.md sections 9, 17, 20): pack list, license gate, verified downloads,
// conversion through convert_clip jobs, the .installing swap, the user's own pack, thumbnails.
// Every pack's sources live in raw/<pack>/, so `reconvert` can rebuild a pack after a converter update.
// Node built-ins and zod only; ipc.ts injects Electron's net.fetch and the JobRunner.
import { createHash } from 'node:crypto'
import { constants as fsConstants, createReadStream, promises as fs } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type { ClipFailure, JobErrorPayload, JobEvent, LibraryInstallResult, MpmEventPayloads, PackEntry, PackInfo } from '../../src/shared/ipc'
import { asMpmError, MpmError } from './errors'
import { isEnoent, renameWithRetry, samePath, writeFileAtomic } from './fsutil'
import { jobFiles, type JobSpec } from './jobs'
import { isAllowedUrl, MINE_PACK_ID, type PackDefinition, type PacksFile } from './packs'
import { loadSettings, modifySettings, type Settings } from './settings'

export const BATCH_SIZE = 25
export const MAX_FOLDER_BVH = 20_000
export const MAX_THUMB_BYTES = 512 * 1024
/** Free space needed per byte of new source data: the copy or download, the converted pack, headroom. */
export const DISK_FACTOR = 3
/** Assumed expansion of a zip whose central directory can't be read (zip64, damaged). */
export const ZIP_FALLBACK_RATIO = 10
const MAX_REDIRECTS = 5
const PROGRESS_INTERVAL_MS = 100
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** The user's own pack (contracts section 20). It has no packs.json entry. */
export const MINE_ENTRY: PackEntry = {
  id: MINE_PACK_ID,
  title: 'My clips',
  source: null,
  license: 'Your own',
  license_url: '',
  nc: false,
  exportable: true
}

/** The part of JobRunner the library uses. */
export interface JobRunnerLike {
  run(spec: JobSpec): string
  cancel(jobId: string): void
}

export type LibraryFetch = (url: string, init: RequestInit) => Promise<Response>

export interface LibraryOptions {
  /** libraryDir(). */
  root: string
  packs: PacksFile
  runner: JobRunnerLike
  settingsFile: string
  /** Electron's net.fetch in the app; Node's fetch in tests. */
  fetch: LibraryFetch
  onProgress?: (progress: MpmEventPayloads['library:progress']) => void
  /** Free bytes on the volume of `dir`. Default: fs.statfs. */
  freeBytes?: (dir: string) => Promise<number>
  /** Parallel downloads. Default 4. */
  concurrency?: number
  /** Per-file, per-attempt download timeout. Default 60 s. */
  fileTimeoutMs?: number
  /** Download attempts per file. Default 3. */
  tries?: number
  /** First retry delay; doubles after each failure. Default 1 s. */
  backoffMs?: number
  /** Tests only: allow http:// on the loopback interface. */
  allowLoopbackHttp?: boolean
  now?: () => Date
}

// ---------------------------------------------------------------------------------------------------
// Argument schemas (every IPC argument is validated here)

const safeId = z
  .string()
  .regex(/^[\w.-]+$/, 'may only contain letters, digits, _ . -')
  .refine((id) => !/^\.+$/.test(id), 'may not be only dots')
  .max(200)
const filePath = z.string().min(1)

export const installArgs = z.object({ packId: safeId, acceptLicense: z.unknown().optional() })
export const installFromFileArgs = z.object({
  packId: safeId,
  files: z.array(filePath).min(1).max(10_000),
  acceptLicense: z.unknown().optional(),
  append: z.boolean().optional()
})
export const importClipArgs = z.object({ file: filePath, source: z.string().regex(/^[a-z0-9_]+$/).nullable().optional() })
export const packIdArg = safeId
export const saveThumbArgs = z.object({
  packId: safeId,
  clipId: safeId,
  frame: z.number().int().min(0),
  png: z
    .instanceof(Uint8Array)
    .refine((b) => b.byteLength <= MAX_THUMB_BYTES, `must be at most ${MAX_THUMB_BYTES / 1024} KB`)
    .refine((b) => PNG_SIGNATURE.every((v, i) => b[i] === v), 'is not a PNG')
})

function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new MpmError('E_ARGS', `invalid ${what}: ${z.prettifyError(result.error).replace(/\n/g, ' ')}`)
  return result.data
}

// ---------------------------------------------------------------------------------------------------
// Helpers

interface PackIndex {
  clips: unknown[]
  converter_version?: number
}

async function readIndex(packDir: string): Promise<PackIndex | null> {
  try {
    const json = JSON.parse(await fs.readFile(path.join(packDir, 'index.json'), 'utf8')) as Record<string, unknown>
    if (!json || !Array.isArray(json.clips)) return null
    return { clips: json.clips, converter_version: typeof json.converter_version === 'number' ? json.converter_version : undefined }
  } catch {
    return null
  }
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

async function statOrNull(p: string) {
  try {
    return await fs.stat(p)
  } catch (e) {
    if (isEnoent(e)) return null
    throw e
  }
}

/** Total size of the files below `dir` (0 when it doesn't exist). */
async function dirSize(dir: string): Promise<number> {
  let total = 0
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) total += await dirSize(abs)
    else if (entry.isFile()) total += (await fs.stat(abs)).size
  }
  return total
}

function megabytes(bytes: number): string {
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Every `*.bvh` file below `dir`, sorted ([] when `dir` doesn't exist). Throws E_ARGS past `cap` files. */
async function findBvh(dir: string, cap: number): Promise<string[]> {
  const out: string[] = []
  const walk = async (d: string): Promise<void> => {
    for (const entry of await fs.readdir(d, { withFileTypes: true })) {
      const abs = path.join(d, entry.name)
      if (entry.isDirectory()) await walk(abs)
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.bvh')) {
        out.push(abs)
        if (out.length > cap) throw new MpmError('E_ARGS', `more than ${cap} .bvh files in ${dir}`, { folder: dir })
      }
    }
  }
  if ((await statOrNull(dir))?.isDirectory()) await walk(dir)
  return out.sort()
}

/**
 * The uncompressed size of the .bvh members of a zip that pass `include`, read from its central
 * directory; null when that can't be read (zip64 or a damaged file).
 */
export async function zipBvhBytes(file: string, include: string[] | null = null): Promise<number | null> {
  let handle: fs.FileHandle | null = null
  try {
    handle = await fs.open(file, 'r')
    const { size } = await handle.stat()
    const tailLength = Math.min(size, 22 + 0xffff)
    const tail = Buffer.alloc(tailLength)
    await handle.read(tail, 0, tailLength, size - tailLength)
    let eocd = -1
    for (let i = tailLength - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i
        break
      }
    }
    if (eocd < 0) return null
    const entries = tail.readUInt16LE(eocd + 10)
    const cdSize = tail.readUInt32LE(eocd + 12)
    const cdOffset = tail.readUInt32LE(eocd + 16)
    if (entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff || cdOffset + cdSize > size) return null
    const cd = Buffer.alloc(cdSize)
    await handle.read(cd, 0, cdSize, cdOffset)
    const filters = include?.map((s) => s.toLowerCase()) ?? null
    let total = 0
    let p = 0
    for (let n = 0; n < entries; n++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) return null
      const uncompressed = cd.readUInt32LE(p + 24)
      const nameLength = cd.readUInt16LE(p + 28)
      const name = cd.toString('utf8', p + 46, p + 46 + nameLength).replace(/\\/g, '/').toLowerCase()
      if (uncompressed === 0xffffffff) return null
      if (name.endsWith('.bvh') && (!filters || filters.some((s) => name.includes(s)))) total += uncompressed
      p += 46 + nameLength + cd.readUInt16LE(p + 30) + cd.readUInt16LE(p + 32)
    }
    return total
  } catch {
    return null
  } finally {
    await handle?.close()
  }
}

/**
 * Copies `file` into `dir` as `name` without overwriting: a file with the same bytes already there
 * is re-used; otherwise `<stem>-2<ext>`, `-3`, ... Returns where it is and whether it was created.
 */
async function placeFile(file: string, dir: string, name: string): Promise<{ dest: string; created: boolean }> {
  await fs.mkdir(dir, { recursive: true })
  const ext = path.extname(name)
  const stem = name.slice(0, name.length - ext.length)
  let sha: string | null = null
  for (let n = 1; ; n++) {
    const dest = path.join(dir, n === 1 ? name : `${stem}-${n}${ext}`)
    if (samePath(dest, file)) return { dest, created: false }
    try {
      await fs.copyFile(file, dest, fsConstants.COPYFILE_EXCL)
      return { dest, created: true }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      sha ??= await sha256File(file)
      if ((await sha256File(dest)) === sha) return { dest, created: false }
    }
  }
}

/** Moves every file below `from` to the same relative path below `to` (replacing files there). */
async function mergeInto(from: string, to: string): Promise<void> {
  for (const entry of await fs.readdir(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name)
    const dest = path.join(to, entry.name)
    if (entry.isDirectory()) {
      await fs.mkdir(dest, { recursive: true })
      await mergeInto(src, dest)
    } else {
      await fs.mkdir(to, { recursive: true })
      await renameWithRetry(src, dest)
    }
  }
}

type DownloadFile = Extract<PackDefinition['download'], { files: unknown }>['files'][number]

class RedirectRefused extends Error {}

/** A convert_clip job that ended with an error. */
class JobFailed extends Error {
  constructor(readonly payload: JobErrorPayload) {
    super(payload.message)
  }
}

interface ConvertResult {
  clips: string[]
  failed: ClipFailure[]
}

function toFailures(value: unknown): ClipFailure[] {
  if (!Array.isArray(value)) return []
  return value.map((f) => {
    const { file, error } = (f ?? {}) as Record<string, unknown>
    return { file: String(file ?? ''), error: String(error ?? '') }
  })
}

function toConvertResult(payload: unknown): ConvertResult {
  const { clips, failed } = (payload ?? {}) as Record<string, unknown>
  return { clips: Array.isArray(clips) ? clips.map(String) : [], failed: toFailures(failed) }
}

interface Task {
  packId: string
  kind: 'install' | 'import' | 'remove'
  controller: AbortController
  jobIds: Set<string>
  /** Concurrent importClip calls share one task. */
  refs: number
  done: Promise<void>
  finish: () => void
}

interface Waiter {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  progress?: (fraction: number) => void
}

/**
 * GitHub's "Download ZIP" of a repository that keeps big files in Git LFS (LaFAN1 does) contains small
 * text pointers instead of the files. Say so plainly instead of failing as "not a readable zip".
 */
async function refuseLfsPointer(abs: string, size: number): Promise<void> {
  if (size > 1024) return
  const head = (await fs.readFile(abs)).subarray(0, 64).toString('utf8')
  if (head.startsWith('version https://git-lfs')) {
    throw new MpmError(
      'E_ARGS',
      `${path.basename(abs)} is only a ${size}-byte Git LFS placeholder, not the real archive. ` +
        "GitHub's \"Download ZIP\" leaves these out: open the file on the dataset's GitHub page and use \"Download raw file\" " +
        '(about 144 MB for LaFAN1), then choose that file.'
    )
  }
}

/** One chosen installFromFile source. */
interface Source {
  abs: string
  kind: 'zip' | 'folder' | 'bvh'
  /** .bvh files to copy (folder: every .bvh below it; bvh: the file). */
  files: string[]
  /** Bytes of new source data (zip: the uncompressed .bvh members). */
  bytes: number
}

// ---------------------------------------------------------------------------------------------------

export class Library {
  readonly root: string
  private readonly packs: PacksFile
  private readonly opts: Required<Omit<LibraryOptions, 'root' | 'packs' | 'onProgress'>> & Pick<LibraryOptions, 'onProgress'>
  private readonly tasks = new Map<string, Task>()
  private readonly waiters = new Map<string, Waiter>()

  constructor(options: LibraryOptions) {
    this.root = path.resolve(options.root)
    this.packs = options.packs
    this.opts = {
      runner: options.runner,
      settingsFile: options.settingsFile,
      fetch: options.fetch,
      onProgress: options.onProgress,
      freeBytes:
        options.freeBytes ??
        (async (dir) => {
          const stats = await fs.statfs(dir)
          return stats.bavail * stats.bsize
        }),
      concurrency: options.concurrency ?? 4,
      fileTimeoutMs: options.fileTimeoutMs ?? 60_000,
      tries: options.tries ?? 3,
      backoffMs: options.backoffMs ?? 1000,
      allowLoopbackHttp: options.allowLoopbackHttp ?? false,
      now: options.now ?? (() => new Date())
    }
  }

  // --- paths

  private packDir(id: string): string {
    return path.join(this.root, 'packs', id)
  }

  private installingDir(id: string): string {
    return path.join(this.root, 'packs', `${id}.installing`)
  }

  private rawDir(id: string): string {
    return path.join(this.root, 'raw', id)
  }

  /** New sources of an installFromFile, staged until the pack is swapped in. */
  private incomingDir(id: string): string {
    return path.join(this.root, 'raw', `${id}.incoming`)
  }

  // --- state

  /** True while any download, conversion or removal runs. */
  isBusy(): boolean {
    return this.tasks.size > 0
  }

  private entry(packId: string): PackDefinition {
    const entry = this.packs.packs.find((p) => p.id === packId)
    if (!entry) throw new MpmError('E_ARGS', `unknown pack ${packId}`)
    return entry
  }

  private begin(packId: string, kind: Task['kind']): Task {
    const running = this.tasks.get(packId)
    if (running) {
      if (kind === 'import' && running.kind === 'import') {
        running.refs++
        return running
      }
      throw new MpmError('E_ARGS', `${packId} is busy`)
    }
    let finish!: () => void
    const done = new Promise<void>((resolve) => (finish = resolve))
    const task: Task = { packId, kind, controller: new AbortController(), jobIds: new Set(), refs: 1, done, finish }
    this.tasks.set(packId, task)
    return task
  }

  private end(task: Task): void {
    if (--task.refs > 0) return
    if (this.tasks.get(task.packId) === task) this.tasks.delete(task.packId)
    task.finish()
  }

  private progress(packId: string, stage: 'download' | 'convert' | 'done', fraction: number): void {
    this.opts.onProgress?.({ packId, stage, fraction: Math.min(1, Math.max(0, fraction)) })
  }

  private cancelled(packId: string): MpmError {
    return new MpmError('E_CANCELLED', `${packId}: cancelled`)
  }

  private async recordLicense(entry: PackEntry): Promise<void> {
    const acceptedAt = this.opts.now().toISOString()
    await modifySettings(
      (s: Settings) => ({ ...s, licenses: { ...(s.licenses ?? {}), [entry.id]: { license: entry.license, acceptedAt } } }),
      this.opts.settingsFile
    )
  }

  private requireLicense(acceptLicense: unknown): void {
    if (acceptLicense !== true) throw new MpmError('E_ARGS', 'the license must be accepted first (acceptLicense: true)')
  }

  /** Refuses with E_IO unless `needed` bytes are free in the library folder. */
  private async requireSpace(needed: number): Promise<void> {
    await fs.mkdir(this.root, { recursive: true })
    const free = await this.opts.freeBytes(this.root)
    if (free < needed) {
      throw new MpmError('E_IO', `not enough free disk space: ${megabytes(needed)} needed, ${megabytes(free)} free`, { needed, free })
    }
  }

  // --- jobs

  /** Feed every JobRunner event here; events of other jobs are ignored. */
  onJobEvent(event: JobEvent): void {
    const waiter = this.waiters.get(event.jobId)
    if (!waiter) return
    if (event.kind === 'progress') waiter.progress?.(event.payload.fraction)
    else if (event.kind === 'result') {
      this.waiters.delete(event.jobId)
      waiter.resolve(event.payload)
    } else if (event.kind === 'error') {
      this.waiters.delete(event.jobId)
      waiter.reject(new JobFailed(event.payload))
    }
  }

  /** Runs one convert_clip job. A successful job's job.json and log are deleted; failed ones are kept. */
  private async convertJob(task: Task, args: Record<string, unknown>, progress?: (fraction: number) => void): Promise<ConvertResult> {
    if (task.controller.signal.aborted) throw this.cancelled(task.packId)
    await fs.mkdir(this.root, { recursive: true })
    const jobId = this.opts.runner.run({ dir: this.root, type: 'convert_clip', args })
    task.jobIds.add(jobId)
    try {
      const result = toConvertResult(await new Promise((resolve, reject) => this.waiters.set(jobId, { resolve, reject, progress })))
      for (const file of jobFiles(this.root, jobId)) await fs.rm(file, { force: true }).catch(() => {})
      return result
    } finally {
      task.jobIds.delete(jobId)
      this.waiters.delete(jobId)
    }
  }

  private packMeta(entry: PackEntry): Record<string, unknown> {
    return {
      pack: entry.id,
      title: entry.title,
      license: entry.license,
      license_url: entry.license_url,
      exportable: entry.exportable,
      converter_version: this.packs.converter_version
    }
  }

  /**
   * Runs convert_clip jobs one after another (so user jobs can get in between) and counts the
   * converted clips and the failures. A job that converted nothing (E_IMPORT_FAILED with
   * detail.failed) only adds failures; any other job error stops the install.
   */
  private async convertAll(
    task: Task,
    entry: PackEntry,
    jobs: Record<string, unknown>[],
    packDir: string
  ): Promise<{ converted: number; failed: ClipFailure[] }> {
    const failed: ClipFailure[] = []
    let converted = 0
    for (let i = 0; i < jobs.length; i++) {
      const args = { source: entry.source, ...jobs[i], pack_dir: packDir, pack: this.packMeta(entry) }
      this.progress(entry.id, 'convert', i / jobs.length)
      try {
        const result = await this.convertJob(task, args, (f) => this.progress(entry.id, 'convert', (i + f) / jobs.length))
        converted += result.clips.length
        failed.push(...result.failed)
      } catch (e) {
        if (task.controller.signal.aborted) throw this.cancelled(entry.id)
        if (!(e instanceof JobFailed)) throw e
        const { code, message, detail } = e.payload
        if (code === 'E_IMPORT_FAILED' && Array.isArray(detail.failed)) failed.push(...toFailures(detail.failed))
        else if (code === 'E_CANCELLED') throw this.cancelled(entry.id)
        else throw new MpmError(code, message, detail)
      }
    }
    return { converted, failed }
  }

  /** Batches of BATCH_SIZE files; `root` lets the engine record each file's path relative to it. */
  private batches(files: string[], root: string): Record<string, unknown>[] {
    const jobs: Record<string, unknown>[] = []
    for (let i = 0; i < files.length; i += BATCH_SIZE) jobs.push({ files: files.slice(i, i + BATCH_SIZE), root })
    return jobs
  }

  /**
   * Builds the pack in packs/<id>.installing (seeded with a copy of `seed` when appending), then
   * swaps it into place and runs `commit` (moving staged sources into raw/). Nothing converted is an
   * E_IMPORT_FAILED; on any failure the old pack is left as it was.
   */
  private async build(
    task: Task,
    entry: PackEntry,
    convert: (packDir: string) => Promise<{ converted: number; failed: ClipFailure[] }>,
    options: { seed?: string | null; commit?: () => Promise<void> } = {}
  ): Promise<LibraryInstallResult> {
    const installing = this.installingDir(entry.id)
    await fs.rm(installing, { recursive: true, force: true })
    if (options.seed && (await statOrNull(options.seed))?.isDirectory()) await fs.cp(options.seed, installing, { recursive: true })
    else await fs.mkdir(installing, { recursive: true })
    try {
      const { converted, failed } = await convert(installing)
      if (task.controller.signal.aborted) throw this.cancelled(entry.id)
      const index = await readIndex(installing)
      if (converted === 0 || !index) throw new MpmError('E_IMPORT_FAILED', 'no clip could be converted', { failed })
      const final = this.packDir(entry.id)
      await fs.rm(final, { recursive: true, force: true })
      await renameWithRetry(installing, final)
      await options.commit?.()
      this.progress(entry.id, 'done', 1)
      return { clips: index.clips.length, failed }
    } catch (e) {
      await fs.rm(installing, { recursive: true, force: true }).catch(() => {})
      if (task.controller.signal.aborted) throw this.cancelled(entry.id)
      throw e
    }
  }

  // --- downloads

  /** Fetches with manual redirects, refusing any hop that is not https. */
  private async fetchChecked(url: string, signal: AbortSignal): Promise<Response> {
    let current = url
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!isAllowedUrl(current, this.opts.allowLoopbackHttp)) {
        throw new RedirectRefused(`refused ${current}: only https:// downloads are allowed`)
      }
      const res = await this.opts.fetch(current, { signal, redirect: 'manual' })
      if (res.type === 'opaqueredirect') throw new RedirectRefused(`refused a redirect from ${current} that cannot be checked`)
      if (res.status >= 300 && res.status < 400 && res.status !== 304) {
        const location = res.headers.get('location')
        await res.body?.cancel().catch(() => {})
        if (!location) throw new RedirectRefused(`redirect without a location from ${current}`)
        current = new URL(location, current).href
        continue
      }
      return res
    }
    throw new Error(`too many redirects from ${url}`)
  }

  /** One attempt: streams the URL into `part`. Returns its size and SHA-256. */
  private async fetchToPart(
    url: string,
    part: string,
    expectedSize: number,
    signal: AbortSignal,
    onBytes: (bytes: number) => void
  ): Promise<{ size: number; sha256: string }> {
    const timeout = AbortSignal.timeout(this.opts.fileTimeoutMs)
    const combined = AbortSignal.any([signal, timeout])
    try {
      const res = await this.fetchChecked(url, combined)
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
      const hash = createHash('sha256')
      const reader = res.body.getReader()
      const onAbort = () => {
        reader.cancel().catch(() => {})
      }
      combined.addEventListener('abort', onAbort, { once: true })
      const handle = await fs.open(part, 'w')
      let size = 0
      try {
        for (;;) {
          const { done, value } = await reader.read()
          combined.throwIfAborted()
          if (done) break
          size += value.byteLength
          if (size > expectedSize) throw new Error(`more than the expected ${expectedSize} bytes`)
          hash.update(value)
          await handle.write(value)
          onBytes(size)
        }
      } finally {
        combined.removeEventListener('abort', onAbort)
        await handle.close()
      }
      return { size, sha256: hash.digest('hex') }
    } catch (e) {
      if (timeout.aborted && !signal.aborted) throw new Error(`timed out after ${Math.round(this.opts.fileTimeoutMs / 1000)} s`)
      throw e
    }
  }

  /** Downloads one file into `dir` (skipped when a good copy is there): .part, verify, rename. */
  private async downloadFile(file: DownloadFile, dir: string, signal: AbortSignal, onBytes: (bytes: number) => void): Promise<void> {
    const dest = path.join(dir, file.name)
    const existing = await statOrNull(dest)
    if (existing?.isFile() && existing.size === file.size && (await sha256File(dest)) === file.sha256) {
      onBytes(file.size)
      return
    }
    const part = `${dest}.part`
    let lastError = 'unknown error'
    for (let attempt = 1; attempt <= this.opts.tries; attempt++) {
      signal.throwIfAborted()
      onBytes(0)
      try {
        const got = await this.fetchToPart(file.url, part, file.size, signal, onBytes)
        if (got.size === file.size && got.sha256 === file.sha256) {
          await fs.rm(dest, { force: true })
          await renameWithRetry(part, dest)
          onBytes(file.size)
          return
        }
        lastError = got.size !== file.size ? `size ${got.size} instead of ${file.size}` : 'SHA-256 mismatch'
      } catch (e) {
        if (signal.aborted) {
          await fs.rm(part, { force: true }).catch(() => {})
          throw e
        }
        if (e instanceof RedirectRefused) {
          await fs.rm(part, { force: true }).catch(() => {})
          throw new MpmError('E_IO', `${file.name}: ${e.message}`, { file: file.name, url: file.url })
        }
        lastError = (e as Error).message
      }
      await fs.rm(part, { force: true }).catch(() => {})
      onBytes(0)
      if (attempt < this.opts.tries) await sleep(this.opts.backoffMs * 2 ** (attempt - 1), signal)
    }
    throw new MpmError('E_IO', `download of ${file.name} failed after ${this.opts.tries} tries: ${lastError}`, {
      file: file.name,
      url: file.url
    })
  }

  private async downloadAll(task: Task, entry: PackDefinition, dir: string): Promise<void> {
    if (!('files' in entry.download)) return
    const files = entry.download.files
    await fs.mkdir(dir, { recursive: true })
    const total = files.reduce((sum, f) => sum + f.size, 0)
    const bytes = new Map<string, number>()
    let lastReport = 0
    const report = (force = false) => {
      const now = Date.now()
      if (!force && now - lastReport < PROGRESS_INTERVAL_MS) return
      lastReport = now
      let done = 0
      for (const n of bytes.values()) done += n
      this.progress(entry.id, 'download', total > 0 ? done / total : 1)
    }
    report(true)

    // A failing file stops the others; cancelling the task stops everything.
    const stop = new AbortController()
    const signal = AbortSignal.any([task.controller.signal, stop.signal])
    const queue = [...files]
    let firstError: unknown = null
    const worker = async () => {
      for (let file = queue.shift(); file; file = queue.shift()) {
        const name = file.name
        try {
          await this.downloadFile(file, dir, signal, (n) => {
            bytes.set(name, n)
            report()
          })
        } catch (e) {
          if (!firstError && !stop.signal.aborted) firstError = e
          stop.abort()
          return
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(this.opts.concurrency, files.length) }, worker))
    if (task.controller.signal.aborted) throw this.cancelled(entry.id)
    if (firstError) throw firstError
    report(true)
  }

  // --- user-supplied sources

  /** Checks every chosen path and measures its new data. */
  private async classify(files: string[], include: string[] | null): Promise<Source[]> {
    const sources: Source[] = []
    for (const input of files) {
      const abs = path.resolve(input)
      const stats = await statOrNull(abs)
      if (!stats) throw new MpmError('E_ARGS', `not found: ${abs}`)
      const ext = path.extname(abs).toLowerCase()
      if (stats.isDirectory()) {
        const bvh = await findBvh(abs, MAX_FOLDER_BVH)
        if (bvh.length === 0) throw new MpmError('E_ARGS', `no .bvh files in ${abs}`)
        let bytes = 0
        for (const f of bvh) bytes += (await fs.stat(f)).size
        sources.push({ abs, kind: 'folder', files: bvh, bytes })
      } else if (stats.isFile() && ext === '.zip') {
        await refuseLfsPointer(abs, stats.size)
        sources.push({ abs, kind: 'zip', files: [], bytes: (await zipBvhBytes(abs, include)) ?? stats.size * ZIP_FALLBACK_RATIO })
      } else if (stats.isFile() && ext === '.bvh') {
        sources.push({ abs, kind: 'bvh', files: [abs], bytes: stats.size })
      } else {
        throw new MpmError('E_ARGS', `choose .zip files, .bvh files or folders of .bvh files: ${abs}`)
      }
    }
    return sources
  }

  /**
   * Copies the chosen folders and .bvh files into `incoming`, keeping paths relative to the chosen
   * folder (a single file goes to the top). Returns the copies, sorted.
   */
  private async stage(sources: Source[], incoming: string, signal: AbortSignal): Promise<string[]> {
    const staged = new Set<string>()
    for (const source of sources) {
      const base = source.kind === 'folder' ? source.abs : path.dirname(source.abs)
      for (const file of source.files) {
        signal.throwIfAborted()
        const rel = path.relative(base, file)
        const { dest } = await placeFile(file, path.join(incoming, path.dirname(rel)), path.basename(rel))
        staged.add(dest)
      }
    }
    return [...staged].sort()
  }

  // --- public API (arguments are `unknown`: they come from IPC and are validated here)

  /** Every packs.json pack with its state, plus `mine` when it exists. */
  async list(): Promise<PackInfo[]> {
    const settings = await loadSettings(this.opts.settingsFile)
    const info = async (entry: PackEntry, accepted: boolean): Promise<PackInfo> => {
      const index = await readIndex(this.packDir(entry.id))
      return {
        ...entry,
        installed: index !== null,
        clips: index?.clips.length ?? 0,
        licenseAccepted: accepted,
        busy: this.tasks.has(entry.id),
        stale: index !== null && (index.converter_version ?? 0) < this.packs.converter_version
      }
    }
    const out: PackInfo[] = []
    for (const entry of this.packs.packs) {
      out.push(await info(entry, settings.licenses?.[entry.id]?.license === entry.license))
    }
    if ((await readIndex(this.packDir(MINE_PACK_ID))) !== null || this.tasks.has(MINE_PACK_ID)) {
      out.push(await info(MINE_ENTRY, true))
    }
    return out
  }

  /**
   * Downloads (verified, resumable) and converts a pack with a `files` download. Files already in
   * raw/<pack> with the right SHA-256 are not fetched again, so this also re-converts a stale pack.
   */
  async install(input: unknown): Promise<LibraryInstallResult> {
    const args = parse(installArgs, input, 'library.install arguments')
    const entry = this.entry(args.packId)
    this.requireLicense(args.acceptLicense)
    if (!('files' in entry.download)) {
      throw new MpmError('E_ARGS', `${entry.title} is not downloadable: choose the downloaded file`)
    }
    const files = entry.download.files
    const task = this.begin(entry.id, 'install')
    try {
      await this.recordLicense(entry)
      await this.requireSpace(DISK_FACTOR * files.reduce((sum, f) => sum + f.size, 0))
      const raw = this.rawDir(entry.id)
      await this.downloadAll(task, entry, raw)
      const paths = files.map((f) => path.join(raw, f.name))
      return await this.build(task, entry, (packDir) => this.convertAll(task, entry, this.batches(paths, raw), packDir))
    } finally {
      this.end(task)
    }
  }

  /**
   * Converts user-supplied sources (any mix of .zip files, folders and .bvh files) into a pack.
   * Folders and .bvh files are copied, and zips extracted, into raw/<pack>/ (staged until the pack
   * is in place). Without `append` the pack and its raw/ folder are replaced; with `append` the new
   * clips are added to the existing pack (a source with the same relative path replaces the old one).
   */
  async installFromFile(input: unknown): Promise<LibraryInstallResult> {
    const args = parse(installFromFileArgs, input, 'library.installFromFile arguments')
    const entry = this.entry(args.packId)
    this.requireLicense(args.acceptLicense)
    const append = args.append === true
    const sources = await this.classify(args.files, entry.include ?? null)

    const task = this.begin(entry.id, 'install')
    try {
      await this.recordLicense(entry)
      const newBytes = sources.reduce((sum, s) => sum + s.bytes, 0)
      await this.requireSpace(DISK_FACTOR * newBytes + (append ? await dirSize(this.packDir(entry.id)) : 0))

      const raw = this.rawDir(entry.id)
      const incoming = this.incomingDir(entry.id)
      await fs.rm(incoming, { recursive: true, force: true })
      await fs.mkdir(incoming, { recursive: true })
      try {
        const staged = await this.stage(sources, incoming, task.controller.signal).catch((e) => {
          if (task.controller.signal.aborted) throw this.cancelled(entry.id)
          throw e
        })
        const include = entry.include ? { include: entry.include } : {}
        const jobs = [
          ...sources.filter((s) => s.kind === 'zip').map((s) => ({ archives: [s.abs], extract_dir: incoming, root: incoming, ...include })),
          ...this.batches(staged, incoming)
        ]
        const commit = async () => {
          if (append) {
            await fs.mkdir(raw, { recursive: true })
            await mergeInto(incoming, raw)
          } else {
            await fs.rm(raw, { recursive: true, force: true })
            await fs.mkdir(path.dirname(raw), { recursive: true })
            await renameWithRetry(incoming, raw)
          }
        }
        return await this.build(task, entry, (packDir) => this.convertAll(task, entry, jobs, packDir), {
          seed: append ? this.packDir(entry.id) : null,
          commit
        })
      } finally {
        await fs.rm(incoming, { recursive: true, force: true }).catch(() => {})
      }
    } finally {
      this.end(task)
    }
  }

  /**
   * Converts everything in raw/<pack>/ again into a fresh pack and swaps it in: how a stale pack
   * (including `mine` and user-supplied packs) is brought up to the current converter.
   */
  async reconvert(input: unknown): Promise<LibraryInstallResult> {
    const packId = parse(packIdArg, input, 'pack id')
    const entry = packId === MINE_PACK_ID ? MINE_ENTRY : this.entry(packId)
    const task = this.begin(packId, 'install')
    try {
      const raw = this.rawDir(packId)
      const files = await findBvh(raw, Number.MAX_SAFE_INTEGER)
      if (files.length === 0) throw new MpmError('E_ARGS', `nothing to re-convert: raw/${packId} has no .bvh files`)
      let bytes = 0
      for (const f of files) bytes += (await fs.stat(f)).size
      await this.requireSpace(bytes)
      return await this.build(task, entry, (packDir) => this.convertAll(task, entry, this.batches(files, raw), packDir))
    } finally {
      this.end(task)
    }
  }

  /** Copies one BVH into raw/mine/ (a free name; identical bytes re-use the copy) and converts it into `mine`. */
  async importClip(input: unknown): Promise<{ packId: 'mine'; clipIds: string[] }> {
    const args = parse(importClipArgs, input, 'library.importClip arguments')
    const file = path.resolve(args.file)
    const stats = await statOrNull(file)
    if (!stats?.isFile() || path.extname(file).toLowerCase() !== '.bvh') throw new MpmError('E_ARGS', `choose a .bvh file: ${file}`)
    const task = this.begin(MINE_PACK_ID, 'import')
    try {
      await this.requireSpace(DISK_FACTOR * stats.size)
      const raw = this.rawDir(MINE_PACK_ID)
      const { dest, created } = await placeFile(file, raw, path.basename(file))
      const packDir = this.packDir(MINE_PACK_ID)
      await fs.mkdir(packDir, { recursive: true })
      const entry = { ...MINE_ENTRY, source: args.source ?? null }
      try {
        const result = await this.convertJob(task, { source: entry.source, files: [dest], root: raw, pack_dir: packDir, pack: this.packMeta(entry) })
        if (result.clips.length === 0) throw new MpmError('E_IMPORT_FAILED', result.failed[0]?.error || 'the clip could not be converted')
        return { packId: MINE_PACK_ID, clipIds: result.clips }
      } catch (e) {
        if (created) await fs.rm(dest, { force: true }).catch(() => {})
        if (task.controller.signal.aborted) throw this.cancelled(MINE_PACK_ID)
        if (!(e instanceof JobFailed)) throw asMpmError(e, 'E_INTERNAL')
        const { code, message, detail } = e.payload
        const why = toFailures(detail.failed)[0]?.error
        throw new MpmError(code, why ? `${path.basename(file)}: ${why}` : message, detail)
      }
    } finally {
      this.end(task)
    }
  }

  /**
   * Stops a pack's download and its queued and running jobs; removes packs/<id>.installing and the
   * staged sources, and keeps raw/<id>. Resolves once the operation has ended.
   */
  async cancel(input: unknown): Promise<void> {
    const packId = parse(packIdArg, input, 'pack id')
    const task = this.tasks.get(packId)
    if (!task) {
      await fs.rm(this.installingDir(packId), { recursive: true, force: true })
      await fs.rm(this.incomingDir(packId), { recursive: true, force: true })
      return
    }
    task.controller.abort()
    for (const jobId of [...task.jobIds]) this.opts.runner.cancel(jobId)
    await task.done
  }

  /** Deletes packs/<id> and raw/<id> (and leftovers). Refused while the pack is busy. */
  async remove(input: unknown): Promise<void> {
    const packId = parse(packIdArg, input, 'pack id')
    if (packId !== MINE_PACK_ID) this.entry(packId)
    const task = this.begin(packId, 'remove')
    try {
      for (const dir of [this.packDir(packId), this.installingDir(packId), this.rawDir(packId), this.incomingDir(packId)]) {
        await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 })
      }
    } finally {
      this.end(task)
    }
  }

  /** Writes packs/<pack>/thumbs/<clip>_<frame>.png atomically. */
  async saveThumb(input: unknown): Promise<void> {
    const args = parse(saveThumbArgs, input, 'thumbnail')
    const packDir = this.packDir(args.packId)
    if (!(await statOrNull(packDir))?.isDirectory()) throw new MpmError('E_ARGS', `pack ${args.packId} is not installed`)
    const thumbs = path.join(packDir, 'thumbs')
    await fs.mkdir(thumbs, { recursive: true })
    await writeFileAtomic(path.join(thumbs, `${args.clipId}_${args.frame}.png`), args.png)
  }

  /** Cancels everything (app shutdown). */
  async shutdown(): Promise<void> {
    await Promise.all([...this.tasks.keys()].map((id) => this.cancel(id).catch(() => {})))
  }
}
