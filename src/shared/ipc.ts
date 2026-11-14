// SPDX-License-Identifier: GPL-3.0-or-later
// Typed IPC surface shared by main, preload and renderer. Matches docs/contracts.md section 17.

export interface FileFilter {
  name: string
  extensions: string[]
}

export interface AppInfo {
  version: string
  platform: string
  arch: string
  dataDir: string
}

export interface UpdateCheckResult {
  available: boolean
  version?: string
  notes?: string
  url?: string
}

export interface BlenderStatus {
  found: boolean
  path?: string
  version?: string
  source: 'installed' | 'downloaded' | null
}

export interface ProjectHandle {
  dir: string
  /** Project JSON (contracts section 15). Typed later, in the project WP. */
  project: unknown
}

/** project.importModel result. */
export interface ImportModelResult {
  /** Project-relative paths of every file copied into source/ (the model first). */
  copied: string[]
  /** References not copied, as written in the model/material files: outside the model's folder, not a file path, or missing. */
  skipped: string[]
  /** The saved project: `source` = the new model with orientation null, `rig` = null. */
  project: unknown
}

/** project.addWeapon result: the weapon and its sidecars are copied into weapons/<stem>/. */
export interface AddWeaponResult {
  /** `weapons/<stem>/<file>`, project-relative. */
  weaponFile: string
  /** Project-relative paths of every copied file (the weapon first). */
  copied: string[]
  /** References not copied (outside the weapon's folder, not a file path, or missing), as written. */
  skipped: string[]
}

/** One downloadable file of a pack (resources/packs.json, contracts section 20). */
export interface PackFileEntry {
  name: string
  url: string
  sha256: string
  size: number
}

export type PackDownload =
  | { files: PackFileEntry[] }
  | { user_supplied: true; accepts: string[]; instructions: string }

/** A pack as listed in resources/packs.json. The `mine` pack has no download and source null. */
export interface PackEntry {
  id: string
  title: string
  /** Converter source id (`bandai`, `lafan1`, `cmu`); null for `mine` (detected per clip). */
  source: string | null
  license: string
  license_url: string
  nc: boolean
  exportable: boolean
  attribution?: string
  homepage?: string
  download?: PackDownload
  /** Lower-case member-name filters for .zip installs, or null. */
  include?: string[] | null
}

/** library.list entry. */
export interface PackInfo extends PackEntry {
  /** packs/<id>/index.json exists. */
  installed: boolean
  /** Number of clips in the installed pack. */
  clips: number
  /** The current license text was accepted (settings.licenses). */
  licenseAccepted: boolean
  /** An install, import or removal of this pack is running. */
  busy: boolean
  /** The installed pack was made by an older converter than packs.json's converter_version. */
  stale: boolean
}

/** @deprecated Use PackInfo. */
export type LibraryPackEntry = PackInfo

/** A BVH file the converter could not convert. */
export interface ClipFailure {
  file: string
  error: string
}

/** library.install / library.installFromFile result. */
export interface LibraryInstallResult {
  /** Number of clips in the installed pack. */
  clips: number
  failed: ClipFailure[]
}

