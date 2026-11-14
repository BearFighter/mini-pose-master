// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { JobEvent } from '../../../src/shared/ipc'
import { blenderArgs, cleanEnv, JobRunner, parseLine, type JobRunnerOptions } from '../../../electron/main/jobs'
import { EventLog, FIXTURES, removeDir, tempDir, waitGone } from './helpers'

const FAKE_JOB = path.join(FIXTURES, 'fake_job.js')
const PROCESS_TEST_MS = 30_000

describe('parseLine', () => {
  it('parses @@progress', () => {
    expect(parseLine('@@progress {"stage":"remesh","fraction":0.4,"message":"voxel remeshing"}')).toEqual({
      kind: 'progress',
      payload: { stage: 'remesh', fraction: 0.4, message: 'voxel remeshing' }
    })
  })

  it('parses @@result with any spacing after the tag', () => {
    expect(parseLine('@@result   {"height_m":1.815,"objects":[]}')).toEqual({
      kind: 'result',
      payload: { height_m: 1.815, objects: [] }
    })
  })

  it('parses @@error', () => {
    expect(parseLine('@@error {"code":"E_FOLLOW_CHECK","message":"drift","detail":{"bone":3}}')).toEqual({
      kind: 'error',
      payload: { code: 'E_FOLLOW_CHECK', message: 'drift', detail: { bone: 3 } }
    })
  })

  it('treats everything else as log text', () => {
    expect(parseLine('Read prefs: "C:\\x"')).toEqual({ kind: 'log', payload: 'Read prefs: "C:\\x"' })
    expect(parseLine('')).toEqual({ kind: 'log', payload: '' })
    expect(parseLine('  @@result {}')).toEqual({ kind: 'log', payload: '  @@result {}' })
    expect(parseLine('@@resultx {}')).toEqual({ kind: 'log', payload: '@@resultx {}' })
    expect(parseLine('@@result {broken')).toEqual({ kind: 'log', payload: '@@result {broken' })
    expect(parseLine('@@progress [1,2]')).toEqual({ kind: 'log', payload: '@@progress [1,2]' })
    expect(parseLine('@@result')).toEqual({ kind: 'log', payload: '@@result' })
  })

  it('decodes ASCII-escaped JSON (ensure_ascii=True)', () => {
    const line = '@@progress {"stage":"save","fraction":0.9,"message":"caf\\u00e9 \\u2192 \\ud83d\\ude00"}'
    const parsed = parseLine(line)
    expect(parsed.kind).toBe('progress')
    expect(parsed.kind === 'progress' && parsed.payload.message).toBe('café → 😀')
    const result = parseLine('@@result {"name":"H\\u00e9ro\\u00efne"}')
    expect(result).toEqual({ kind: 'result', payload: { name: 'Héroïne' } })
  })

  it('strips a trailing CR and normalises odd payloads', () => {
    expect(parseLine('@@result {"a":1}\r')).toEqual({ kind: 'result', payload: { a: 1 } })
    expect(parseLine('@@progress {"fraction":7}')).toEqual({ kind: 'progress', payload: { stage: '', fraction: 1, message: '' } })
    expect(parseLine('@@error {"code":"E_WHAT","message":"m"}')).toEqual({
      kind: 'error',
      payload: { code: 'E_INTERNAL', message: 'm', detail: { engine_code: 'E_WHAT' } }
    })
  })
})

describe('cleanEnv', () => {
  const vars = { LD_LIBRARY_PATH: '/tmp/.mount/usr/lib', APPDIR: '/tmp/.mount', PYTHONHOME: '/x', PYTHONPATH: '/y', HOME: '/home/u', PATH: '/usr/bin' }

  it('removes the AppImage variables when running from an AppImage', () => {
    const env = { ...vars, APPIMAGE: '/home/u/MPM.AppImage' }
    expect(cleanEnv(env)).toEqual({ HOME: '/home/u', PATH: '/usr/bin' })
    expect(env.APPIMAGE).toBe('/home/u/MPM.AppImage') // input untouched
  })

  it('keeps everything outside an AppImage', () => {
    expect(cleanEnv(vars)).toEqual(vars)
    expect(cleanEnv(vars)).not.toBe(vars)
  })
})

describe('blenderArgs', () => {
  it('builds the contract command line with absolute paths', () => {
    const engine = path.resolve('some', 'engine')
    const job = path.resolve('proj', 'cache', 'jobs', 'j.json')
    expect(blenderArgs(engine, 'import', job)).toEqual([
      '-b',
      '--factory-startup',
      '--offline-mode',
      '--python-exit-code',
      '1',
      '-P',
      path.join(engine, 'jobs', 'import.py'),
      '--',
      job
    ])
  })
})

