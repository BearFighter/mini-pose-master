// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { MpmEventPayloads } from '../../../src/shared/ipc'
import { Library, zipBvhBytes, type LibraryOptions } from '../../../electron/main/library'
import { parsePacks, type PacksFile } from '../../../electron/main/packs'
import { loadSettings } from '../../../electron/main/settings'
import { listFiles, removeDir, sleep, tempDir, writeFiles } from './helpers'
import { FakeRunner, fakeConvert, makeZip, serveBytes, serveSlowly, sha256, startServer, type TestServer } from './libraryHelpers'

type Progress = MpmEventPayloads['library:progress']

const NOW = new Date('2026-11-14T12:00:00.000Z')

function content(name: string): string {
  return `synthetic test file ${name}\n`.repeat(20)
}

function buildPacks(server: TestServer, names: string[]): PacksFile {
  return parsePacks(
    {
      schema: 'mpm.packs/1',
      converter_version: 1,
      packs: [
        {
          id: 'demo',
          title: 'Demo pack',
          source: 'bandai',
          license: 'CC BY-NC 4.0',
          license_url: 'https://creativecommons.org/licenses/by-nc/4.0/',
          nc: true,
          exportable: true,
          download: {
            files: names.map((name) => ({
              name,
              url: `${server.base}/files/${name}`,
              sha256: sha256(content(name)),
              size: Buffer.byteLength(content(name))
            }))
          }
        },
        {
          id: 'user',
          title: 'User-supplied pack',
          source: 'cmu',
          license: 'Some terms',
          license_url: 'https://example.com/terms',
          nc: false,
          exportable: true,
          download: { user_supplied: true, accepts: ['.zip', 'folder'], instructions: 'Choose it.' },
          include: ['walk']
        }
      ]
    },
    { allowLoopbackHttp: true }
  )
}

