// SPDX-License-Identifier: GPL-3.0-or-later
// Locations of the bundled engine/ and resources/ folders: the repo in dev, process.resourcesPath
// when packaged (electron-builder extraResources).
import { app } from 'electron'
import path from 'node:path'

export interface AppLocation {
  isPackaged: boolean
  appPath: string
  resourcesPath: string
}

/** Pure form, for tests: `<base>/<name>` where base is resourcesPath when packaged, else the app path. */
export function bundledDir(name: 'engine' | 'resources', where: AppLocation): string {
  return path.join(where.isPackaged ? where.resourcesPath : where.appPath, name)
}

function here(): AppLocation {
  return { isPackaged: app.isPackaged, appPath: app.getAppPath(), resourcesPath: process.resourcesPath }
}

/** Absolute engine folder (contains `jobs/` and `mpm/`). */
export function engineDir(): string {
  return bundledDir('engine', here())
}

/** Absolute resources folder (skeleton.json, hand_presets.json, packs.json, icons). */
export function resourcesDir(): string {
  return bundledDir('resources', here())
}
