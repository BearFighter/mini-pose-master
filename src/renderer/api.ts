// SPDX-License-Identifier: GPL-3.0-or-later
// The only module that touches window.mpm (contracts section 18). Typed wrappers with readable
// errors, plus runJob, which turns a job's `job:event` stream into a promise.
import type {
  AppInfo,
  BlenderStatus,
  FileFilter,
  JobErrorCode,
  JobEvent,
  JobProgressPayload,
  MpmApi,
  MpmEventName,
  MpmEventPayloads,
  UpdateCheckResult
} from '../shared/ipc'
import type { ProjectData } from '../shared/project'

function mpm(): MpmApi {
  const w = (globalThis as { window?: { mpm?: MpmApi } }).window
  if (!w?.mpm) throw new Error('The Mini Pose Master API (window.mpm) is not available')
  return w.mpm
}

/** Removes Electron's "Error invoking remote method '<channel>': Error: " prefix. */
export function cleanError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  return raw.replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^(?:[A-Za-z]*Error):\s*/, '')
}

async function call<T>(fn: (m: MpmApi) => Promise<T>): Promise<T> {
  try {
    return await fn(mpm())
  } catch (e) {
    throw new Error(cleanError(e))
  }
}

export interface ProjectHandle {
  dir: string
  project: ProjectData
}

export interface ImportModelResult {
  copied: string[]
  skipped: string[]
  project: ProjectData
}

function asProject(raw: unknown): ProjectData {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('The project file does not contain a project')
  return raw as ProjectData
}

function asHandle(raw: { dir: string; project: unknown }): ProjectHandle {
  return { dir: raw.dir, project: asProject(raw.project) }
}

export const api = {
  app: {
    info: (): Promise<AppInfo> => call((m) => m.app.info()),
    checkUpdate: (): Promise<UpdateCheckResult> => call((m) => m.app.checkUpdate())
  },
  blender: {
    status: (): Promise<BlenderStatus> => call((m) => m.blender.status()),
    setPath: (path: string): Promise<BlenderStatus> => call((m) => m.blender.setPath(path)),
    download: (): Promise<BlenderStatus> => call((m) => m.blender.download()),
    cancelDownload: (): Promise<void> => call((m) => m.blender.cancelDownload())
  },
  dialog: {
    openFile: (filters: FileFilter[]): Promise<string | null> => call((m) => m.dialog.openFile({ filters })),
    openFiles: (filters: FileFilter[], folders = false): Promise<string[]> =>
      call((m) => m.dialog.openFiles({ filters, folders })),
    openFolder: (title?: string): Promise<string | null> => call((m) => m.dialog.openFolder({ title })),
    saveFile: (defaultPath: string, filters: FileFilter[]): Promise<string | null> =>
      call((m) => m.dialog.saveFile({ defaultPath, filters }))
  },
  project: {
    create: (name: string, parentDir: string): Promise<ProjectHandle> =>
      call((m) => m.project.create({ name, parentDir })).then(asHandle),
    open: (path: string): Promise<ProjectHandle> => call((m) => m.project.open(path)).then(asHandle),
    save: (dir: string, project: ProjectData): Promise<void> => call((m) => m.project.save({ dir, project })),
    importModel: (dir: string, file: string): Promise<ImportModelResult> =>
      call((m) => m.project.importModel({ dir, file })).then((r) => ({
        copied: r.copied,
        skipped: r.skipped,
        project: asProject(r.project)
      }))
  },
  job: {
    cancel: (jobId: string): Promise<void> => call((m) => m.job.cancel(jobId))
  },
  shell: {
    showItemInFolder: (path: string): Promise<void> => call((m) => m.shell.showItemInFolder(path))
  },
  on<E extends MpmEventName>(event: E, cb: (payload: MpmEventPayloads[E]) => void): () => void {
    return mpm().on(event, cb)
  }
}

// ---------------------------------------------------------------------------------------------------
// Jobs

/** A job that ended with `@@error` (or failed to start). */
export class JobError extends Error {
  constructor(
    readonly code: JobErrorCode,
    message: string,
    readonly detail: Record<string, unknown> = {}
  ) {
    super(message)
    this.name = 'JobError'
  }
}

let jobDir: string | null = null

/** The project folder jobs run in; set when a project is created or opened. */
export function setJobProjectDir(dir: string | null): void {
  jobDir = dir
}

export interface RunJobHooks {
  /** Called once the main process has accepted the job (the id is needed to cancel it). */
  onStart?: (jobId: string) => void
}

/**
 * Runs an engine job in the open project and resolves with its `@@result` payload, or rejects with
 * a JobError carrying the `@@error` code and message. Events that arrive before job.run has
 * returned the id are buffered and replayed, so none is lost.
 */
export function runJob<T = unknown>(
  type: string,
  args: Record<string, unknown>,
  onProgress?: (progress: JobProgressPayload) => void,
  hooks: RunJobHooks = {}
): Promise<T> {
  const dir = jobDir
  if (!dir) return Promise.reject(new JobError('E_ARGS', 'No project is open'))
  return new Promise<T>((resolve, reject) => {
    let jobId: string | null = null
    let done = false
    const early: JobEvent[] = []
    let off: () => void = () => {}

    const finish = () => {
      done = true
      off()
    }
    const handle = (event: JobEvent) => {
      if (done) return
      switch (event.kind) {
        case 'progress':
          onProgress?.(event.payload)
          break
        case 'result':
          finish()
          resolve(event.payload as T)
          break
        case 'error':
          finish()
          reject(new JobError(event.payload.code, event.payload.message, event.payload.detail ?? {}))
          break
        default:
          break
      }
    }

    let m: MpmApi
    try {
      m = mpm()
    } catch (e) {
      reject(new JobError('E_INTERNAL', cleanError(e)))
      return
    }
    off = m.on('job:event', (event) => {
      if (done) return
      if (jobId === null) early.push(event)
      else if (event.jobId === jobId) handle(event)
    })
    m.job.run({ dir, type, args }).then(
      (started) => {
        if (done) return
        jobId = started.jobId
        hooks.onStart?.(jobId)
        for (const event of early.splice(0)) if (event.jobId === jobId) handle(event)
      },
      (e: unknown) => {
        finish()
        reject(new JobError('E_ARGS', cleanError(e)))
      }
    )
  })
}
