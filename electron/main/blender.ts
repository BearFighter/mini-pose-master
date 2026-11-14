// SPDX-License-Identifier: GPL-3.0-or-later
// Blender manager (docs/contracts.md section 19): detection, version probe and download.
// Node built-ins and the global fetch only; no Electron APIs here.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs, readdirSync, realpathSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { BlenderStatus } from '../../src/shared/ipc'
import { asMpmError, MpmError } from './errors'
import { isInside } from './fsutil'
import { cleanEnv } from './jobs'
import { loadSettings, settingsFile, updateSettings } from './settings'

export const RELEASE_URL = 'https://download.blender.org/release/Blender5.2/'
/** Free space required before a download starts. */
export const MIN_FREE_BYTES = 2.5 * 1024 ** 3
export const PROBE_TIMEOUT_MS = 8000
const PROGRESS_INTERVAL_MS = 100

const VERSION_RE = /^Blender (\d+)\.(\d+)\.(\d+)/
const VERSION_DIR_RE = /^5\.2\.(\d+)$/
// `~/blender-5.2*`, but not `blender-5.20…`.
const HOME_BUILD_RE = /^blender-5\.2(?![0-9])(?:\.(\d+))?/

// ---------------------------------------------------------------------------------------------------
// Detection

export type CandidateSource = 'user' | 'downloaded' | 'installed'

export interface Candidate {
  path: string
  source: CandidateSource
}

export interface CandidateOptions {
  /** The user-set path from settings; always the first candidate. */
  userPath?: string
  /** Data folder; downloaded builds live in `<dataDir>/blender/5.2.N/`. */
  dataDir?: string
  /** Names of the sub-folders of `dir` ([] when it can't be read). Injected by tests. */
  listDirs?: (dir: string) => string[]
}

function pathApi(platform: NodeJS.Platform): typeof path.posix {
  return platform === 'win32' ? path.win32 : path.posix
}

/** Environment lookup; case-insensitive on Windows (PATH may be spelled `Path`). */
function envGet(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== 'win32') return env[name] || undefined
  const upper = name.toUpperCase()
  const key = Object.keys(env).find((k) => k.toUpperCase() === upper)
  return key !== undefined ? env[key] || undefined : undefined
}

function pathEntries(value: string | undefined, platform: NodeJS.Platform): string[] {
  if (!value) return []
  const p = pathApi(platform)
  return value
    .split(platform === 'win32' ? ';' : ':')
    .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
    .filter((entry) => entry !== '' && p.isAbsolute(entry))
}

function defaultListDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

function patchOf(name: string, re: RegExp): number {
  const m = re.exec(name)
  return m && m[1] !== undefined ? Number(m[1]) : -1
}

/**
 * Rejected executables (contracts section 19): `blender-launcher.exe` (it only opens the GUI),
 * Microsoft Store installs (`WindowsApps`), Snap (`/snap/`) and Flatpak builds (sandboxed).
 */
export function isRejected(binary: string): boolean {
  const norm = binary.replace(/\\/g, '/')
  const lower = norm.toLowerCase()
  const segments = lower.split('/')
  if (segments[segments.length - 1] === 'blender-launcher.exe') return true
  if (segments.includes('windowsapps')) return true
  if (lower.includes('/snap/')) return true
  if (lower.includes('flatpak')) return true
  return false
}

function rejectionReason(binary: string): string {
  const lower = binary.replace(/\\/g, '/').toLowerCase()
  if (lower.endsWith('/blender-launcher.exe') || lower === 'blender-launcher.exe') {
    return 'blender-launcher.exe only opens the Blender window. Choose blender.exe in the same folder.'
  }
  if (lower.split('/').includes('windowsapps')) {
    return 'The Microsoft Store version of Blender cannot be run by other apps. Install Blender 5.2 from blender.org or use the download.'
  }
  return 'Snap and Flatpak versions of Blender are sandboxed and cannot be used. Use the blender.org build or the download.'
}

