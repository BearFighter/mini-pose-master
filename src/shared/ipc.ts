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

export interface LibraryPackEntry {
  /** index.json contents (contracts section 9) plus the installed flag. */
  installed: boolean
  [key: string]: unknown
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
    saveFile(args: { defaultPath: string; filters: FileFilter[] }): Promise<string | null>
  }
  project: {
    create(args: { name: string; parentDir: string }): Promise<ProjectHandle>
    open(path: string): Promise<ProjectHandle>
    save(args: { dir: string; project: unknown }): Promise<void>
    importModel(args: { dir: string; file: string }): Promise<{ copied: string }>
    addWeapon(args: { dir: string; file: string }): Promise<{ weaponFile: string }>
  }
  job: {
    run(args: { dir: string; type: string; args: Record<string, unknown> }): Promise<{ jobId: string }>
    cancel(jobId: string): Promise<void>
  }
  library: {
    list(): Promise<LibraryPackEntry[]>
    install(packId: string): Promise<void>
    installFromFile(args: { packId: string; file: string }): Promise<void>
    importClip(args: { file: string; source: string }): Promise<{ packId: string; clipIds: string[] }>
  }
  shell: {
    showItemInFolder(path: string): Promise<void>
  }
  /** Subscribe to a main-to-renderer event. Returns an unsubscribe function. */
  on<E extends MpmEventName>(event: E, cb: (payload: MpmEventPayloads[E]) => void): () => void
}

export type MpmEventName = 'job:event' | 'blender:progress' | 'library:progress' | 'update:event' | 'app:open-project'

export interface MpmEventPayloads {
  'job:event': { jobId: string; kind: 'progress' | 'result' | 'error' | 'log'; payload: unknown }
  'blender:progress': { bytes: number; total: number }
  'library:progress': { packId: string; stage: string; fraction: number }
  'update:event': { kind: 'available' | 'downloaded' | 'none' | 'error'; version?: string; url?: string }
  'app:open-project': { path: string }
}

declare global {
  interface Window {
    mpm: MpmApi
  }
}
