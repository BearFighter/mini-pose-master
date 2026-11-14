// SPDX-License-Identifier: GPL-3.0-or-later
// Project folders and .mposer files (docs/contracts.md section 15). Node built-ins only.
import { randomBytes } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { MpmError } from './errors'
import { isEnoent, isInside, renameWithRetry, samePath, writeFileAtomic } from './fsutil'

export const PROJECT_EXT = '.mposer'
export const SCHEMA_VERSION = 1
export const APP_NAME = 'Mini Pose Master'
export const PROJECT_SUBDIRS = ['source', 'rig', 'weapons', 'exports', 'cache'] as const
export const IMAGE_EXTS: ReadonlySet<string> = new Set(['.png', '.jpg', '.jpeg', '.tga', '.tif', '.tiff', '.bmp', '.exr', '.dds'])
const TEXTURES_DIR = 'textures'
const MAX_TREE_DEPTH = 8
const MAX_NAME_LENGTH = 100

/** The .mposer JSON (contracts section 15). Sections owned by other work packages stay `unknown`. */
export interface ProjectFile {
  schemaVersion: number
  app: string
  appVersion: string
  source: { file: string; orientation: unknown } | null
  rig: unknown
  pose: unknown
  hands: unknown
  weapons: unknown[]
  bake: unknown
  [key: string]: unknown
}

export interface ProjectHandle {
  dir: string
  project: ProjectFile
}

/** Bake defaults (contracts section 14). */
export function defaultBake(): Record<string, unknown> {
  return {
    schema: 'mpm.bake/1',
    scale: { mode: 'height_mm', height_mm: 40 },
    detail: 2.0,
    flatten_mm: 0.5,
    base_mm: 0,
    min_wall_mm: 0.6,
    weapons_separate: false,
    max_tris: 2000000
  }
}

export function newProject(appVersion: string): ProjectFile {
  return {
    schemaVersion: SCHEMA_VERSION,
    app: APP_NAME,
    appVersion,
    source: null,
    rig: null,
    pose: null,
    hands: null,
    weapons: [],
    bake: defaultBake()
  }
}

/**
 * Makes a project name safe as a folder and file name on Windows, macOS and Linux: characters
 * `<>:"/\|?*` and control characters become `_`, leading dots and trailing dots/spaces are removed,
 * a trailing `.mposer` is dropped, Windows device names get a `_` prefix, and the length is capped.
 * Throws when nothing usable is left.
 */
export function sanitizeName(name: string): string {
  let s = String(name ?? '').normalize('NFC')
  s = s.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_').trim()
  if (s.toLowerCase().endsWith(PROJECT_EXT)) s = s.slice(0, -PROJECT_EXT.length)
  s = s.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '')
  s = Array.from(s).slice(0, MAX_NAME_LENGTH).join('').replace(/[.\s]+$/, '')
  if (/^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i.test(s)) s = `_${s}`
  if (s === '') throw new MpmError('E_ARGS', 'The project name is empty')
  return s
}

// ---------------------------------------------------------------------------------------------------
// Migrations

type Migration = (project: Record<string, unknown>) => Record<string, unknown>

/** MIGRATIONS[n] turns a schemaVersion n project into schemaVersion n + 1. None exist yet. */
const MIGRATIONS: Record<number, Migration> = {}

/** Validates `schemaVersion` and runs the migrations up to SCHEMA_VERSION. */
export function migrateProject(raw: unknown): ProjectFile {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new MpmError('E_IO', 'The project file does not contain a project')
  let project = raw as Record<string, unknown>
  const version = project.schemaVersion
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new MpmError('E_IO', 'The project file has no valid schemaVersion')
  }
  if (version > SCHEMA_VERSION) {
    throw new MpmError('E_IO', `The project was saved by a newer version of ${APP_NAME} (schema ${version}); please update the app`)
  }
  for (let from = version; from < SCHEMA_VERSION; from++) {
    const step = MIGRATIONS[from]
    if (!step) throw new MpmError('E_IO', `No migration from project schema ${from}`)
    project = { ...step(project), schemaVersion: from + 1 }
  }
  return project as ProjectFile
}

// ---------------------------------------------------------------------------------------------------
// Files

async function statOrNull(p: string) {
  try {
    return await fs.stat(p)
  } catch (e) {
    if (isEnoent(e)) return null
    throw e
  }
}

