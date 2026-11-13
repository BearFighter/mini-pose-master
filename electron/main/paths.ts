// SPDX-License-Identifier: GPL-3.0-or-later
// Data directory rules: docs/contracts.md section 19.
import { homedir } from 'node:os'
import { join } from 'node:path'

export function dataDir(): string {
  switch (process.platform) {
    case 'win32': {
      const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
      return join(localAppData, 'Mini Pose Master')
    }
    case 'darwin':
      return join(homedir(), 'Library', 'Application Support', 'Mini Pose Master')
    default: {
      const xdg = process.env.XDG_DATA_HOME
      return xdg ? join(xdg, 'mini-pose-master') : join(homedir(), '.local', 'share', 'mini-pose-master')
    }
  }
}

export function libraryDir(): string {
  return join(dataDir(), 'library')
}