describe('JobRunner with a fake engine', () => {
  let root: string
  let projectDir: string
  let engineDir: string
  let log: EventLog

  beforeEach(() => {
    root = tempDir('jobs')
    projectDir = path.join(root, 'Project')
    engineDir = path.join(root, 'engine')
    mkdirSync(projectDir)
    mkdirSync(path.join(engineDir, 'jobs'), { recursive: true })
    writeFileSync(path.join(engineDir, 'jobs', 'fake.py'), '# fake job script\n')
    log = new EventLog()
  })

  afterEach(() => removeDir(root))

  function runner(scenario: string, extra: Partial<JobRunnerOptions> = {}): JobRunner {
    return new JobRunner({
      engineDir,
      resolveBlender: () => process.execPath,
      emit: log.emit,
      env: { ...process.env, MPM_FAKE_JOB: scenario },
      launcherArgs: [FAKE_JOB],
      killGraceMs: 500,
      ...extra
    })
  }

  const run = (r: JobRunner, args: Record<string, unknown> = {}) => r.run({ dir: projectDir, type: 'fake', args })

  it('streams progress and log events in order, then one result', async () => {
    const jobId = run(runner('result'), { file: 'source/hero.fbx', n: 2 })
    const end = await log.terminal(jobId)
    const events = log.forJob(jobId)
    expect(events[events.length - 1]).toBe(end)
    expect(events.filter((e) => e.kind === 'result' || e.kind === 'error')).toHaveLength(1)

    // stderr is a separate pipe, so only the stdout events have a fixed order.
    const stdout = events.filter((e) => !(e.kind === 'log' && e.payload === 'stderr line'))
    expect(stdout.map((e) => e.kind)).toEqual(['progress', 'log', 'progress', 'result'])
    expect(stdout[0].payload).toEqual({ stage: 'load', fraction: 0.1, message: 'loading' })
    expect(stdout[1].payload).toBe('plain log line')
    expect(stdout[2].payload).toEqual({ stage: 'work', fraction: 0.5, message: 'café → ok' })
    expect(events.some((e) => e.kind === 'log' && e.payload === 'stderr line')).toBe(true)

    const jobFile = path.join(projectDir, 'cache', 'jobs', `${jobId}.json`)
    expect(end.kind).toBe('result')
    expect(end.payload).toEqual({
      id: jobId,
      type: 'fake',
      project_dir: projectDir,
      args: { file: 'source/hero.fbx', n: 2 },
      script: path.join(engineDir, 'jobs', 'fake.py'),
      jobFile
    })
    expect(JSON.parse(readFileSync(jobFile, 'utf8'))).toEqual({
      schema: 'mpm.job/1',
      id: jobId,
      type: 'fake',
      project_dir: projectDir,
      args: { file: 'source/hero.fbx', n: 2 }
    })
    const text = readFileSync(path.join(projectDir, 'cache', 'jobs', `${jobId}.log`), 'utf8')
    for (const piece of ['@@progress {"stage":"load"', 'plain log line', 'stderr line', 'caf\\u00e9', '@@result {']) {
      expect(text).toContain(piece)
    }
  }, PROCESS_TEST_MS)

  it('passes an engine @@error through', async () => {
    const jobId = run(runner('error'))
    const end = await log.terminal(jobId)
    expect(end).toEqual({
      jobId,
      kind: 'error',
      payload: { code: 'E_NO_MESH', message: 'the file contains no mesh', detail: { path: 'x.fbx' } }
    })
    expect(log.forJob(jobId).map((e) => e.kind)).toEqual(['progress', 'error'])
  }, PROCESS_TEST_MS)

  it('exit code 0 without @@result is E_INTERNAL "no result"', async () => {
    const jobId = run(runner('noresult'))
    const end = await log.terminal(jobId)
    expect(end.kind).toBe('error')
    expect(end.kind === 'error' && end.payload.code).toBe('E_INTERNAL')
    expect(end.kind === 'error' && end.payload.message).toBe('no result')
  }, PROCESS_TEST_MS)

  it('a nonzero exit without @@error is E_INTERNAL with the last 40 log lines', async () => {
    const jobId = run(runner('crash'))
    const end = await log.terminal(jobId)
    if (end.kind !== 'error') throw new Error('expected an error')
    expect(end.payload.code).toBe('E_INTERNAL')
    expect(end.payload.message).toContain('code 3')
    const tail = end.payload.detail.log_tail as string[]
    expect(tail).toHaveLength(40)
    expect(tail[0]).toBe('line 11')
    expect(tail[39]).toBe('line 50')
    expect(end.payload.detail.exit_code).toBe(3)
  }, PROCESS_TEST_MS)

  it('keeps the first of two @@result lines and logs the second', async () => {
    const jobId = run(runner('double'))
    const end = await log.terminal(jobId)
    expect(end).toEqual({ jobId, kind: 'result', payload: { n: 1 } })
    expect(log.forJob(jobId).some((e) => e.kind === 'log' && e.payload === '@@result {"n":2}')).toBe(true)
  }, PROCESS_TEST_MS)

  it('times out with E_INTERNAL "timeout" and kills the process', async () => {
    const jobId = run(runner('hang', { timeoutMs: 600 }))
    const started = await log.waitFor((e) => e.jobId === jobId && e.kind === 'progress')
    const pid = Number(started.kind === 'progress' && started.payload.message)
    const end = await log.terminal(jobId)
    expect(end.kind === 'error' && end.payload.code).toBe('E_INTERNAL')
    expect(end.kind === 'error' && end.payload.message).toBe('timeout')
    expect(await waitGone(pid)).toBe(true)
  }, PROCESS_TEST_MS)

  it('cancel kills the whole process tree and ends with E_CANCELLED', async () => {
    const r = runner('tree')
    const jobId = run(r)
    const started = await log.waitFor((e) => e.jobId === jobId && e.kind === 'progress')
    const [pid, grandchild] = (started.kind === 'progress' ? started.payload.message : '').split(' ').map(Number)
    expect(pid).toBeGreaterThan(0)
    expect(grandchild).toBeGreaterThan(0)
    r.cancel(jobId)
    const end = await log.terminal(jobId)
    expect(end).toEqual({ jobId, kind: 'error', payload: { code: 'E_CANCELLED', message: 'cancelled', detail: {} } })
    expect(await waitGone(pid)).toBe(true)
    expect(await waitGone(grandchild)).toBe(true)
    expect(r.activeJobId).toBeNull()
    r.cancel(jobId) // finished jobs are ignored
    expect(log.forJob(jobId).filter((e) => e.kind === 'error')).toHaveLength(1)
  }, PROCESS_TEST_MS)

  it('runs one job at a time in FIFO order; cancelling a queued job just removes it', async () => {
    const r = runner('slow')
    const a = run(r, { name: 'a' })
    const b = run(r, { name: 'b' })
    const c = run(r, { name: 'c' })
    expect(r.queuedJobIds).toEqual([a, b, c])

    r.cancel(b)
    expect(r.queuedJobIds).toEqual([a, c])
    const endC = await log.terminal(c)
    const endA = await log.terminal(a)
    const endB = await log.terminal(b)
    expect(endA).toEqual({ jobId: a, kind: 'result', payload: { id: a } })
    expect(endC).toEqual({ jobId: c, kind: 'result', payload: { id: c } })
    expect(endB.kind === 'error' && endB.payload.code).toBe('E_CANCELLED')
    expect(log.forJob(b)).toHaveLength(1) // never started
    expect(existsSync(path.join(projectDir, 'cache', 'jobs', `${b}.json`))).toBe(false)

    const terminals = log.events.filter((e: JobEvent) => e.kind === 'result' || e.kind === 'error').map((e) => e.jobId)
    expect(terminals).toEqual([b, a, c])
    // c's process only started after a's terminal event.
    const firstOfC = log.events.findIndex((e) => e.jobId === c)
    expect(firstOfC).toBeGreaterThan(log.events.indexOf(endA))
    expect(r.activeJobId).toBeNull()
    expect(r.queuedJobIds).toEqual([])
  }, PROCESS_TEST_MS)

  it('reports a Blender that cannot be started', async () => {
    const jobId = run(runner('result', { resolveBlender: () => path.join(root, 'no-such-blender.exe'), launcherArgs: [] }))
    const end = await log.terminal(jobId)
    expect(end.kind === 'error' && end.payload.code).toBe('E_INTERNAL')
    expect(end.kind === 'error' && end.payload.message).toMatch(/cannot start Blender/)
  }, PROCESS_TEST_MS)

  it('fails with E_BLENDER_VERSION when no Blender is available', async () => {
    const jobId = run(
      runner('result', {
        resolveBlender: async () => {
          throw new Error('Blender 5.2 was not found')
        }
      })
    )
    const end = await log.terminal(jobId)
    expect(end).toEqual({ jobId, kind: 'error', payload: { code: 'E_BLENDER_VERSION', message: 'Blender 5.2 was not found', detail: {} } })
  })

  it('rejects invalid job specs up front', () => {
    const r = runner('result')
    expect(() => r.run({ dir: 'relative/dir', type: 'fake', args: {} })).toThrow(/absolute/)
    expect(() => r.run({ dir: path.join(root, 'missing'), type: 'fake', args: {} })).toThrow(/not found/)
    expect(() => r.run({ dir: projectDir, type: '../fake', args: {} })).toThrow(/invalid job type/)
    expect(() => r.run({ dir: projectDir, type: 'nope', args: {} })).toThrow(/unknown job type/)
    expect(() => r.run({ dir: projectDir, type: 'fake', args: [] as unknown as Record<string, unknown> })).toThrow(/object/)
    expect(r.queuedJobIds).toEqual([])
  })
})