/** The project's .mposer file in `dir`: `<folder name>.mposer` if present, else the only .mposer file. */
export async function findProjectFile(dir: string): Promise<string> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch((e) => {
    if (isEnoent(e)) throw new MpmError('E_ARGS', `Project folder not found: ${dir}`)
    throw e
  })
  const files = entries.filter((e) => e.isFile() && e.name.toLowerCase().endsWith(PROJECT_EXT)).map((e) => e.name)
  const preferred = `${path.basename(path.resolve(dir))}${PROJECT_EXT}`.toLowerCase()
  const match = files.find((name) => name.toLowerCase() === preferred) ?? (files.length === 1 ? files[0] : undefined)
  if (match) return path.join(dir, match)
  if (files.length === 0) throw new MpmError('E_ARGS', `No ${PROJECT_EXT} file in ${dir}`)
  throw new MpmError('E_ARGS', `Several ${PROJECT_EXT} files in ${dir}; open one of them directly`)
}

async function readProjectFile(file: string): Promise<ProjectFile> {
  const text = await fs.readFile(file, 'utf8')
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new MpmError('E_IO', `${path.basename(file)} is not a valid project file (broken JSON)`)
  }
  return migrateProject(raw)
}

async function writeProjectFile(file: string, project: unknown): Promise<void> {
  await writeFileAtomic(file, JSON.stringify(project, null, 2) + '\n')
}

function toProjectRelative(...segments: string[]): string {
  return segments.join('/')
}

/**
 * Creates `<parentDir>/<Name>/` with source/, rig/, weapons/, exports/, cache/ and `<Name>.mposer`.
 * The folder must not exist yet (an existing empty folder is accepted).
 */
export async function create(args: { name: string; parentDir: string }, appVersion: string): Promise<ProjectHandle> {
  const name = sanitizeName(args.name)
  if (typeof args.parentDir !== 'string' || args.parentDir === '') throw new MpmError('E_ARGS', 'parentDir is required')
  const parentDir = path.resolve(args.parentDir)
  const parent = await statOrNull(parentDir)
  if (!parent?.isDirectory()) throw new MpmError('E_ARGS', `Folder not found: ${parentDir}`)

  const dir = path.join(parentDir, name)
  try {
    await fs.mkdir(dir)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    const existing = await statOrNull(dir)
    if (!existing?.isDirectory() || (await fs.readdir(dir)).length > 0) {
      throw new MpmError('E_ARGS', `"${name}" already exists in ${parentDir}`)
    }
  }
  for (const sub of PROJECT_SUBDIRS) await fs.mkdir(path.join(dir, sub), { recursive: true })
  const project = newProject(appVersion)
  await writeProjectFile(path.join(dir, `${name}${PROJECT_EXT}`), project)
  return { dir, project }
}

/** Opens a project from its .mposer file or from the folder that contains it. */
export async function open(target: string): Promise<ProjectHandle> {
  if (typeof target !== 'string' || target === '') throw new MpmError('E_ARGS', 'path is required')
  const abs = path.resolve(target)
  const stats = await statOrNull(abs)
  if (!stats) throw new MpmError('E_ARGS', `No project at ${abs}`)
  let file: string
  if (stats.isDirectory()) {
    file = await findProjectFile(abs)
  } else {
    if (!abs.toLowerCase().endsWith(PROJECT_EXT)) throw new MpmError('E_ARGS', `Not a ${PROJECT_EXT} file: ${abs}`)
    file = abs
  }
  return { dir: path.dirname(file), project: await readProjectFile(file) }
}

/** Saves the project JSON atomically into the project's .mposer file. */
export async function save(args: { dir: string; project: unknown }): Promise<void> {
  const project = args.project as Record<string, unknown> | null
  if (!project || typeof project !== 'object' || Array.isArray(project)) throw new MpmError('E_ARGS', 'project must be an object')
  if (project.schemaVersion !== SCHEMA_VERSION) throw new MpmError('E_ARGS', `project.schemaVersion must be ${SCHEMA_VERSION}`)
  const dir = path.resolve(args.dir)
  let file: string
  try {
    file = await findProjectFile(dir)
  } catch (e) {
    // A project folder whose .mposer was deleted: write it again under the folder name.
    const stats = await statOrNull(dir)
    if (!stats?.isDirectory()) throw e
    file = path.join(dir, `${path.basename(dir)}${PROJECT_EXT}`)
  }
  await writeProjectFile(file, project)
}