/** Where the executable sits inside an extracted Blender build folder (top level or one folder down). */
export function binaryCandidates(
  dir: string,
  platform: NodeJS.Platform,
  listDirs: (dir: string) => string[] = defaultListDirs
): string[] {
  const p = pathApi(platform)
  if (platform === 'darwin') return [p.join(dir, 'Blender.app', 'Contents', 'MacOS', 'Blender')]
  const exe = platform === 'win32' ? 'blender.exe' : 'blender'
  return [p.join(dir, exe), ...listDirs(dir).sort().map((sub) => p.join(dir, sub, exe))]
}

/**
 * Ordered Blender candidates (contracts section 19): the user path, then downloaded builds (newest
 * first), then the platform's install locations. Rejected paths are left out; duplicates keep their
 * first position. Existence is not checked here.
 */
export function candidatePaths(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  homedir: string,
  opts: CandidateOptions = {}
): Candidate[] {
  const p = pathApi(platform)
  const listDirs = opts.listDirs ?? defaultListDirs
  const out: Candidate[] = []
  const seen = new Set<string>()
  const add = (candidate: string, source: CandidateSource) => {
    if (!candidate || isRejected(candidate)) return
    const key = platform === 'linux' ? candidate : candidate.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    out.push({ path: candidate, source })
  }

  if (opts.userPath) add(opts.userPath, 'user')

  if (opts.dataDir) {
    const root = p.join(opts.dataDir, 'blender')
    const versions = listDirs(root)
      .filter((name) => VERSION_DIR_RE.test(name))
      .sort((a, b) => patchOf(b, VERSION_DIR_RE) - patchOf(a, VERSION_DIR_RE))
    for (const version of versions) {
      for (const binary of binaryCandidates(p.join(root, version), platform, listDirs)) add(binary, 'downloaded')
    }
  }

  switch (platform) {
    case 'win32': {
      const programFiles = envGet(env, 'ProgramFiles', platform) ?? 'C:\\Program Files'
      const programFilesX86 = envGet(env, 'ProgramFiles(x86)', platform) ?? 'C:\\Program Files (x86)'
      add(p.join(programFiles, 'Blender Foundation', 'Blender 5.2', 'blender.exe'), 'installed')
      for (const root of [programFilesX86, programFiles]) {
        add(p.join(root, 'Steam', 'steamapps', 'common', 'Blender', 'blender.exe'), 'installed')
      }
      for (const dir of pathEntries(envGet(env, 'PATH', platform), platform)) add(p.join(dir, 'blender.exe'), 'installed')
      break
    }
    case 'darwin':
      add('/Applications/Blender.app/Contents/MacOS/Blender', 'installed')
      add(p.join(homedir, 'Applications', 'Blender.app', 'Contents', 'MacOS', 'Blender'), 'installed')
      break
    default: {
      for (const dir of pathEntries(env.PATH, platform)) add(p.join(dir, 'blender'), 'installed')
      const builds = listDirs(homedir)
        .filter((name) => HOME_BUILD_RE.test(name))
        .sort((a, b) => patchOf(b, HOME_BUILD_RE) - patchOf(a, HOME_BUILD_RE) || a.localeCompare(b))
      for (const name of builds) add(p.join(homedir, name, 'blender'), 'installed')
    }
  }
  return out
}

// ---------------------------------------------------------------------------------------------------
// Version probe

export interface BlenderVersion {
  major: number
  minor: number
  patch: number
  version: string
}

/** Parses the first non-empty line of `blender --version` (`Blender 5.2.0 LTS` → 5.2.0). Any version. */
export function parseBlenderVersion(text: string): BlenderVersion | null {
  const first = text.split(/\r?\n/).find((line) => line.trim() !== '')
  const m = first ? VERSION_RE.exec(first.trim()) : null
  if (!m) return null
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])]
  return { major, minor, patch, version: `${major}.${minor}.${patch}` }
}

/** The version string when the output is a supported Blender (5.2.N), else null. */
export function supportedVersion(text: string): string | null {
  const v = parseBlenderVersion(text)
  return v && v.major === 5 && v.minor === 2 ? v.version : null
}

export interface ProbeResult {
  ok: boolean
  version?: string
  error?: string
}

