// SPDX-License-Identifier: GPL-3.0-or-later
// IPC handlers for every channel in contracts section 17. Channel names: 'mpm:<area>.<method>'.
import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import type { FileFilter } from '../../src/shared/ipc'
import { dataDir } from './paths'
import { checkUpdate, installUpdate } from './updater'

const NOT_IMPLEMENTED_CHANNELS = [
  'blender.status',
  'blender.setPath',
  'blender.download',
  'blender.cancelDownload',
  'project.create',
  'project.open',
  'project.save',
  'project.importModel',
  'project.addWeapon',
  'job.run',
  'job.cancel',
  'library.list',
  'library.install',
  'library.installFromFile',
  'library.importClip'
] as const

function windowOf(event: IpcMainInvokeEvent): BrowserWindow | undefined {
  return BrowserWindow.fromWebContents(event.sender) ?? undefined
}

export function registerIpc(): void {
  ipcMain.handle('mpm:app.info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    dataDir: dataDir()
  }))
  ipcMain.handle('mpm:app.checkUpdate', () => checkUpdate())
  ipcMain.handle('mpm:app.installUpdate', () => installUpdate())

  ipcMain.handle('mpm:dialog.openFile', async (event, args: { filters: FileFilter[] }) => {
    const options = { properties: ['openFile' as const], filters: args.filters }
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

  ipcMain.handle('mpm:shell.showItemInFolder', (_event, path: string) => {
    shell.showItemInFolder(path)
  })

  for (const channel of NOT_IMPLEMENTED_CHANNELS) {
    ipcMain.handle(`mpm:${channel}`, async () => {
      throw new Error(`NOT_IMPLEMENTED: ${channel}`)
    })
  }
}