async function requireFile(file: string): Promise<string> {
  if (typeof file !== 'string' || file === '') throw new MpmError('E_ARGS', 'file is required')
  const abs = path.resolve(file)
  const stats = await statOrNull(abs)
  if (!stats?.isFile()) throw new MpmError('E_ARGS', `File not found: ${abs}`)
  return abs
}

function isImage(name: string): boolean {
  return IMAGE_EXTS.has(path.extname(name).toLowerCase())
}

async function realpathOr(p: string): Promise<string> {
  return fs.realpath(p).catch(() => path.resolve(p))
}

/** The lines of a text file, streamed (OBJ files can be large). An unreadable file gives no lines. */
async function readLines(file: string): Promise<string[]> {
  const out: string[] = []
  try {
    const rl = readline.createInterface({ input: createReadStream(file), crlfDelay: Infinity })
    for await (const line of rl) out.push(line)
  } catch {
    // best effort: references we can't read are simply not followed
  }
  return out
}

/** The arguments of every `mtllib` statement in an OBJ file. */
async function objMaterialLibs(obj: string): Promise<string[]> {
  const libs: string[] = []
  for (const line of await readLines(obj)) {
    const m = /^\s*mtllib\s+(.+?)\s*$/.exec(line)
    if (m) libs.push(m[1])
  }
  return libs
}

// Texture statement options (MTL spec) with the [min, max] number of values each takes.
const MTL_OPTIONS: Record<string, [number, number]> = {
  '-blendu': [1, 1],
  '-blendv': [1, 1],
  '-bm': [1, 1],
  '-boost': [1, 1],
  '-cc': [1, 1],
  '-clamp': [1, 1],
  '-imfchan': [1, 1],
  '-mm': [1, 2],
  '-o': [1, 3],
  '-s': [1, 3],
  '-t': [1, 3],
  '-texres': [1, 1],
  '-type': [1, 1]
}
const NUMBER_RE = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/

/** The file name in the arguments of an MTL texture statement, after its options (`-s 1 1 1 skin.png` → `skin.png`). */
export function mtlTextureFile(args: string): string | null {
  const tokens = [...args.matchAll(/\S+/g)]
  let i = 0
  while (i < tokens.length && MTL_OPTIONS[tokens[i][0].toLowerCase()]) {
    const [min, max] = MTL_OPTIONS[tokens[i][0].toLowerCase()]
    i++
    for (let taken = 0; taken < max && i < tokens.length && (taken < min || NUMBER_RE.test(tokens[i][0])); taken++) i++
  }
  if (i >= tokens.length) return null
  return args.slice(tokens[i].index).trim() || null
}

/** The texture file names of the `map_*`, `bump` and `norm` statements of an MTL file. */
async function mtlTextures(mtl: string): Promise<string[]> {
  const textures: string[] = []
  for (const raw of await readLines(mtl)) {
    const m = /^\s*(\S+)\s+(.+?)\s*$/.exec(raw)
    if (!m) continue
    const keyword = m[1].toLowerCase()
    if (!keyword.startsWith('map_') && keyword !== 'bump' && keyword !== 'norm') continue
    const file = mtlTextureFile(m[2])
    if (file) textures.push(file)
  }
  return textures
}

/** The `uri` of every buffer and image of a .gltf file. */
async function gltfUris(file: string): Promise<string[]> {
  let json: unknown
  try {
    json = JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    return []
  }
  const uris: string[] = []
  for (const key of ['buffers', 'images']) {
    const list = (json as Record<string, unknown> | null)?.[key]
    if (!Array.isArray(list)) continue
    for (const item of list) {
      const uri = (item as { uri?: unknown } | null)?.uri
      if (typeof uri === 'string') uris.push(uri)
    }
  }
  return uris
}

/**
 * The files of one model import, keyed by their path relative to the model's folder. Only files
 * inside the model's folder (also after following links) are taken; other references are
 * recorded in `skipped` as written.
 */
class ImportPlan {
  readonly files = new Map<string, { abs: string; rel: string }>()
  readonly skipped: string[] = []

  constructor(
    readonly modelDir: string,
    private readonly realModelDir: string
  ) {}

