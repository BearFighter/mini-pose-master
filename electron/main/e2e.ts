// SPDX-License-Identifier: GPL-3.0-or-later
// End-to-end test hooks (tests/e2e/drive.mjs). Everything here is inert unless MPM_E2E=1.
import path from 'node:path'

export interface E2eOptions {
  enabled: boolean
  /** `--user-data-dir=<dir>` (or `--user-data-dir <dir>`): temp settings, data and Chromium profile. */
  userDataDir: string | null
  /** env MPM_BLENDER: the Blender executable to use. */
  blender: string | null
}

/** Reads the hooks from argv / env. With MPM_E2E unset every option is off. */
export function e2eOptions(argv: readonly string[], env: NodeJS.ProcessEnv): E2eOptions {
  if (env.MPM_E2E !== '1') return { enabled: false, userDataDir: null, blender: null }
  let userDataDir: string | null = null
  argv.forEach((arg, i) => {
    if (arg.startsWith('--user-data-dir=')) userDataDir = arg.slice('--user-data-dir='.length)
    else if (arg === '--user-data-dir' && argv[i + 1] && !argv[i + 1].startsWith('--')) userDataDir = argv[i + 1]
  })
  const dir = userDataDir as string | null
  return {
    enabled: true,
    userDataDir: dir ? path.resolve(dir.replace(/^"(.*)"$/, '$1')) : null,
    blender: env.MPM_BLENDER ? env.MPM_BLENDER : null
  }
}
