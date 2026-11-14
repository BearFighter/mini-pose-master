// SPDX-License-Identifier: GPL-3.0-or-later
// IPC handlers for every channel in contracts section 17. Channel names: 'mpm:<area>.<method>'.
import { app, BrowserWindow, dialog, ipcMain as electronIpcMain, net, shell, type IpcMainInvokeEvent } from 'electron'
import path from 'node:path'
import type { FileFilter, MpmEventName, MpmEventPayloads } from '../../src/shared/ipc'
import { BlenderManager } from './blender'
import { engineDir, resourcesDir } from './engineDir'
import { codedMessage, MpmError } from './errors'
import { samePath } from './fsutil'
import { JobRunner, pruneJobFiles } from './jobs'
import { Library } from './library'
import { setProjectRoot } from './mpmProtocol'
import { loadPacks } from './packs'
import { dataDir, libraryDir } from './paths'
import * as projects from './projects'
import { draftMarkersFile, writeMarkersFile } from './rigDraft'
import { settingsFile } from './settings'
import { checkUpdate, installUpdate } from './updater'

/**
 * Every handler goes through this: an invoke rejection always carries "<CODE>: message" with a
 * section 16 error code (contracts section 17). Uncoded errors become E_IO (system errors) or
 * E_INTERNAL.
 */
const ipcMain = {
  handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown): void {
    electronIpcMain.handle(channel, async (event, ...args) => {
      try {
        return await listener(event, ...args)
      } catch (e) {
        throw new Error(codedMessage(e))
      }
    })
  }
}

let blender: BlenderManager | null = null
let runner: JobRunner | null = null
let download: AbortController | null = null
let library: Library | null = null
let libraryLoading: Promise<Library> | null = null
/** The project folder last created or opened; project.* writes and jobs are limited to it. */
let openProjectDir: string | null = null

function windowOf(event: IpcMainInvokeEvent): BrowserWindow | undefined {
  return BrowserWindow.fromWebContents(event.sender) ?? undefined
}

function broadcast<E extends MpmEventName>(event: E, payload: MpmEventPayloads[E]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(event, payload)
  }
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value === '') throw new MpmError('E_ARGS', `${name} must be a non-empty string`)
  return value
}

function requireObject(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MpmError('E_ARGS', `${name} must be an object`)
  return value as Record<string, unknown>
}

/** The open project's folder; rejects any other folder so the renderer can't write elsewhere. */
function requireOpenProject(dir: unknown): string {
  const wanted = requireString(dir, 'dir')
  if (!openProjectDir || !samePath(wanted, openProjectDir)) throw new MpmError('E_ARGS', 'dir is not the open project')
  return openProjectDir
}

function setOpenProject(dir: string): void {
  openProjectDir = dir
  setProjectRoot(dir)
}

function blenderManager(): BlenderManager {
  blender ??= new BlenderManager({ dataDir: dataDir() })
  return blender
}

function jobRunner(): JobRunner {
  runner ??= new JobRunner({
    engineDir: engineDir(),
    resolveBlender: () => blenderManager().requirePath(),
    emit: (event) => {
      broadcast('job:event', event)
      library?.onJobEvent(event)
    }
  })
  return runner
}

/** The pose library, created on first use (reads and validates resources/packs.json). */
function poseLibrary(): Promise<Library> {
  libraryLoading ??= loadPacks(path.join(resourcesDir(), 'packs.json')).then((packs) => {
    library = new Library({
      root: libraryDir(),
      packs,
      runner: jobRunner(),
      settingsFile: settingsFile(dataDir()),
      fetch: (url, init) => net.fetch(url, init),
      onProgress: (progress) => broadcast('library:progress', progress)
    })
    return library
  })
  return libraryLoading
}

