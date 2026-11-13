// SPDX-License-Identifier: GPL-3.0-or-later
// Auto-update skeleton: electron-updater, events forwarded as update:event.
import { app, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateCheckResult } from '../../src/shared/ipc'

export interface UpdateEvent {
  kind: 'available' | 'downloaded' | 'none' | 'error'
  version?: string
  url?: string
}

const RELEASES_URL = 'https://github.com/BearFighter/mini-pose-master/releases'
const STARTUP_CHECK_DELAY_MS = 10_000

let sendEvent: (event: UpdateEvent) => void = () => {}
let lastReleaseUrl: string = RELEASES_URL

function canCheck(): boolean {
  if (!app.isPackaged) return false
  if (process.platform === 'linux') return Boolean(process.env.APPIMAGE)
  return true
}

function releaseUrl(version: string): string {
  return `https://github.com/BearFighter/mini-pose-master/releases/tag/v${version}`
}

/** Wires autoUpdater events to the given sender. Call once after app ready. */
export function initUpdater(send: (event: UpdateEvent) => void): void {
  sendEvent = send
  autoUpdater.autoDownload = process.platform !== 'darwin'
  autoUpdater.on('update-available', (info) =>
    sendEvent({ kind: 'available', version: info.version, url: releaseUrl(info.version) })
  )
  autoUpdater.on('update-downloaded', (info) => sendEvent({ kind: 'downloaded', version: info.version }))
  autoUpdater.on('update-not-available', () => sendEvent({ kind: 'none' }))
  autoUpdater.on('error', () => sendEvent({ kind: 'error' }))
}

/** Automatic check, 10 s after the window is ready. Only runs when the app is packaged. */
export function scheduleStartupCheck(): void {
  if (!app.isPackaged) return
  setTimeout(() => {
    checkUpdate().catch(() => sendEvent({ kind: 'error' }))
  }, STARTUP_CHECK_DELAY_MS)
}

export async function checkUpdate(): Promise<UpdateCheckResult> {
  if (!canCheck()) return { available: false }
  const result = await autoUpdater.checkForUpdates()
  if (!result || !result.isUpdateAvailable) return { available: false }
  const version = result.updateInfo.version
  const notes = typeof result.updateInfo.releaseNotes === 'string' ? result.updateInfo.releaseNotes : undefined
  const url = releaseUrl(version)
  lastReleaseUrl = url
  return { available: true, version, notes, url }
}

export async function installUpdate(): Promise<void> {
  if (process.platform === 'darwin') {
    await shell.openExternal(lastReleaseUrl)
    return
  }
  autoUpdater.quitAndInstall()
}