/** Runs `<binary> --version` (8 s timeout). ok only for Blender 5.2.N. */
export function probe(binary: string, timeoutMs: number = PROBE_TIMEOUT_MS, env: NodeJS.ProcessEnv = process.env): Promise<ProbeResult> {
  return new Promise((resolve) => {
    execFile(
      binary,
      ['--version'],
      { timeout: timeoutMs, windowsHide: true, env: cleanEnv(env), maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        const found = parseBlenderVersion(String(stdout ?? ''))
        if (found && found.major === 5 && found.minor === 2) return resolve({ ok: true, version: found.version })
        if (found) {
          return resolve({ ok: false, version: found.version, error: `Blender ${found.version} found, but Blender 5.2 is required` })
        }
        if (err && (err as { killed?: boolean }).killed) return resolve({ ok: false, error: 'Blender did not answer --version in time' })
        if (err) return resolve({ ok: false, error: `cannot run ${binary}: ${err.message}` })
        resolve({ ok: false, error: `${binary} is not Blender (no version line)` })
      }
    )
  })
}

// ---------------------------------------------------------------------------------------------------
// Download index and checksum

/** The release-folder file suffix for a platform/arch, or null when Blender 5.2 has no build for it. */
export function archiveSuffix(platform: NodeJS.Platform, arch: string): string | null {
  if (platform === 'win32' && arch === 'x64') return 'windows-x64.zip'
  if (platform === 'darwin' && arch === 'arm64') return 'macos-arm64.dmg'
  if (platform === 'linux' && arch === 'x64') return 'linux-x64.tar.xz'
  return null
}

function requireArchiveSuffix(platform: NodeJS.Platform, arch: string): string {
  if (platform === 'darwin' && arch === 'x64') {
    throw new MpmError('E_BLENDER_VERSION', 'Blender 5.2 has no Intel Mac build. Mini Pose Master needs a Mac with Apple silicon.')
  }
  const suffix = archiveSuffix(platform, arch)
  if (!suffix) throw new MpmError('E_BLENDER_VERSION', `Blender 5.2 has no download for ${platform} ${arch}.`)
  return suffix
}

export interface IndexEntry {
  version: string
  file: string
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Picks the highest `5.2.N` in a release directory listing that has the archive for this platform/arch. */
export function parseIndex(html: string, platform: NodeJS.Platform = process.platform, arch: string = process.arch): IndexEntry | null {
  const suffix = archiveSuffix(platform, arch)
  if (!suffix) return null
  const fileRe = new RegExp(`^blender-5\\.2\\.(\\d+)-${escapeRegExp(suffix)}$`)
  let best: { patch: number; file: string } | null = null
  for (const m of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    let name = m[1]
    try {
      name = decodeURIComponent(name)
    } catch {
      // keep it raw
    }
    name = name.slice(name.lastIndexOf('/') + 1)
    const hit = fileRe.exec(name)
    if (!hit) continue
    const patch = Number(hit[1])
    if (!best || patch > best.patch) best = { patch, file: name }
  }
  return best ? { version: `5.2.${best.patch}`, file: best.file } : null
}

/** Finds the SHA-256 for `filename` in a checksum file (`<hex>  <name>`, `<hex> *<name>` or `SHA256 (<name>) = <hex>`). */
export function parseSha256(text: string, filename: string): string | null {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    let hex: string | undefined
    let name: string | undefined
    const gnu = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line)
    const bsd = /^SHA256\s*\((.+)\)\s*=\s*([0-9a-fA-F]{64})$/i.exec(line)
    if (gnu) [hex, name] = [gnu[1], gnu[2]]
    else if (bsd) [name, hex] = [bsd[1], bsd[2]]
    if (!hex || !name) continue
    name = name.trim()
    if (name === filename || name.split(/[\\/]/).pop() === filename) return hex.toLowerCase()
  }
  return null
}

// ---------------------------------------------------------------------------------------------------
// Extraction

function cancelledError(): Error {
  return new MpmError('E_CANCELLED', 'Blender download cancelled')
}