  private put(abs: string): void {
    const rel = path.relative(this.modelDir, abs).split(path.sep).join('/')
    const key = process.platform === 'linux' ? rel : rel.toLowerCase()
    if (!this.files.has(key)) this.files.set(key, { abs, rel })
  }

  skip(ref: string): void {
    if (!this.skipped.includes(ref)) this.skipped.push(ref)
  }

  /** The model itself: always taken. */
  addModel(abs: string): void {
    this.put(abs)
  }

  /** Takes an existing file inside the model's folder; otherwise records `ref` as skipped. */
  async addFile(abs: string, ref: string): Promise<boolean> {
    const stats = await statOrNull(abs)
    if (!stats?.isFile() || !isInside(this.modelDir, abs) || !isInside(this.realModelDir, await realpathOr(abs))) {
      this.skip(ref)
      return false
    }
    this.put(abs)
    return true
  }

  /** A reference written in a model or material file, relative to `baseDir` (`\` is read as `/`). */
  addRef(baseDir: string, ref: string): Promise<boolean> {
    return this.addFile(path.resolve(baseDir, ref.replace(/\\/g, '/')), ref)
  }

  /** Takes the files under `dir` (recursively) whose names pass `filter`. */
  async addTree(dir: string, filter: (name: string) => boolean, depth = 0): Promise<void> {
    if (depth > MAX_TREE_DEPTH) return
    for (const name of await fs.readdir(dir)) {
      const abs = path.join(dir, name)
      const stats = await statOrNull(abs)
      if (stats?.isDirectory()) await this.addTree(abs, filter, depth + 1)
      else if (stats?.isFile() && filter(name)) await this.addFile(abs, path.relative(this.modelDir, abs).split(path.sep).join('/'))
    }
  }
}

/**
 * Works out which files belong to a model: the model; the images next to it; the images in
 * `textures/`; every file with the model's stem (hero.mtl, hero.bin, ...); for FBX the `<stem>.fbm/`
 * folder; for OBJ the `mtllib` files and their `map_*` / `bump` / `norm` textures; for .gltf the
 * relative `uri`s of buffers and images (data: URIs are embedded and need nothing).
 */
async function planImport(model: string): Promise<ImportPlan> {
  const modelDir = path.dirname(model)
  const plan = new ImportPlan(modelDir, await realpathOr(modelDir))
  plan.addModel(model)
  const modelName = path.basename(model)
  const ext = path.extname(modelName).toLowerCase()
  const stem = path.parse(modelName).name.toLowerCase()

  for (const entry of await fs.readdir(modelDir)) {
    const abs = path.join(modelDir, entry)
    const lower = entry.toLowerCase()
    const stats = await statOrNull(abs)
    if (stats?.isDirectory()) {
      if (lower === TEXTURES_DIR) await plan.addTree(abs, isImage)
      else if (ext === '.fbx' && lower === `${stem}.fbm`) await plan.addTree(abs, () => true)
    } else if (stats?.isFile() && (isImage(entry) || path.parse(entry).name.toLowerCase() === stem)) {
      await plan.addFile(abs, entry)
    }
  }

  if (ext === '.obj') {
    for (const lib of await objMaterialLibs(model)) {
      // `mtllib a.mtl b.mtl` lists several files, but exporters also write single names with spaces.
      const whole = path.resolve(modelDir, lib.replace(/\\/g, '/'))
      const refs = (await statOrNull(whole))?.isFile() ? [lib] : lib.split(/\s+/)
      for (const ref of refs) {
        const mtl = path.resolve(modelDir, ref.replace(/\\/g, '/'))
        if (!(await plan.addRef(modelDir, ref))) continue
        for (const texture of await mtlTextures(mtl)) await plan.addRef(path.dirname(mtl), texture)
      }
    }
  } else if (ext === '.gltf') {
    for (const uri of await gltfUris(model)) {
      if (/^data:/i.test(uri)) continue
      // A URL scheme (http:, file:, ...) is not a relative path; a single letter is a Windows drive.
      if (/^[a-z][a-z0-9+.-]+:/i.test(uri)) {
        plan.skip(uri)
        continue
      }
      let decoded = uri
      try {
        decoded = decodeURIComponent(uri)
      } catch {
        // keep it as written
      }
      const abs = path.resolve(modelDir, decoded.replace(/\\/g, '/'))
      await plan.addFile(abs, uri)
    }
  }
  return plan
}

