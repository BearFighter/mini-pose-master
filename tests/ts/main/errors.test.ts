// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { utimesSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { BlenderManager } from '../../../electron/main/blender'
import { asMpmError, codedMessage, codeOf, MpmError } from '../../../electron/main/errors'
import { JobRunner, pruneJobFiles, JOB_FILE_MAX_AGE_MS } from '../../../electron/main/jobs'
import * as projects from '../../../electron/main/projects'
import { removeDir, tempDir } from './helpers'

describe('error convention', () => {
  it('MpmError messages start with the code', () => {
    const e = new MpmError('E_ARGS', 'bad thing', { a: 1 })
    expect(e.message).toBe('E_ARGS: bad thing')
    expect(e.code).toBe('E_ARGS')
    expect(e.detail).toEqual({ a: 1 })
    expect(codeOf(e.message)).toBe('E_ARGS')
    expect(codeOf('E_NOPE: x')).toBeNull()
    expect(codeOf('no code')).toBeNull()
  })

  it('codedMessage keeps codes, maps system errors to E_IO and the rest to E_INTERNAL', () => {
    expect(codedMessage(new MpmError('E_CANCELLED', 'stopped'))).toBe('E_CANCELLED: stopped')
    expect(codedMessage(new Error('E_BUDGET: too big'))).toBe('E_BUDGET: too big')
    const enoent = Object.assign(new Error("ENOENT: no such file or directory, open 'x'"), { code: 'ENOENT' })
    expect(codedMessage(enoent)).toBe("E_IO: ENOENT: no such file or directory, open 'x'")
    expect(codedMessage(Object.assign(new TypeError('bad'), { code: 'ERR_INVALID_ARG_TYPE' }))).toBe('E_INTERNAL: bad')
    expect(codedMessage(new Error('surprise'))).toBe('E_INTERNAL: surprise')
    expect(codedMessage('thrown string')).toBe('E_INTERNAL: thrown string')
  })

  it('asMpmError keeps or adds a code', () => {
    const coded = new MpmError('E_IO', 'disk')
    expect(asMpmError(coded, 'E_INTERNAL')).toBe(coded)
    expect(asMpmError(new Error('E_ARGS: x'), 'E_IO')).toMatchObject({ code: 'E_ARGS', message: 'E_ARGS: x' })
    expect(asMpmError(new Error('fetch failed'), 'E_IO')).toMatchObject({ code: 'E_IO', message: 'E_IO: fetch failed' })
  })

  describe('main-process modules throw coded errors', () => {
    let dir: string
    beforeEach(() => {
      dir = tempDir('errors')
    })
    afterEach(() => removeDir(dir))

    it('projects, Blender manager and job runner', async () => {
      await expect(projects.open(path.join(dir, 'missing'))).rejects.toThrow(/^E_ARGS: No project at/)
      writeFileSync(path.join(dir, 'Bad.mposer'), '{ broken')
      await expect(projects.open(path.join(dir, 'Bad.mposer'))).rejects.toThrow(/^E_IO: .*broken JSON/)
      await expect(projects.create({ name: '', parentDir: dir }, '0.0.1')).rejects.toThrow(/^E_ARGS: /)

      const blender = new BlenderManager({ dataDir: dir, probe: async () => ({ ok: false, error: 'Blender 4.5.1 found' }) })
      await expect(blender.setPath(path.join(dir, 'nope.exe'))).rejects.toThrow(/^E_ARGS: No file/)
      writeFileSync(path.join(dir, 'blender.exe'), '')
      await expect(blender.setPath(path.join(dir, 'blender.exe'))).rejects.toThrow(/^E_BLENDER_VERSION: Blender 4\.5\.1/)
      await expect(blender.setPath(path.join(dir, 'blender-launcher.exe'))).rejects.toThrow(/^E_BLENDER_VERSION: blender-launcher/)
      await expect(new BlenderManager({ dataDir: dir, platform: 'darwin', arch: 'x64' }).download(() => {}, new AbortController().signal)).rejects.toThrow(
        /^E_BLENDER_VERSION: Blender 5\.2 has no Intel Mac build/
      )

      const runner = new JobRunner({ engineDir: dir, resolveBlender: () => 'x', emit: () => {} })
      expect(() => runner.run({ dir: 'relative', type: 'x', args: {} })).toThrow(/^E_ARGS: /)
    })
  })
})

describe('pruneJobFiles', () => {
  let dir: string
  beforeEach(() => {
    dir = tempDir('prune')
  })
  afterEach(() => removeDir(dir))

  it('deletes job files older than 14 days and keeps the rest', async () => {
    const jobs = path.join(dir, 'cache', 'jobs')
    mkdirSync(path.join(jobs, 'sub'), { recursive: true })
    const now = Date.now()
    const ages: Record<string, number> = { 'old.json': 15, 'old.log': 30, 'recent.json': 13, 'new.log': 0 }
    for (const [name, days] of Object.entries(ages)) {
      const file = path.join(jobs, name)
      writeFileSync(file, 'x')
      const t = (now - days * 24 * 60 * 60 * 1000) / 1000
      utimesSync(file, t, t)
    }
    expect(JOB_FILE_MAX_AGE_MS).toBe(14 * 24 * 60 * 60 * 1000)
    expect(await pruneJobFiles(jobs, JOB_FILE_MAX_AGE_MS, now)).toBe(2)
    expect(readdirSync(jobs).sort()).toEqual(['new.log', 'recent.json', 'sub'])
    expect(await pruneJobFiles(path.join(dir, 'missing'))).toBe(0)
  })
})
