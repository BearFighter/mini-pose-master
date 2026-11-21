// SPDX-License-Identifier: GPL-3.0-or-later
import { app, BrowserWindow, dialog, protocol, shell } from 'electron'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { e2eOptions } from './e2e'
import { hasBackgroundWork, registerIpc, shutdownIpc } from './ipc'
import { handleMpmRequest } from './mpmProtocol'
import { dataDir, setDataDirOverride } from './paths'
import { settingsFile, updateSettings } from './settings'
import { initUpdater, scheduleStartupCheck } from './updater'

/** Same origin and path (a reload of the app page), ignoring query and fragment. */
function sameDocument(a: string, b: string): boolean {
  try {
    const x = new URL(a)
    const y = new URL(b)
    return x.protocol === y.protocol && x.host === y.host && x.pathname === y.pathname
  } catch {
    return false
  }
}

// Must run before app.ready.
protocol.registerSchemesAsPrivileged([
  // corsEnabled: fetch() from the renderer page (another origin) needs it; see mpmProtocol.withCors.
  { scheme: 'mpm', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }
])

// End-to-end test hooks (MPM_E2E=1 only): a temp user-data / data folder, a given Blender, and the
// renderer's window.__mpmTest. Set before the single-instance lock, which is per user-data folder.
const E2E = e2eOptions(process.argv, process.env)
if (E2E.userDataDir) {
  app.setPath('userData', E2E.userDataDir)
  setDataDirOverride(E2E.userDataDir)
}
if (E2E.enabled) {
  // The test window may be covered by other windows; keep it rendering (requestAnimationFrame).
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
}

/** MPM_BLENDER goes into the temp settings only; the user's real settings are never touched. */
async function applyE2eBlender(): Promise<void> {
  if (!E2E.enabled || !E2E.blender) return
  if (!E2E.userDataDir) {
    console.warn('MPM_BLENDER is ignored without --user-data-dir')
    return
  }
  await updateSettings({ blenderPath: E2E.blender }, settingsFile(dataDir()))
}

const PROJECT_EXT = '.mposer'
/** Longest wait for running Blender jobs to be killed before the app quits anyway. */
const SHUTDOWN_TIMEOUT_MS = 10_000
let mainWindow: BrowserWindow | null = null
let shuttingDown = false
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
    // Test runs stay off the user's screen and never take focus; MPM_E2E_SHOW=1 shows the window.
    show: !(E2E.enabled && process.env.MPM_E2E_SHOW !== '1'),
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: join(__dirname, '../preload/index.js'),
      ...(E2E.enabled ? { backgroundThrottling: false } : {})
    }
  })

  // Never leave the app page or open windows (contracts section 17): mpm:// answers any origin, so no
  // foreign page may ever load here. https links (license pages) open in the system browser.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!sameDocument(url, mainWindow?.webContents.getURL() ?? '')) event.preventDefault()
  })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
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
  // The renderer's beforeunload handler blocks closing while the project has unsaved changes;
  // ask the user whether to close anyway.
  mainWindow.webContents.on('will-prevent-unload', (event) => {
    const win = mainWindow
    if (!win) return
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Close without saving', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Unsaved changes',
      message: 'The project has unsaved changes.',
      detail: 'Close anyway? The changes since the last save will be lost.'
    })
    if (choice === 0) event.preventDefault()
  })

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    void mainWindow.loadURL(E2E.enabled ? `${devUrl}${devUrl.includes('?') ? '&' : '?'}e2e=1` : devUrl)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'), E2E.enabled ? { query: { e2e: '1' } } : undefined)
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

  app.whenReady().then(async () => {
    await applyE2eBlender().catch((e: unknown) => console.error('MPM_BLENDER:', e))
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

  // Don't leave Blender jobs or a half-finished download behind: stop them, then quit.
  app.on('before-quit', (event) => {
    if (shuttingDown || !hasBackgroundWork()) return
    event.preventDefault()
    shuttingDown = true
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS))
    void Promise.race([shutdownIpc().catch(() => {}), timeout]).then(() => app.quit())
  })
}

if (app.requestSingleInstanceLock()) {
  start()
} else {
  app.quit()
}