export function registerIpc(): void {
  // Job files of library jobs that failed are kept for a while; drop the old ones at start.
  void pruneJobFiles(path.join(libraryDir(), 'cache', 'jobs')).catch(() => {})

  ipcMain.handle('mpm:app.info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    dataDir: dataDir()
  }))
  ipcMain.handle('mpm:app.checkUpdate', () => checkUpdate())
  ipcMain.handle('mpm:app.installUpdate', () => installUpdate())

  // --- blender.*
  ipcMain.handle('mpm:blender.status', () => blenderManager().status())
  ipcMain.handle('mpm:blender.setPath', (_event, path: unknown) => {
    if (typeof path !== 'string') throw new MpmError('E_ARGS', 'path must be a string')
    return blenderManager().setPath(path)
  })
  ipcMain.handle('mpm:blender.download', async () => {
    if (download) throw new MpmError('E_ARGS', 'A Blender download is already running')
    const controller = new AbortController()
    download = controller
    try {
      return await blenderManager().download((progress) => broadcast('blender:progress', progress), controller.signal)
    } finally {
      if (download === controller) download = null
    }
  })
  ipcMain.handle('mpm:blender.cancelDownload', () => {
    download?.abort()
  })

  // --- dialog.*
  ipcMain.handle('mpm:dialog.openFile', async (event, args: { filters: FileFilter[] }) => {
    const options = { properties: ['openFile' as const], filters: args.filters }
    const win = windowOf(event)
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  ipcMain.handle('mpm:dialog.openFiles', async (event, args: { filters: FileFilter[]; folders?: boolean }) => {
    const properties: Array<'openFile' | 'openDirectory' | 'multiSelections'> = [
      args?.folders ? 'openDirectory' : 'openFile',
      'multiSelections'
    ]
    const options = { properties, filters: args?.folders ? undefined : args?.filters }
    const win = windowOf(event)
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    return result.canceled ? [] : result.filePaths
  })

  ipcMain.handle('mpm:dialog.openFolder', async (event, args: { title?: string } | undefined) => {
    const options = { properties: ['openDirectory' as const, 'createDirectory' as const], title: args?.title }
    const win = windowOf(event)
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  ipcMain.handle(
    'mpm:dialog.saveFile',
    async (event, args: { defaultPath: string; filters: FileFilter[] }) => {
      const options = { defaultPath: args.defaultPath, filters: args.filters }
      const win = windowOf(event)
      const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
      return result.canceled || !result.filePath ? null : result.filePath
    }
  )

  // --- project.*
  ipcMain.handle('mpm:project.create', async (_event, args: unknown) => {
    const { name, parentDir } = requireObject(args, 'args')
    const handle = await projects.create(
      { name: requireString(name, 'name'), parentDir: requireString(parentDir, 'parentDir') },
      app.getVersion()
    )
    setOpenProject(handle.dir)
    return handle
  })
  ipcMain.handle('mpm:project.open', async (_event, target: unknown) => {
    const handle = await projects.open(requireString(target, 'path'))
    setOpenProject(handle.dir)
    void pruneJobFiles(path.join(handle.dir, 'cache', 'jobs')).catch(() => {})
    return handle
  })
  ipcMain.handle('mpm:project.save', async (_event, args: unknown) => {
    const { dir, project } = requireObject(args, 'args')
    const projectDir = requireOpenProject(dir)
    // Edited auto-rig markers (project.rigDraft.markers) also go to rig/markers.json (WP8b).
    const markers = draftMarkersFile(project)
    await projects.save({ dir: projectDir, project })
    if (markers) await writeMarkersFile(projectDir, markers)
  })
  ipcMain.handle('mpm:project.importModel', (_event, args: unknown) => {
    const { dir, file } = requireObject(args, 'args')
    return projects.importModel({ dir: requireOpenProject(dir), file: requireString(file, 'file') })
  })
  ipcMain.handle('mpm:project.addWeapon', (_event, args: unknown) => {
    const { dir, file } = requireObject(args, 'args')
    return projects.addWeapon({ dir: requireOpenProject(dir), file: requireString(file, 'file') })
  })

  // --- job.*
  ipcMain.handle('mpm:job.run', (_event, args: unknown) => {
    const { dir, type, args: jobArgs } = requireObject(args, 'args')
    const jobId = jobRunner().run({
      dir: requireOpenProject(dir),
      type: requireString(type, 'type'),
      args: requireObject(jobArgs ?? {}, 'args.args')
    })
    return { jobId }
  })
  ipcMain.handle('mpm:job.cancel', (_event, jobId: unknown) => {
    jobRunner().cancel(requireString(jobId, 'jobId'))
  })

  ipcMain.handle('mpm:shell.showItemInFolder', (_event, path: string) => {
    shell.showItemInFolder(path)
  })

  // --- library.* (arguments are validated with zod inside Library)
  ipcMain.handle('mpm:library.list', async () => (await poseLibrary()).list())
  ipcMain.handle('mpm:library.install', async (_event, args: unknown) => (await poseLibrary()).install(args))
  ipcMain.handle('mpm:library.installFromFile', async (_event, args: unknown) => (await poseLibrary()).installFromFile(args))
  ipcMain.handle('mpm:library.reconvert', async (_event, packId: unknown) => (await poseLibrary()).reconvert(packId))
  ipcMain.handle('mpm:library.importClip', async (_event, args: unknown) => (await poseLibrary()).importClip(args))
  ipcMain.handle('mpm:library.cancel', async (_event, packId: unknown) => (await poseLibrary()).cancel(packId))
  ipcMain.handle('mpm:library.remove', async (_event, packId: unknown) => (await poseLibrary()).remove(packId))
  ipcMain.handle('mpm:library.saveThumb', async (_event, args: unknown) => (await poseLibrary()).saveThumb(args))
}

/** True while a job runs or waits, or a Blender or pose-pack download is in progress. */
export function hasBackgroundWork(): boolean {
  return (
    download !== null ||
    (library?.isBusy() ?? false) ||
    (runner !== null && (runner.activeJobId !== null || runner.queuedJobIds.length > 0))
  )
}

/** Stops the downloads and every job (killing Blender). Resolves once the running job has ended. */
export async function shutdownIpc(): Promise<void> {
  download?.abort()
  await library?.shutdown()
  await runner?.shutdown()
}
