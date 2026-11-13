// SPDX-License-Identifier: GPL-3.0-or-later
import { app, BrowserWindow, protocol } from 'electron'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { registerIpc } from './ipc'
import { handleMpmRequest } from './mpmProtocol'
import { initUpdater, scheduleStartupCheck } from './updater'

// Must run before app.ready.
protocol.registerSchemesAsPrivileged([
  { scheme: 'mpm', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])

const PROJECT_EXT = '.mposer'
let mainWindow: BrowserWindow | null = null
// Project path received before the window could take it (startup argv, macOS open-file, or during load).
let pendingOpenPath: string | null = null

function projectPathFrom(argv: string[]): string | null {
  return argv.find((arg) => arg.toLowerCase().endsWith(PROJECT_EXT)) ?? null
}

/**
 * Windows/Linux first launch: the first existing .mposer in argv.
 * argv[0] is skipped; argv[1] is skipped when it is "." or the app path (dev launch).
 */
function startupProjectPath(): string | null {
  const args = process.argv.slice(1)
  const appPath = resolve(app.getAppPath())
  return (
    args.find((arg, i) => {
      if (i === 0 && (arg === '.' || resolve(arg) === appPath)) return false
      return arg.toLowerCase().endsWith(PROJECT_EXT) && existsSync(arg)
    }) ?? null
  )
}

/** The one send helper for app:open-project. Only call when the window has finished loading. */
function sendOpenProject(path: string): void {
  mainWindow?.webContents.send('app:open-project', { path })
}

function requestOpenProject(path: string): void {
  if (!mainWindow || mainWindow.webContents.isLoading()) {
    pendingOpenPath = path
    return
  }
  sendOpenProject(path)
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: join(__dirname, '../preload/index.js')
    }
  })

  mainWindow.webContents.on('did-finish-load', () => {
    if (pendingOpenPath) {
      const path = pendingOpenPath
      pendingOpenPath = null
      sendOpenProject(path)
    }
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    void mainWindow.loadURL(devUrl)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function start(): void {
  app.on('second-instance', (_event, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
    const path = projectPathFrom(argv)
    if (path) requestOpenProject(path)
  })

  // macOS delivers double-clicked files this way, possibly before ready.
  app.on('open-file', (event, path) => {
    event.preventDefault()
    if (path.toLowerCase().endsWith(PROJECT_EXT)) requestOpenProject(path)
  })

  app.whenReady().then(() => {
    protocol.handle('mpm', handleMpmRequest)
    registerIpc()
    initUpdater((event) => mainWindow?.webContents.send('update:event', event))

    if (process.platform !== 'darwin') {
      const startupPath = startupProjectPath()
      if (startupPath) pendingOpenPath = startupPath
    }

    createWindow()
    mainWindow?.webContents.once('did-finish-load', scheduleStartupCheck)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}

if (app.requestSingleInstanceLock()) {
  start()
} else {
  app.quit()
}