describe('Library', () => {
  let tmp: string
  let root: string
  let settingsFile: string
  let server: TestServer
  let runner: FakeRunner
  let progress: Progress[]

  beforeEach(async () => {
    tmp = tempDir('library')
    root = path.join(tmp, 'library')
    settingsFile = path.join(tmp, 'settings.json')
    server = await startServer()
    runner = new FakeRunner()
    progress = []
  })

  afterEach(async () => {
    await server.close()
    removeDir(tmp)
  })

  function names(n: number): string[] {
    return Array.from({ length: n }, (_, i) => `clip_${String(i + 1).padStart(3, '0')}.bvh`)
  }

  function serveAll(list: string[]): void {
    for (const name of list) server.routes.set(`/files/${name}`, serveBytes(content(name)))
  }

  function library(list: string[], extra: Partial<LibraryOptions> = {}): Library {
    const lib = new Library({
      root,
      packs: buildPacks(server, list),
      runner,
      settingsFile,
      fetch: (url, init) => fetch(url, init),
      onProgress: (p) => progress.push(p),
      freeBytes: async () => 1e12,
      allowLoopbackHttp: true,
      backoffMs: 1,
      fileTimeoutMs: 5000,
      now: () => NOW,
      ...extra
    })
    runner.library = lib
    return lib
  }

  const raw = (id = 'demo') => path.join(root, 'raw', id)
  const pack = (id = 'demo') => path.join(root, 'packs', id)
  const installing = (id = 'demo') => path.join(root, 'packs', `${id}.installing`)

  // --- license gate and refusals

  it('refuses until the license is accepted, then records the acceptance', async () => {
    const list = names(2)
    serveAll(list)
    const lib = library(list)
    for (const acceptLicense of [undefined, false, 'yes', 1]) {
      await expect(lib.install({ packId: 'demo', acceptLicense })).rejects.toThrow(/^E_ARGS: the license must be accepted/)
    }
    await expect(lib.installFromFile({ packId: 'user', files: [tmp] })).rejects.toThrow(/license must be accepted/)
    expect(existsSync(settingsFile)).toBe(false)
    expect(server.hits.size).toBe(0)
    expect((await lib.list())[0].licenseAccepted).toBe(false)

    await lib.install({ packId: 'demo', acceptLicense: true })
    expect((await loadSettings(settingsFile)).licenses).toEqual({ demo: { license: 'CC BY-NC 4.0', acceptedAt: NOW.toISOString() } })
    expect((await lib.list())[0].licenseAccepted).toBe(true)
  })

  it('refuses unknown packs, user-supplied packs and a second install while busy', async () => {
    const list = names(1)
    serveAll(list)
    const lib = library(list)
    await expect(lib.install({ packId: 'nope', acceptLicense: true })).rejects.toThrow(/^E_ARGS: unknown pack/)
    await expect(lib.install({ packId: 'user', acceptLicense: true })).rejects.toThrow(/^E_ARGS: .*choose the downloaded file/)
    await expect(lib.install({ packId: '../x', acceptLicense: true })).rejects.toThrow(/^E_ARGS/)

    runner.behave = () => 'hold'
    const first = lib.install({ packId: 'demo', acceptLicense: true })
    while (runner.held.size === 0) await sleep(5)
    await expect(lib.install({ packId: 'demo', acceptLicense: true })).rejects.toThrow(/busy/)
    await expect(lib.remove('demo')).rejects.toThrow(/busy/)
    expect((await lib.list())[0].busy).toBe(true)
    await lib.cancel('demo')
    await expect(first).rejects.toThrow(/^E_CANCELLED/)
    expect((await lib.list())[0].busy).toBe(false)
  })

  it('needs 3x the download size free', async () => {
    const list = names(3)
    serveAll(list)
    const lib = library(list, { freeBytes: async () => 100 })
    const err = await lib.install({ packId: 'demo', acceptLicense: true }).catch((e) => e)
    expect(err.message).toMatch(/^E_IO: not enough free disk space: .* needed, .* free/)
    expect(err.detail.free).toBe(100)
    expect(err.detail.needed).toBe(3 * list.reduce((s, n) => s + Buffer.byteLength(content(n)), 0))
    expect(server.hits.size).toBe(0)
  })

  // --- download + convert + swap

  it('downloads, converts in batches of 25 and swaps the pack into place', async () => {
    const list = names(30)
    serveAll(list)
    const lib = library(list)
    mkdirSync(pack(), { recursive: true })
    writeFileSync(path.join(pack(), 'old.txt'), 'from the previous install')

    const result = await lib.install({ packId: 'demo', acceptLicense: true })
    expect(result).toEqual({ clips: 30, failed: [] })

    expect(readdirSync(raw()).sort()).toEqual([...list].sort())
    for (const name of list) expect(readFileSync(path.join(raw(), name), 'utf8')).toBe(content(name))
    for (const name of list) expect(server.hits.get(`/files/${name}`)).toBe(1)

    expect(runner.specs).toHaveLength(2)
    const [a, b] = runner.specs
    expect(a.dir).toBe(root)
    expect(a.type).toBe('convert_clip')
    expect(a.args).toEqual({
      source: 'bandai',
      files: list.slice(0, 25).map((n) => path.join(raw(), n)),
      root: raw(),
      pack_dir: installing(),
      pack: {
        pack: 'demo',
        title: 'Demo pack',
        license: 'CC BY-NC 4.0',
        license_url: 'https://creativecommons.org/licenses/by-nc/4.0/',
        exportable: true,
        converter_version: 1
      }
    })
    expect((b.args.files as string[]).map((f) => path.basename(f))).toEqual(list.slice(25))

    expect(existsSync(installing())).toBe(false)
    expect(existsSync(path.join(pack(), 'old.txt'))).toBe(false)
    expect(JSON.parse(readFileSync(path.join(pack(), 'index.json'), 'utf8')).clips).toHaveLength(30)

    const stages = progress.map((p) => p.stage)
    expect(stages[0]).toBe('download')
    expect(stages).toContain('convert')
    expect(progress[progress.length - 1]).toEqual({ packId: 'demo', stage: 'done', fraction: 1 })
    expect(stages.indexOf('convert')).toBeGreaterThan(stages.lastIndexOf('download'))
    const convert = progress.filter((p) => p.stage === 'convert').map((p) => p.fraction)
    for (let i = 1; i < convert.length; i++) expect(convert[i]).toBeGreaterThanOrEqual(convert[i - 1])

    const [info] = await lib.list()
    expect(info).toMatchObject({ id: 'demo', installed: true, clips: 30, busy: false, stale: false, licenseAccepted: true })

    // Successful jobs leave no job files behind.
    expect(readdirSync(path.join(root, 'cache', 'jobs'))).toEqual([])
  })

  it('install() on a stale pack re-uses the verified raw files and rebuilds the pack', async () => {
    const list = names(5)
    serveAll(list)
    const lib = library(list)
    await lib.install({ packId: 'demo', acceptLicense: true })
    const indexFile = path.join(pack(), 'index.json')
    writeFileSync(indexFile, JSON.stringify({ ...JSON.parse(readFileSync(indexFile, 'utf8')), converter_version: 0 }))
    expect((await lib.list())[0].stale).toBe(true)

    runner.specs.length = 0
    expect(await lib.install({ packId: 'demo', acceptLicense: true })).toEqual({ clips: 5, failed: [] })
    for (const name of list) expect(server.hits.get(`/files/${name}`)).toBe(1) // not fetched again
    expect(runner.specs).toHaveLength(1)
    expect((await lib.list())[0]).toMatchObject({ installed: true, clips: 5, stale: false })
  })

  it('resumes: good files in raw/ are kept, bad ones fetched again', async () => {
    const list = names(4)
    serveAll(list)
    const lib = library(list)
    mkdirSync(raw(), { recursive: true })
    writeFileSync(path.join(raw(), list[0]), content(list[0]))
    writeFileSync(path.join(raw(), list[1]), content(list[1]))
    writeFileSync(path.join(raw(), list[2]), 'damaged')
    await lib.install({ packId: 'demo', acceptLicense: true })
    expect([list[0], list[1]].map((n) => server.hits.get(`/files/${n}`) ?? 0)).toEqual([0, 0])
    expect([list[2], list[3]].map((n) => server.hits.get(`/files/${n}`))).toEqual([1, 1])
    expect(readFileSync(path.join(raw(), list[2]), 'utf8')).toBe(content(list[2]))
  })

  it('a wrong hash is retried, then fails with E_IO naming the file', async () => {
    const list = names(3)
    serveAll(list)
    server.routes.set(`/files/${list[1]}`, serveBytes(content(list[1]).replace('synthetic', 'SYNTHETIC')))
    const lib = library(list)
    const err = await lib.install({ packId: 'demo', acceptLicense: true }).catch((e) => e)
    expect(err.message).toMatch(new RegExp(`^E_IO: download of ${list[1]} failed after 3 tries: SHA-256 mismatch`))
    expect(err.detail.file).toBe(list[1])
    expect(server.hits.get(`/files/${list[1]}`)).toBe(3)
    expect(existsSync(path.join(raw(), list[1]))).toBe(false)
    expect(readdirSync(raw()).filter((n) => n.endsWith('.part'))).toEqual([])
    expect(runner.specs).toHaveLength(0)
    expect(existsSync(pack())).toBe(false)
  })

  it('a too-large or short download counts as a mismatch', async () => {
    const list = names(1)
    server.routes.set(`/files/${list[0]}`, serveBytes(content(list[0]) + 'extra'))
    const lib = library(list, { tries: 2 })
    await expect(lib.install({ packId: 'demo', acceptLicense: true })).rejects.toThrow(/failed after 2 tries: more than the expected/)
  })

  it('refuses a redirect to http (no retries), but follows allowed redirects', async () => {
    const list = names(2)
    serveAll(list)
    server.routes.set(`/files/${list[0]}`, (_req, res) => res.writeHead(302, { location: 'http://example.invalid/x.bvh' }).end())
    const lib = library(list)
    const err = await lib.install({ packId: 'demo', acceptLicense: true }).catch((e) => e)
    expect(err.message).toMatch(/^E_IO: .*refused http:\/\/example\.invalid\/x\.bvh: only https:\/\//)
    expect(server.hits.get(`/files/${list[0]}`)).toBe(1)

    server.routes.set(`/files/${list[0]}`, (_req, res) => res.writeHead(302, { location: `/moved/${list[0]}` }).end())
    server.routes.set(`/moved/${list[0]}`, serveBytes(content(list[0])))
    await expect(lib.install({ packId: 'demo', acceptLicense: true })).resolves.toEqual({ clips: 2, failed: [] })
  })

  it('times out a stalled file and retries it', async () => {
    const list = names(1)
    server.routes.set(`/files/${list[0]}`, (_req, res) => {
      res.writeHead(200, { 'content-length': '1000' })
      res.write('only a little')
    })
    const lib = library(list, { fileTimeoutMs: 200, tries: 2 })
    await expect(lib.install({ packId: 'demo', acceptLicense: true })).rejects.toThrow(/failed after 2 tries: timed out/)
    expect(server.hits.get(`/files/${list[0]}`)).toBe(2)
  })

  it('cancel during the download stops it, removes .part files and keeps raw/', async () => {
    const list = names(2)
    serveAll(list)
    const big = new TextEncoder().encode('x'.repeat(200_000))
    const slow = 'slow.bvh'
    server.routes.set(`/files/${slow}`, serveSlowly(big, 2000, 20))
    const packs = buildPacks(server, list)
    if (!('files' in packs.packs[0].download)) throw new Error('unexpected')
    packs.packs[0].download.files.push({ name: slow, url: `${server.base}/files/${slow}`, sha256: sha256(big), size: big.length })
    const lib = library(list, { packs, onProgress: (p) => {
      progress.push(p)
      if (p.stage === 'download' && p.fraction > 0.1) void lib.cancel('demo')
    } })
    await expect(lib.install({ packId: 'demo', acceptLicense: true })).rejects.toThrow(/^E_CANCELLED/)
    expect(existsSync(raw())).toBe(true)
    expect(readdirSync(raw()).filter((n) => n.endsWith('.part'))).toEqual([])
    expect(existsSync(path.join(raw(), slow))).toBe(false)
    expect(runner.specs).toHaveLength(0)
    expect(lib.isBusy()).toBe(false)
  })

  it('cancel during the conversion kills the job, removes .installing and keeps the old pack', async () => {
    const list = names(3)
    serveAll(list)
    const lib = library(list)
    mkdirSync(pack(), { recursive: true })
    writeFileSync(path.join(pack(), 'index.json'), JSON.stringify({ clips: [{ id: 'old' }], converter_version: 1 }))
    runner.behave = (spec) => {
      fakeConvert(spec)
      return 'hold'
    }
    const pending = lib.install({ packId: 'demo', acceptLicense: true })
    while (runner.held.size === 0) await sleep(5)
    expect(existsSync(path.join(installing(), 'index.json'))).toBe(true)
    await lib.cancel('demo')
    await expect(pending).rejects.toThrow(/^E_CANCELLED/)
    expect(runner.held.size).toBe(0)
    expect(existsSync(installing())).toBe(false)
    expect(JSON.parse(readFileSync(path.join(pack(), 'index.json'), 'utf8')).clips).toEqual([{ id: 'old' }])
    expect(readdirSync(raw()).sort()).toEqual([...list].sort())
  })

  it('collects failures from every batch, including a batch that converted nothing', async () => {
    const list = names(30)
    serveAll(list)
    const lib = library(list)
    runner.behave = (spec, i) => {
      if (i === 0) {
        const files = spec.args.files as string[]
        const { clips } = fakeConvert({ ...spec, args: { ...spec.args, files: files.slice(1) } })
        return { result: { clips, failed: [{ file: path.basename(files[0]), error: 'bad hierarchy' }] } }
      }
      return {
        error: {
          code: 'E_IMPORT_FAILED',
          message: 'no clip could be converted',
          detail: { failed: (spec.args.files as string[]).map((f) => ({ file: path.basename(f), error: 'no frames' })) }
        }
      }
    }
    const result = await lib.install({ packId: 'demo', acceptLicense: true })
    expect(result.clips).toBe(24)
    expect(result.failed).toHaveLength(6)
    expect(result.failed[0]).toEqual({ file: list[0], error: 'bad hierarchy' })
    expect(result.failed.slice(1).map((f) => f.file)).toEqual(list.slice(25))
  })

  it('fails without touching the old pack when nothing converts or a job errors', async () => {
    const list = names(2)
    serveAll(list)
    const lib = library(list)
    mkdirSync(pack(), { recursive: true })
    writeFileSync(path.join(pack(), 'index.json'), JSON.stringify({ clips: [{ id: 'old' }] }))

    runner.behave = () => ({ error: { code: 'E_IMPORT_FAILED', message: 'no clip could be converted', detail: { failed: [] } } })
    await expect(lib.install({ packId: 'demo', acceptLicense: true })).rejects.toThrow(/^E_IMPORT_FAILED: no clip could be converted/)
    runner.behave = () => ({ error: { code: 'E_BLENDER_VERSION', message: 'Blender 5.2 was not found', detail: {} } })
    await expect(lib.install({ packId: 'demo', acceptLicense: true })).rejects.toThrow(/^E_BLENDER_VERSION: Blender 5.2/)

    expect(existsSync(installing())).toBe(false)
    expect(JSON.parse(readFileSync(path.join(pack(), 'index.json'), 'utf8')).clips).toEqual([{ id: 'old' }])
  })

  it('reports packs made by an older converter as stale', async () => {
    const lib = library(names(1))
    mkdirSync(pack(), { recursive: true })
    writeFileSync(path.join(pack(), 'index.json'), JSON.stringify({ clips: [{ id: 'a' }, { id: 'b' }], converter_version: 0 }))
    expect((await lib.list())[0]).toMatchObject({ installed: true, clips: 2, stale: true })
    writeFileSync(path.join(pack(), 'index.json'), JSON.stringify({ clips: [], converter_version: 1 }))
    expect((await lib.list())[0]).toMatchObject({ installed: true, clips: 0, stale: false })
    expect((await lib.list())[1]).toMatchObject({ id: 'user', installed: false, stale: false })
  })

  // --- installFromFile, importClip, remove, saveThumb

  const incoming = (id = 'user') => path.join(root, 'raw', `${id}.incoming`)
  const userMeta = { pack: 'user', title: 'User-supplied pack', license: 'Some terms', license_url: 'https://example.com/terms', exportable: true, converter_version: 1 }
  const clipIds = (id = 'user') => JSON.parse(readFileSync(path.join(pack(id), 'index.json'), 'utf8')).clips.map((c: { id: string }) => c.id).sort()

  it('installFromFile: a .zip is one extraction job, staged and then moved into raw/<pack>', async () => {
    const lib = library(names(1))
    const zip = path.join(tmp, 'cmu.zip')
    writeFileSync(zip, makeZip([{ name: 'walk/01.bvh', data: 'x'.repeat(100) }]))
    runner.behave = (spec) => ({ result: fakeConvert(spec, ['walk_01', 'walk_02']) })
    const result = await lib.installFromFile({ packId: 'user', files: [zip], acceptLicense: true })
    expect(result).toEqual({ clips: 2, failed: [] })
    expect(runner.specs).toHaveLength(1)
    expect(runner.specs[0].args).toEqual({
      source: 'cmu',
      archives: [zip],
      extract_dir: incoming(),
      root: incoming(),
      include: ['walk'],
      pack_dir: installing('user'),
      pack: userMeta
    })
    expect(existsSync(path.join(pack('user'), 'index.json'))).toBe(true)
    expect(existsSync(raw('user'))).toBe(true)
    expect(existsSync(incoming())).toBe(false)
    expect((await loadSettings(settingsFile)).licenses?.user?.license).toBe('Some terms')
  })

  it('installFromFile: folders and .bvh files are copied into raw/<pack>, keeping relative paths', async () => {
    const lib = library(names(1))
    const folder = path.join(tmp, 'bvh')
    const rels = Array.from({ length: 30 }, (_, i) => `${i % 2 ? 'sub/' : ''}take_${String(i).padStart(2, '0')}.BVH`)
    writeFiles(folder, Object.fromEntries([...rels.map((r) => [r, `clip ${r}`]), ['readme.txt', 'not a clip']]))

    expect(await lib.installFromFile({ packId: 'user', files: [folder], acceptLicense: true })).toEqual({ clips: 30, failed: [] })
    expect(runner.specs.map((s) => (s.args.files as string[]).length)).toEqual([25, 5])
    expect(runner.specs.flatMap((s) => s.args.files as string[])).toEqual(rels.map((r) => path.join(incoming(), ...r.split('/'))).sort())
    expect(runner.specs.every((s) => s.args.root === incoming())).toBe(true)
    expect(listFiles(raw('user'))).toEqual([...rels].sort())
    expect(readFileSync(path.join(raw('user'), 'sub', 'take_01.BVH'), 'utf8')).toBe('clip sub/take_01.BVH')

    // A single .bvh (no append) replaces the pack and its raw/ folder.
    runner.specs.length = 0
    expect(await lib.installFromFile({ packId: 'user', files: [path.join(folder, 'sub', 'take_03.BVH')], acceptLicense: true })).toEqual({
      clips: 1,
      failed: []
    })
    expect(runner.specs.map((s) => s.args.files)).toEqual([[path.join(incoming(), 'take_03.BVH')]])
    expect(listFiles(raw('user'))).toEqual(['take_03.BVH'])
    expect(clipIds()).toEqual(['take_03'])

    writeFileSync(path.join(tmp, 'model.fbx'), 'x')
    await expect(lib.installFromFile({ packId: 'user', files: [path.join(tmp, 'model.fbx')], acceptLicense: true })).rejects.toThrow(/^E_ARGS: choose \.zip files/)
    await expect(lib.installFromFile({ packId: 'user', files: [path.join(tmp, 'missing.zip')], acceptLicense: true })).rejects.toThrow(/^E_ARGS: not found/)
    mkdirSync(path.join(tmp, 'empty'))
    await expect(lib.installFromFile({ packId: 'user', files: [path.join(tmp, 'empty')], acceptLicense: true })).rejects.toThrow(/no \.bvh files/)
    await expect(lib.installFromFile({ packId: 'user', files: [], acceptLicense: true })).rejects.toThrow(/^E_ARGS/)
  })

  it('installFromFile takes a mix of zips, folders and files; append adds to the pack', async () => {
    const lib = library(names(1))
    writeFiles(tmp, { 'a/take.bvh': 'A', 'b/take.bvh': 'B', 'c/take.bvh': 'A', 'b/again.bvh': 'again', 'd/extra/x.bvh': 'x' })
    const zip = path.join(tmp, 'z.zip')
    writeFileSync(zip, makeZip([{ name: 'walk/w.bvh', data: 'w' }]))
    runner.behave = (spec) => ({ result: fakeConvert(spec, spec.args.archives ? ['zipped'] : undefined) })

    const first = await lib.installFromFile({
      packId: 'user',
      files: [zip, path.join(tmp, 'a', 'take.bvh'), path.join(tmp, 'b', 'take.bvh'), path.join(tmp, 'c', 'take.bvh'), path.join(tmp, 'd')],
      acceptLicense: true
    })
    // The zip job first, then the copies: a different file of the same name gets a free name, identical bytes are kept once.
    expect(runner.specs.map((s) => (s.args.archives ? 'zip' : (s.args.files as string[]).map((f) => path.relative(incoming(), f))))).toEqual([
      'zip',
      ['take-2.bvh', 'take.bvh', path.join('extra', 'x.bvh')].sort()
    ])
    expect(first.clips).toBe(4)
    expect(listFiles(raw('user'))).toEqual(['extra/x.bvh', 'take-2.bvh', 'take.bvh'])

    const second = await lib.installFromFile({ packId: 'user', files: [path.join(tmp, 'b', 'again.bvh')], acceptLicense: true, append: true })
    expect(second).toEqual({ clips: 5, failed: [] })
    expect(clipIds()).toEqual(['again', 'take', 'take-2', 'x', 'zipped'])
    expect(listFiles(raw('user'))).toEqual(['again.bvh', 'extra/x.bvh', 'take-2.bvh', 'take.bvh'])

    const third = await lib.installFromFile({ packId: 'user', files: [path.join(tmp, 'b', 'again.bvh')], acceptLicense: true })
    expect(third).toEqual({ clips: 1, failed: [] })
    expect(clipIds()).toEqual(['again'])
    expect(listFiles(raw('user'))).toEqual(['again.bvh'])
  })

  it('a failed installFromFile leaves the pack and raw/ as they were', async () => {
    const lib = library(names(1))
    writeFiles(tmp, { 'one/a.bvh': 'a', 'two/b.bvh': 'b' })
    await lib.installFromFile({ packId: 'user', files: [path.join(tmp, 'one')], acceptLicense: true })
    runner.behave = () => ({ error: { code: 'E_BLENDER_VERSION', message: 'Blender 5.2 was not found', detail: {} } })
    for (const append of [false, true]) {
      await expect(lib.installFromFile({ packId: 'user', files: [path.join(tmp, 'two')], acceptLicense: true, append })).rejects.toThrow(/^E_BLENDER_VERSION/)
      expect(clipIds()).toEqual(['a'])
      expect(listFiles(raw('user'))).toEqual(['a.bvh'])
      expect(existsSync(incoming())).toBe(false)
      expect(existsSync(installing('user'))).toBe(false)
    }
    // The failed jobs keep their job files; the successful one left none.
    expect(readdirSync(path.join(root, 'cache', 'jobs')).sort()).toEqual(['job-2.json', 'job-2.log', 'job-3.json', 'job-3.log'])
  })

  it('installFromFile checks the disk space for the copies and the unpacked zip first', async () => {
    const zip = path.join(tmp, 'big.zip')
    const bytes = makeZip([{ name: 'walk/a.bvh', data: 'MOTION 0 0 0\n'.repeat(50_000) }, { name: 'readme.txt', data: 'r' }])
    writeFileSync(zip, bytes)
    expect(await zipBvhBytes(zip)).toBe(650_000)
    expect(await zipBvhBytes(zip, ['run'])).toBe(0)
    expect(await zipBvhBytes(path.join(tmp, 'missing.zip'))).toBeNull()
    writeFileSync(path.join(tmp, 'not.zip'), 'PK but not really')
    expect(await zipBvhBytes(path.join(tmp, 'not.zip'))).toBeNull()

    const lib = library(names(1), { freeBytes: async () => 10 * bytes.length }) // plenty for the zip, not for its contents
    await expect(lib.installFromFile({ packId: 'user', files: [zip], acceptLicense: true })).rejects.toThrow(/^E_IO: not enough free disk space/)
    expect(runner.specs).toHaveLength(0)
  })

  it('reconvert rebuilds a pack from everything in raw/<pack>', async () => {
    const lib = library(names(1))
    writeFiles(tmp, { 'src/a.bvh': 'a', 'src/sub/b.bvh': 'b', 'src/sub/c.bvh': 'c' })
    await lib.installFromFile({ packId: 'user', files: [path.join(tmp, 'src')], acceptLicense: true })
    const indexFile = path.join(pack('user'), 'index.json')
    writeFileSync(indexFile, JSON.stringify({ ...JSON.parse(readFileSync(indexFile, 'utf8')), converter_version: 0 }))
    expect((await lib.list())[1].stale).toBe(true)

    runner.specs.length = 0
    expect(await lib.reconvert('user')).toEqual({ clips: 3, failed: [] })
    expect(runner.specs).toHaveLength(1)
    expect(runner.specs[0].args).toMatchObject({
      source: 'cmu',
      files: ['a.bvh', 'sub/b.bvh', 'sub/c.bvh'].map((r) => path.join(raw('user'), ...r.split('/'))),
      root: raw('user'),
      pack_dir: installing('user')
    })
    expect((await lib.list())[1]).toMatchObject({ installed: true, clips: 3, stale: false })
    await expect(lib.reconvert('demo')).rejects.toThrow(/^E_ARGS: nothing to re-convert/)
    await expect(lib.reconvert('nope')).rejects.toThrow(/^E_ARGS: unknown pack/)
  })

  it('importClip copies the BVH into raw/mine and converts it into the mine pack', async () => {
    const lib = library(names(1))
    const bvh = path.join(tmp, 'my_jump.bvh')
    writeFileSync(bvh, 'x')
    const copy = path.join(raw('mine'), 'my_jump.bvh')
    expect(await lib.importClip({ file: bvh, source: null })).toEqual({ packId: 'mine', clipIds: ['my_jump'] })
    expect(runner.specs[0].args).toEqual({
      source: null,
      files: [copy],
      root: raw('mine'),
      pack_dir: pack('mine'),
      pack: { pack: 'mine', title: 'My clips', license: 'Your own', license_url: '', exportable: true, converter_version: 1 }
    })
    expect(readFileSync(copy, 'utf8')).toBe('x')
    const mine = (await lib.list()).find((p) => p.id === 'mine')
    expect(mine).toMatchObject({ installed: true, clips: 1, licenseAccepted: true, nc: false, exportable: true, license: 'Your own' })

    // The same bytes again re-use the copy; a different file of the same name gets a free name.
    await lib.importClip({ file: bvh, source: 'cmu' })
    expect(runner.specs[1].args).toMatchObject({ source: 'cmu', files: [copy] })
    writeFiles(tmp, { 'other/my_jump.bvh': 'y', 'third/my_jump.bvh': 'z' })
    expect(await lib.importClip({ file: path.join(tmp, 'other', 'my_jump.bvh') })).toEqual({ packId: 'mine', clipIds: ['my_jump-2'] })
    expect(listFiles(raw('mine'))).toEqual(['my_jump-2.bvh', 'my_jump.bvh'])
    expect(readdirSync(path.join(root, 'cache', 'jobs'))).toEqual([])

    // A failed conversion removes its copy and keeps its job files.
    runner.behave = (spec) => ({
      error: {
        code: 'E_IMPORT_FAILED',
        message: 'no clip could be converted',
        detail: { failed: [{ file: path.basename((spec.args.files as string[])[0]), error: 'unknown or undetectable mocap source' }] }
      }
    })
    await expect(lib.importClip({ file: path.join(tmp, 'third', 'my_jump.bvh') })).rejects.toThrow(/^E_IMPORT_FAILED: my_jump\.bvh: unknown or undetectable/)
    expect(listFiles(raw('mine'))).toEqual(['my_jump-2.bvh', 'my_jump.bvh'])
    expect(readdirSync(path.join(root, 'cache', 'jobs')).sort()).toEqual(['job-4.json', 'job-4.log'])

    writeFileSync(path.join(tmp, 'clip.txt'), 'x')
    await expect(lib.importClip({ file: path.join(tmp, 'clip.txt') })).rejects.toThrow(/^E_ARGS/)
    await expect(lib.importClip({ file: bvh, source: 'Bad Source' })).rejects.toThrow(/^E_ARGS/)

    runner.behave = (spec) => ({ result: fakeConvert(spec) })
    expect(await lib.reconvert('mine')).toEqual({ clips: 2, failed: [] })
  })

  it('remove deletes packs/<id>, raw/<id> and a leftover .installing', async () => {
    const lib = library(names(1))
    const leftovers = [pack(), raw(), installing(), incoming('demo')]
    for (const dir of leftovers) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(path.join(dir, 'x'), 'x')
    }
    await lib.remove('demo')
    for (const dir of leftovers) expect(existsSync(dir)).toBe(false)
    await expect(lib.remove('nope')).rejects.toThrow(/unknown pack/)
    await expect(lib.remove('mine')).resolves.toBeUndefined()
  })

  it('saveThumb validates and writes packs/<pack>/thumbs/<clip>_<frame>.png', async () => {
    const lib = library(names(1))
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
    await expect(lib.saveThumb({ packId: 'demo', clipId: 'a', frame: 0, png })).rejects.toThrow(/not installed/)
    mkdirSync(pack(), { recursive: true })

    const bad: [Record<string, unknown>, RegExp][] = [
      [{ packId: '..', clipId: 'a', frame: 0, png }, /packId/],
      [{ packId: 'demo', clipId: 'a/b', frame: 0, png }, /clipId/],
      [{ packId: 'demo', clipId: '.', frame: 0, png }, /clipId/],
      [{ packId: 'demo', clipId: 'a', frame: -1, png }, /frame/],
      [{ packId: 'demo', clipId: 'a', frame: 1.5, png }, /frame/],
      [{ packId: 'demo', clipId: 'a', frame: 0, png: new Uint8Array([1, 2, 3]) }, /not a PNG/],
      [{ packId: 'demo', clipId: 'a', frame: 0, png: 'not bytes' }, /png/],
      [{ packId: 'demo', clipId: 'a', frame: 0, png: new Uint8Array(512 * 1024 + 1).fill(0x89) }, /512 KB/]
    ]
    for (const [args, why] of bad) await expect(lib.saveThumb(args)).rejects.toThrow(why)
    expect(existsSync(path.join(pack(), 'thumbs'))).toBe(false)

    await lib.saveThumb({ packId: 'demo', clipId: 'dance-long_normal_001', frame: 12, png })
    expect(new Uint8Array(readFileSync(path.join(pack(), 'thumbs', 'dance-long_normal_001_12.png')))).toEqual(png)
    expect(readdirSync(path.join(pack(), 'thumbs'))).toEqual(['dance-long_normal_001_12.png'])
  })
})
