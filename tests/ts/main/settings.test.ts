// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { loadSettings, saveSettings, settingsFile, updateSettings } from '../../../electron/main/settings'
import { removeDir, tempDir } from './helpers'

describe('settings', () => {
  let dir: string
  beforeEach(() => {
    dir = tempDir('settings')
  })
  afterEach(() => removeDir(dir))

  it('lives at <dataDir>/settings.json', () => {
    expect(settingsFile(dir)).toBe(path.join(dir, 'settings.json'))
  })

  it('defaults to {} when missing or corrupt', async () => {
    expect(await loadSettings(settingsFile(dir))).toEqual({})
    writeFileSync(settingsFile(dir), '{ nope')
    expect(await loadSettings(settingsFile(dir))).toEqual({})
    writeFileSync(settingsFile(dir), JSON.stringify({ blenderPath: 42 }))
    expect(await loadSettings(settingsFile(dir))).toEqual({})
  })

  it('round-trips atomically and creates the data folder', async () => {
    const file = settingsFile(path.join(dir, 'nested', 'data'))
    await saveSettings({ blenderPath: 'C:\\B\\blender.exe' }, file)
    expect(await loadSettings(file)).toEqual({ blenderPath: 'C:\\B\\blender.exe' })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ blenderPath: 'C:\\B\\blender.exe' })
    expect(readdirSync(path.dirname(file))).toEqual(['settings.json'])
  })

  it('updateSettings merges and removes keys', async () => {
    const file = settingsFile(dir)
    expect(await updateSettings({ blenderPath: '/opt/blender' }, file)).toEqual({ blenderPath: '/opt/blender' })
    expect(await updateSettings({ blenderPath: undefined }, file)).toEqual({})
    expect(await loadSettings(file)).toEqual({})
  })
})