function run(command: string, args: string[], failMessage: string, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { signal, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (!err) return resolve()
      if (signal?.aborted) return reject(cancelledError())
      const why = String(stderr ?? '').trim() || err.message
      reject(new MpmError('E_IO', `${failMessage}: ${why}`))
    })
  })
}

/**
 * Extracts a Blender archive into `dest` (created if needed) with the system tools:
 * Windows `tar -xf` (System32 bsdtar reads zip), macOS `hdiutil attach` + `ditto` + `hdiutil detach`,
 * Linux `tar -xJf`.
 */
export async function extractArchive(
  archive: string,
  dest: string,
  options: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {}
): Promise<void> {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const signal = options.signal
  await fs.mkdir(dest, { recursive: true })
  if (platform === 'win32') {
    // The absolute path matters: a GNU tar earlier on PATH (Git, MSYS) cannot read zip files.
    const systemRoot = envGet(env, 'SystemRoot', 'win32') ?? 'C:\\Windows'
    const tar = path.win32.join(systemRoot, 'System32', 'tar.exe')
    await run(tar, ['-xf', archive, '-C', dest], 'Extracting the Blender zip with Windows tar failed', signal)
  } else if (platform === 'darwin') {
    const mount = await fs.mkdtemp(path.join(os.tmpdir(), 'mpm-blender-'))
    try {
      await run('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mount, archive], 'Opening the Blender disk image failed', signal)
      try {
        await run('ditto', [path.join(mount, 'Blender.app'), path.join(dest, 'Blender.app')], 'Copying Blender.app failed', signal)
      } finally {
        await run('hdiutil', ['detach', mount], 'detach').catch(() =>
          run('hdiutil', ['detach', '-force', mount], 'detach').catch(() => {})
        )
      }
    } finally {
      // Not recursive: if the detach failed, the mounted image must not be touched.
      await fs.rmdir(mount).catch(() => {})
    }
  } else {
    await run('tar', ['-xJf', archive, '-C', dest], 'Extracting Blender with the system tar failed (tar with xz support is needed)', signal)
  }
}

// ---------------------------------------------------------------------------------------------------
// Manager

export interface DownloadProgress {
  bytes: number
  total: number
}

export interface BlenderManagerOptions {
  dataDir: string
  /** Default `<dataDir>/settings.json`. */
  settingsFile?: string
  platform?: NodeJS.Platform
  arch?: string
  env?: NodeJS.ProcessEnv
  homedir?: string
  releaseUrl?: string
  // Injection points for tests.
  fetch?: typeof fetch
  probe?: (binary: string) => Promise<ProbeResult>
  extract?: (archive: string, dest: string, signal: AbortSignal) => Promise<void>
  freeBytes?: (dir: string) => Promise<number>
  listDirs?: (dir: string) => string[]
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

function isDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory()
  } catch {
    return false
  }
}

function realpathOr(file: string): string {
  try {
    return realpathSync(file)
  } catch {
    return file
  }
}

function gigabytes(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1)
}

export class BlenderManager {
  readonly dataDir: string
  private readonly settingsPath: string
  private readonly platform: NodeJS.Platform
  private readonly arch: string
  private readonly env: NodeJS.ProcessEnv
  private readonly homedir: string
  private readonly releaseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly probeImpl: (binary: string) => Promise<ProbeResult>
  private readonly extractImpl: (archive: string, dest: string, signal: AbortSignal) => Promise<void>
  private readonly freeBytesImpl: (dir: string) => Promise<number>
  private readonly listDirs: (dir: string) => string[]
  private cached: BlenderStatus | null = null
  private downloading = false