export interface MpmApi {
  app: {
    info(): Promise<AppInfo>
    checkUpdate(): Promise<UpdateCheckResult>
    installUpdate(): Promise<void>
  }
  blender: {
    status(): Promise<BlenderStatus>
    setPath(path: string): Promise<BlenderStatus>
    download(): Promise<BlenderStatus>
    cancelDownload(): Promise<void>
  }
  dialog: {
    openFile(args: { filters: FileFilter[] }): Promise<string | null>
    /** Several files (or folders with `folders: true`); [] when cancelled. */
    openFiles(args: { filters: FileFilter[]; folders?: boolean }): Promise<string[]>
    openFolder(args?: { title?: string }): Promise<string | null>
    saveFile(args: { defaultPath: string; filters: FileFilter[] }): Promise<string | null>
  }
  project: {
    create(args: { name: string; parentDir: string }): Promise<ProjectHandle>
    open(path: string): Promise<ProjectHandle>
    save(args: { dir: string; project: unknown }): Promise<void>
    importModel(args: { dir: string; file: string }): Promise<ImportModelResult>
    addWeapon(args: { dir: string; file: string }): Promise<AddWeaponResult>
  }
  job: {
    run(args: { dir: string; type: string; args: Record<string, unknown> }): Promise<{ jobId: string }>
    cancel(jobId: string): Promise<void>
  }
  library: {
    list(): Promise<PackInfo[]>
    /** Downloads and converts a pack; the license must have been accepted in the UI first. */
    install(args: { packId: string; acceptLicense: true }): Promise<LibraryInstallResult>
    /**
     * Converts user-supplied sources (any mix of .zip files, folders of .bvh files and .bvh files) into
     * the pack. Without `append` the pack is replaced; with it the new clips are added.
     */
    installFromFile(args: { packId: string; files: string[]; acceptLicense: true; append?: boolean }): Promise<LibraryInstallResult>
    /** Converts everything in raw/<packId>/ again (a stale pack after a converter update). */
    reconvert(packId: string): Promise<LibraryInstallResult>
    /** Converts one BVH into the `mine` pack (packId is always "mine"). `source` null (or omitted) detects it. */
    importClip(args: { file: string; source?: string | null }): Promise<{ packId: string; clipIds: string[] }>
    cancel(packId: string): Promise<void>
    remove(packId: string): Promise<void>
    /** PNG bytes, at most 512 KB; written to packs/<packId>/thumbs/<clipId>_<frame>.png. */
    saveThumb(args: { packId: string; clipId: string; frame: number; png: Uint8Array }): Promise<void>
  }
  shell: {
    showItemInFolder(path: string): Promise<void>
  }
  /** Subscribe to a main-to-renderer event. Returns an unsubscribe function. */
  on<E extends MpmEventName>(event: E, cb: (payload: MpmEventPayloads[E]) => void): () => void
}

/** Job error codes (contracts section 16). */
export const JOB_ERROR_CODES = [
  'E_BLENDER_VERSION',
  'E_ARGS',
  'E_IMPORT_FAILED',
  'E_NO_MESH',
  'E_ORIENTATION',
  'E_MARKERS_INCOMPLETE',
  'E_WEIGHTS_EMPTY',
  'E_FOLLOW_CHECK',
  'E_BUDGET',
  'E_REMESH',
  'E_EXPORT',
  'E_IO',
  'E_CANCELLED',
  'E_INTERNAL'
] as const

export type JobErrorCode = (typeof JOB_ERROR_CODES)[number]

export type JobEventKind = 'progress' | 'result' | 'error' | 'log'

/** `@@progress` payload. */
export interface JobProgressPayload {
  stage: string
  fraction: number
  message: string
}

/** `@@error` payload, also used for errors the main process detects (no result, timeout, cancel, crash). */
export interface JobErrorPayload {
  code: JobErrorCode
  message: string
  detail: Record<string, unknown>
}

/**
 * One `job:event`. Each job gets any number of `progress` / `log` events, then exactly one
 * `result` or `error` event, which is always the last event for that job.
 * `log` payloads are single lines of stdout/stderr text that are not protocol messages.
 */
export type JobEvent =
  | { jobId: string; kind: 'progress'; payload: JobProgressPayload }
  | { jobId: string; kind: 'result'; payload: unknown }
  | { jobId: string; kind: 'error'; payload: JobErrorPayload }
  | { jobId: string; kind: 'log'; payload: string }

export type MpmEventName = 'job:event' | 'blender:progress' | 'library:progress' | 'update:event' | 'app:open-project'

export interface MpmEventPayloads {
  'job:event': JobEvent
  'blender:progress': { bytes: number; total: number }
  'library:progress': { packId: string; stage: 'download' | 'convert' | 'done'; fraction: number }
  'update:event': { kind: 'available' | 'downloaded' | 'none' | 'error'; version?: string; url?: string }
  'app:open-project': { path: string }
}

declare global {
  interface Window {
    mpm: MpmApi
  }
}
