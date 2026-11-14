// SPDX-License-Identifier: GPL-3.0-or-later
// project.save writes rig/markers.json from rigDraft.markers (electron/main/rigDraft.ts), and the
// MPM_E2E option parsing (electron/main/e2e.ts).
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { e2eOptions } from '../../../electron/main/e2e'
import { draftMarkersFile, writeMarkersFile } from '../../../electron/main/rigDraft'
import { removeDir, tempDir } from './helpers'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) removeDir(d)
})

const good = {
  schemaVersion: 1,
  rigDraft: {
    markers: {
      pelvis: { p: [0, 0.01, 0.95], confidence: 0.9, source: 'auto' },
      shoulder_L: { p: [0.2, 0, 1.45], confidence: 0.4, source: 'user', extra: 'dropped' }
    }
  }
}

describe('draftMarkersFile', () => {
  it('builds the markers file from rigDraft.markers', () => {
    expect(draftMarkersFile(good)).toEqual({
      schema: 'mpm.markers/1',
      markers: {
        pelvis: { p: [0, 0.01, 0.95], confidence: 0.9, source: 'auto' },
        shoulder_L: { p: [0.2, 0, 1.45], confidence: 0.4, source: 'user' }
      }
    })
  })

  it('is null without draft markers', () => {
    expect(draftMarkersFile({ schemaVersion: 1 })).toBeNull()
    expect(draftMarkersFile({ schemaVersion: 1, rigDraft: { markers: null } })).toBeNull()
    expect(draftMarkersFile(null)).toBeNull()
  })

  it('refuses malformed markers', () => {
    const bad = (markers: unknown) => () => draftMarkersFile({ rigDraft: { markers } })
    expect(bad({ pelvis: { p: [0, 0], confidence: 1, source: 'auto' } })).toThrow(/pelvis: p must be 3 finite numbers/)
    expect(bad({ pelvis: { p: [0, 0, NaN], confidence: 1, source: 'auto' } })).toThrow(/finite/)
    expect(bad({ pelvis: { p: [0, 0, 0], confidence: 2, source: 'auto' } })).toThrow(/confidence/)
    expect(bad({ pelvis: { p: [0, 0, 0], confidence: 1, source: 'robot' } })).toThrow(/source/)
    expect(bad({ '../x': { p: [0, 0, 0], confidence: 1, source: 'auto' } })).toThrow(/invalid joint name/)
    expect(bad([1, 2])).toThrow(/must be an object/)
    expect(() => draftMarkersFile({ rigDraft: 5 })).toThrow(/rigDraft must be an object/)
  })
})

describe('writeMarkersFile', () => {
  it('writes <project>/rig/markers.json', async () => {
    const dir = tempDir('rigdraft')
    dirs.push(dir)
    await writeMarkersFile(dir, draftMarkersFile(good)!)
    const file = path.join(dir, 'rig', 'markers.json')
    expect(existsSync(file)).toBe(true)
    const json = JSON.parse(readFileSync(file, 'utf8'))
    expect(json.schema).toBe('mpm.markers/1')
    expect(Object.keys(json.markers)).toEqual(['pelvis', 'shoulder_L'])
  })
})

describe('e2eOptions', () => {
  it('is off unless MPM_E2E=1', () => {
    expect(e2eOptions(['electron', '.', '--user-data-dir=C:/tmp/u'], { MPM_BLENDER: 'C:/b.exe' })).toEqual({
      enabled: false,
      userDataDir: null,
      blender: null
    })
  })

  it('reads --user-data-dir (both spellings) and MPM_BLENDER', () => {
    const a = e2eOptions(['electron', '.', '--user-data-dir=C:/tmp/u'], { MPM_E2E: '1', MPM_BLENDER: 'C:/b.exe' })
    expect(a).toEqual({ enabled: true, userDataDir: path.resolve('C:/tmp/u'), blender: 'C:/b.exe' })
    const b = e2eOptions(['electron', '.', '--user-data-dir', '/tmp/v'], { MPM_E2E: '1' })
    expect(b).toEqual({ enabled: true, userDataDir: path.resolve('/tmp/v'), blender: null })
    expect(e2eOptions(['electron', '.'], { MPM_E2E: '1' }).userDataDir).toBeNull()
  })
})