export interface ImportModelResult {
  /** Project-relative paths of every copied file; the model comes first. */
  copied: string[]
  /** References that were not copied, as written: outside the model's folder, not a file path, or missing. */
  skipped: string[]
  /** The project as saved: `source` is the new model (orientation null), `rig` is null. */
  project: ProjectFile
}

/**
 * Imports a model into the project's `source/` folder, keeping paths relative to the model's
 * folder (see planImport for what is copied). The files are first copied to a staging folder in
 * `cache/`; only then is `source/` emptied and filled, so a failed copy leaves the old source intact
 * and a model can be re-imported from `source/` itself. The .mposer file gets
 * `source = {file: "source/<name>", orientation: null}` and `rig = null` (the old rig no longer
 * matches); the files in `rig/` are left alone.
 */
export async function importModel(args: { dir: string; file: string }): Promise<ImportModelResult> {
  const dir = path.resolve(args.dir)
  const projectFile = await findProjectFile(dir)
  const project = await readProjectFile(projectFile)
  const model = await requireFile(args.file)
  const plan = await planImport(model)

  const sourceDir = path.join(dir, 'source')
  const staging = path.join(dir, 'cache', `import-${randomBytes(4).toString('hex')}`)
  try {
    for (const { abs, rel } of plan.files.values()) {
      const to = path.join(staging, ...rel.split('/'))
      await fs.mkdir(path.dirname(to), { recursive: true })
      await fs.copyFile(abs, to)
    }
    await fs.mkdir(sourceDir, { recursive: true })
    for (const name of await fs.readdir(sourceDir)) {
      await fs.rm(path.join(sourceDir, name), { recursive: true, force: true, maxRetries: 3 })
    }
    for (const name of await fs.readdir(staging)) {
      await renameWithRetry(path.join(staging, name), path.join(sourceDir, name))
    }
  } finally {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {})
  }

  const copied = [...plan.files.values()].map((f) => toProjectRelative('source', ...f.rel.split('/')))
  project.source = { file: copied[0], orientation: null }
  project.rig = null
  await writeProjectFile(projectFile, project)
  return { copied, skipped: plan.skipped, project }
}

/** Creates and returns a new folder in `dir`: `stem`, then `stem-2`, `stem-3`, ... */
async function claimFolder(dir: string, stem: string): Promise<string> {
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? stem : `${stem}-${n}`
    try {
      await fs.mkdir(path.join(dir, candidate))
      return candidate
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
  }
}

export interface AddWeaponResult {
  /** `weapons/<stem>/<file>`. */
  weaponFile: string
  /** Project-relative paths of every copied file; the weapon comes first. */
  copied: string[]
  /** References not copied (same rules as importModel), as written. */
  skipped: string[]
}

/**
 * Copies a weapon and its sidecars (the same rules as importModel, see planImport) into a new
 * `weapons/<stem>/` folder (`<stem>-2`, ... when taken), keeping paths relative to the weapon's
 * folder. A weapon that is already inside weapons/ is used where it is.
 */
export async function addWeapon(args: { dir: string; file: string }): Promise<AddWeaponResult> {
  const dir = path.resolve(args.dir)
  const weapon = await requireFile(args.file)
  const weaponsDir = path.join(dir, 'weapons')
  await fs.mkdir(weaponsDir, { recursive: true })
  if (isInside(weaponsDir, weapon) && !samePath(weaponsDir, weapon)) {
    const weaponFile = toProjectRelative('weapons', ...path.relative(weaponsDir, weapon).split(path.sep))
    return { weaponFile, copied: [], skipped: [] }
  }
  const plan = await planImport(weapon)
  const folder = await claimFolder(weaponsDir, path.parse(weapon).name || 'weapon')
  const target = path.join(weaponsDir, folder)
  try {
    for (const { abs, rel } of plan.files.values()) {
      const to = path.join(target, ...rel.split('/'))
      await fs.mkdir(path.dirname(to), { recursive: true })
      await fs.copyFile(abs, to)
    }
  } catch (e) {
    await fs.rm(target, { recursive: true, force: true }).catch(() => {})
    throw e
  }
  const copied = [...plan.files.values()].map((f) => toProjectRelative('weapons', folder, ...f.rel.split('/')))
  return { weaponFile: copied[0], copied, skipped: plan.skipped }
}