  constructor(options: BlenderManagerOptions) {
    this.dataDir = options.dataDir
    this.settingsPath = options.settingsFile ?? settingsFile(options.dataDir)
    this.platform = options.platform ?? process.platform
    this.arch = options.arch ?? process.arch
    this.env = options.env ?? process.env
    this.homedir = options.homedir ?? os.homedir()
    this.releaseUrl = options.releaseUrl ?? RELEASE_URL
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init))
    this.probeImpl = options.probe ?? ((binary) => probe(binary, PROBE_TIMEOUT_MS, this.env))
    this.extractImpl =
      options.extract ?? ((archive, dest, signal) => extractArchive(archive, dest, { platform: this.platform, env: this.env, signal }))
    this.freeBytesImpl =
      options.freeBytes ??
      (async (dir) => {
        const stats = await fs.statfs(dir)
        return stats.bavail * stats.bsize
      })
    this.listDirs = options.listDirs ?? defaultListDirs
  }

  private sourceOf(candidate: Candidate): 'installed' | 'downloaded' {
    if (candidate.source !== 'user') return candidate.source
    return isInside(path.join(this.dataDir, 'blender'), candidate.path) ? 'downloaded' : 'installed'
  }

  /** Detects Blender afresh: the first existing, non-rejected candidate whose probe passes. */
  async status(): Promise<BlenderStatus> {
    const settings = await loadSettings(this.settingsPath)
    const candidates = candidatePaths(this.platform, this.env, this.homedir, {
      userPath: settings.blenderPath,
      dataDir: this.dataDir,
      listDirs: this.listDirs
    })
    for (const candidate of candidates) {
      if (!isFile(candidate.path) || isRejected(realpathOr(candidate.path))) continue
      const result = await this.probeImpl(candidate.path)
      if (result.ok) {
        const status: BlenderStatus = { found: true, path: candidate.path, version: result.version, source: this.sourceOf(candidate) }
        this.cached = status
        return status
      }
    }
    this.cached = null
    return { found: false, source: null }
  }

  /** The last detected status while its executable still exists; detects again otherwise. */
  async current(): Promise<BlenderStatus> {
    if (this.cached?.found && this.cached.path && isFile(this.cached.path)) return this.cached
    return this.status()
  }

  /** The Blender executable for jobs. Rejects with a clear message when there is none. */
  async requirePath(): Promise<string> {
    const status = await this.current()
    if (!status.found || !status.path) throw new MpmError('E_BLENDER_VERSION', 'Blender 5.2 was not found. Choose its location or download it.')
    return status.path
  }

  /**
   * Sets the user path after checking it is Blender 5.2 (throws with the reason otherwise).
   * An empty string clears the user path. On macOS a selected `Blender.app` is accepted.
   */
  async setPath(input: string): Promise<BlenderStatus> {
    if (typeof input !== 'string') throw new MpmError('E_ARGS', 'path must be a string')
    if (input.trim() === '') {
      await updateSettings({ blenderPath: undefined }, this.settingsPath)
      this.cached = null
      return this.status()
    }
    let binary = path.resolve(input)
    if (this.platform === 'darwin' && binary.toLowerCase().endsWith('.app') && isDirectory(binary)) {
      binary = path.join(binary, 'Contents', 'MacOS', 'Blender')
    }
    if (isRejected(binary)) throw new MpmError('E_BLENDER_VERSION', rejectionReason(binary))
    if (isRejected(realpathOr(binary))) throw new MpmError('E_BLENDER_VERSION', rejectionReason(realpathOr(binary)))
    if (!isFile(binary)) throw new MpmError('E_ARGS', `No file at ${binary}`)
    const result = await this.probeImpl(binary)
    if (!result.ok) throw new MpmError('E_BLENDER_VERSION', result.error ?? 'Not Blender 5.2')
    await updateSettings({ blenderPath: binary }, this.settingsPath)
    const status: BlenderStatus = {
      found: true,
      path: binary,
      version: result.version,
      source: this.sourceOf({ path: binary, source: 'user' })
    }
    this.cached = status
    return status
  }

  /**
   * Downloads the newest Blender 5.2.N from download.blender.org into `<dataDir>/blender/5.2.N/`,
   * verifies its SHA-256, extracts it, probes it and saves it as the user path. Aborting `signal`
   * stops it and removes the partial files.
   */
  async download(onProgress: (progress: DownloadProgress) => void, signal: AbortSignal): Promise<BlenderStatus> {
    const suffix = requireArchiveSuffix(this.platform, this.arch)
    if (this.downloading) throw new MpmError('E_ARGS', 'A Blender download is already running')
    this.downloading = true
    const root = path.join(this.dataDir, 'blender')
    const work = path.join(root, '_download')
    let dest: string | null = null
    try {
      await fs.mkdir(root, { recursive: true })
      const free = await this.freeBytesImpl(root)
      if (free < MIN_FREE_BYTES) {
        throw new MpmError('E_IO', `Not enough free disk space for Blender: 2.5 GB needed, ${gigabytes(free)} GB free.`)
      }
      signal.throwIfAborted()

      const html = await this.fetchText(this.releaseUrl, signal)
      const entry = parseIndex(html, this.platform, this.arch)
      if (!entry) throw new MpmError('E_IO', `No Blender 5.2 ${suffix} build was found at ${this.releaseUrl}`)
      const shaName = `blender-${entry.version}.sha256`
      const expected = parseSha256(await this.fetchText(new URL(shaName, this.releaseUrl).href, signal), entry.file)
      if (!expected) throw new MpmError('E_IO', `${shaName} has no checksum for ${entry.file}`)

      await fs.rm(work, { recursive: true, force: true })
      await fs.mkdir(work, { recursive: true })
      const archive = path.join(work, entry.file)
      const actual = await this.fetchToFile(new URL(entry.file, this.releaseUrl).href, archive, onProgress, signal)
      if (actual !== expected) throw new MpmError('E_IO', `The download of ${entry.file} is damaged (SHA-256 mismatch). Please try again.`)

      dest = path.join(root, entry.version)
      await fs.rm(dest, { recursive: true, force: true })
      await this.extractImpl(archive, dest, signal)
      signal.throwIfAborted()

      const binary = binaryCandidates(dest, this.platform, this.listDirs).find(isFile)
      if (!binary) throw new MpmError('E_IO', `No Blender executable found in the extracted archive (${dest})`)
      const result = await this.probeImpl(binary)
      if (!result.ok) throw new MpmError('E_BLENDER_VERSION', `The downloaded Blender does not run: ${result.error ?? 'unknown error'}`)
      await updateSettings({ blenderPath: binary }, this.settingsPath)
      await fs.rm(work, { recursive: true, force: true })

      const status: BlenderStatus = { found: true, path: binary, version: result.version, source: 'downloaded' }
      this.cached = status
      return status
    } catch (e) {
      await fs.rm(work, { recursive: true, force: true }).catch(() => {})
      if (dest) await fs.rm(dest, { recursive: true, force: true }).catch(() => {})
      if (signal.aborted) throw cancelledError()
      throw asMpmError(e, 'E_IO')
    } finally {
      this.downloading = false
    }
  }

  private async fetchText(url: string, signal: AbortSignal): Promise<string> {
    const res = await this.fetchImpl(url, { signal })
    if (!res.ok) throw new MpmError('E_IO', `Download failed: HTTP ${res.status} for ${url}`)
    return res.text()
  }

  /** Streams `url` into `file`, reporting progress; returns the SHA-256 (hex) of the bytes. */
  private async fetchToFile(
    url: string,
    file: string,
    onProgress: (progress: DownloadProgress) => void,
    signal: AbortSignal
  ): Promise<string> {
    const res = await this.fetchImpl(url, { signal })
    if (!res.ok || !res.body) throw new MpmError('E_IO', `Download failed: HTTP ${res.status} for ${url}`)
    const total = Number(res.headers.get('content-length')) || 0
    const hash = createHash('sha256')
    const reader = res.body.getReader()
    const onAbort = () => {
      reader.cancel().catch(() => {})
    }
    signal.addEventListener('abort', onAbort, { once: true })
    const handle = await fs.open(file, 'w')
    let bytes = 0
    let lastReport = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        signal.throwIfAborted()
        if (done) break
        hash.update(value)
        await handle.write(value)
        bytes += value.byteLength
        const now = Date.now()
        if (now - lastReport >= PROGRESS_INTERVAL_MS) {
          lastReport = now
          onProgress({ bytes, total })
        }
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
      await handle.close()
    }
    onProgress({ bytes, total: total || bytes })
    return hash.digest('hex')
  }
}
