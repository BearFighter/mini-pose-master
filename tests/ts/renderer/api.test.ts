// SPDX-License-Identifier: GPL-3.0-or-later
// runJob event plumbing (src/renderer/api.ts) against a fake window.mpm.
import { beforeEach, describe, expect, it } from 'vitest'
import { api, cleanError, JobError, parseIpcError, runJob, setJobProjectDir } from '../../../src/renderer/api'
import type { JobProgressPayload } from '../../../src/shared/ipc'
import { FakeMpm, installFakeMpm } from './fakeMpm'

let fake: FakeMpm

beforeEach(() => {
  fake = installFakeMpm()
  setJobProjectDir('C:/projects/Hero')
})

describe('runJob', () => {
  it('resolves with the result of its own job and forwards progress', async () => {
    fake.script('import', {
      events: [
        { kind: 'progress', payload: { stage: 'import', fraction: 0.1, message: 'importing' } },
        { kind: 'log', payload: 'Blender says hi' },
        { kind: 'progress', payload: { stage: 'save', fraction: 0.9, message: 'saving' } },
        { kind: 'result', payload: { tri_count: 12 } }
      ]
    })
    const progress: JobProgressPayload[] = []
    let started: string | null = null
    const result = await runJob<{ tri_count: number }>('import', { file: 'source/a.fbx' }, (p) => progress.push(p), {
      onStart: (id) => (started = id)
    })
    expect(result).toEqual({ tri_count: 12 })
    expect(progress.map((p) => p.stage)).toEqual(['import', 'save'])
    expect(started).toBe('job-1')
    expect(fake.runs).toEqual([{ dir: 'C:/projects/Hero', type: 'import', args: { file: 'source/a.fbx' } }])
  })

  it('ignores events of other jobs', async () => {
    fake.script('rig', { events: [{ kind: 'result', payload: 'mine' }] })
    const p = runJob('rig', {})
    fake.emit('job:event', { jobId: 'someone-else', kind: 'result', payload: 'theirs' })
    expect(await p).toBe('mine')
  })

  it('keeps events that arrive before job.run has returned the id', async () => {
    fake.script('suggest_markers', {
      early: true,
      events: [
        { kind: 'progress', payload: { stage: 'open', fraction: 0.05, message: 'opening' } },
        { kind: 'result', payload: { markers: {} } }
      ]
    })
    const progress: string[] = []
    const result = await runJob('suggest_markers', {}, (p) => progress.push(p.stage))
    expect(result).toEqual({ markers: {} })
    expect(progress).toEqual(['open'])
  })

  it('rejects with the job error code, message and detail', async () => {
    fake.script('rig', {
      events: [{ kind: 'error', payload: { code: 'E_FOLLOW_CHECK', message: 'the mesh did not follow the skeleton', detail: { grow: 3 } } }]
    })
    const err = await runJob('rig', {}).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(JobError)
    expect((err as JobError).code).toBe('E_FOLLOW_CHECK')
    expect((err as JobError).message).toBe('the mesh did not follow the skeleton')
    expect((err as JobError).detail).toEqual({ grow: 3 })
  })

  it('rejects with E_ARGS and a clean message when job.run fails', async () => {
    fake.runError = 'dir is not the open project'
    const err = await runJob('import', {}).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(JobError)
    expect((err as JobError).code).toBe('E_ARGS')
    expect((err as JobError).message).toBe('dir is not the open project')
    expect(fake.listenerCount('job:event')).toBe(0)
  })

  it('rejects without a project', async () => {
    setJobProjectDir(null)
    const err = await runJob('import', {}).catch((e: unknown) => e)
    expect((err as JobError).code).toBe('E_ARGS')
  })

  it('unsubscribes once the job has ended', async () => {
    fake.script('import', { events: [{ kind: 'result', payload: 1 }] })
    await runJob('import', {})
    fake.script('rig', { events: [{ kind: 'error', payload: { code: 'E_CANCELLED', message: 'cancelled', detail: {} } }] })
    await runJob('rig', {}).catch(() => {})
    expect(fake.listenerCount('job:event')).toBe(0)
  })

  it('ignores events after the terminal one', async () => {
    fake.script('import', {
      events: [
        { kind: 'result', payload: 'first' },
        { kind: 'error', payload: { code: 'E_INTERNAL', message: 'late', detail: {} } }
      ]
    })
    expect(await runJob('import', {})).toBe('first')
  })
})

describe('api wrappers', () => {
  it('strips the Electron IPC prefix from errors', async () => {
    await api.project.create('Hero', 'C:/p')
    await expect(api.project.create('Hero', 'C:/p')).rejects.toThrow(/^"Hero" already exists$/)
    expect(cleanError(new Error("Error invoking remote method 'mpm:blender.setPath': Error: No file at C:\\x"))).toBe('No file at C:\\x')
    expect(cleanError('plain text')).toBe('plain text')
  })
})

describe('section 17 error codes', () => {
  it('reads "<CODE>: message" behind the Electron prefix', () => {
    expect(parseIpcError(new Error("Error invoking remote method 'mpm:project.save': Error: E_ARGS: dir is not the open project"))).toEqual({
      code: 'E_ARGS',
      message: 'dir is not the open project'
    })
    expect(parseIpcError(new Error("Error invoking remote method 'mpm:library.install': Error: E_IO: not enough free disk space"))).toEqual({
      code: 'E_IO',
      message: 'not enough free disk space'
    })
    expect(parseIpcError(new Error('E_NOT_A_CODE: x'))).toEqual({ code: null, message: 'E_NOT_A_CODE: x' })
    expect(cleanError(new Error("Error invoking remote method 'mpm:x': Error: E_CANCELLED: bandai1: cancelled"))).toBe('bandai1: cancelled')
  })

  it('wrapped calls reject with a JobError carrying the code', async () => {
    fake.api.library.remove = async () => {
      throw new Error("Error invoking remote method 'mpm:library.remove': Error: E_ARGS: bandai1 is busy")
    }
    const err = await api.library.remove('bandai1').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(JobError)
    expect((err as JobError).code).toBe('E_ARGS')
    expect((err as JobError).message).toBe('bandai1 is busy')
  })

  it('a refused job.run keeps its code', async () => {
    fake.runError = 'E_BLENDER_VERSION: Blender 5.2 was not found'
    const err = await runJob('import', {}).catch((e: unknown) => e)
    expect((err as JobError).code).toBe('E_BLENDER_VERSION')
    expect((err as JobError).message).toBe('Blender 5.2 was not found')
  })
})
