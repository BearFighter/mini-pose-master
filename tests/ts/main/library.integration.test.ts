// SPDX-License-Identifier: GPL-3.0-or-later
// Installs a pack of 3 synthetic BVH files from a local http server through the real JobRunner and
// the engine's convert_clip job. Skipped unless MPM_BLENDER points at a Blender 5.2.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { JobRunner } from '../../../electron/main/jobs'
import { Library } from '../../../electron/main/library'
import { parsePacks } from '../../../electron/main/packs'
import { REPO, removeDir, tempDir, writeFiles } from './helpers'
import { makeZip, serveBytes, sha256, startServer, syntheticBvh, type TestServer } from './libraryHelpers'

const BLENDER = process.env.MPM_BLENDER
const NAMES = ['dataset-1_raise-arm_normal_001.bvh', 'dataset-1_raise-arm_normal_002.bvh', 'dataset-1_raise-arm_happy_001.bvh']

describe.skipIf(!BLENDER)('library install with Blender 5.2 (MPM_BLENDER)', () => {
  let tmp: string
  let server: TestServer
  beforeAll(async () => {
    tmp = tempDir('library-int')
    server = await startServer()
  })
  afterAll(async () => {
    await server.close()
    removeDir(tmp)
  })

  it('downloads and converts 3 synthetic clips into an installed pack', async () => {
    const bvh = syntheticBvh()
    for (const name of NAMES) server.routes.set(`/data/${name}`, serveBytes(bvh))
    const packs = parsePacks(
      {
        schema: 'mpm.packs/1',
        converter_version: 1,
        packs: [
          {
            id: 'synth',
            title: 'Synthetic test pack',
            source: 'bandai',
            license: 'GPL-3.0-or-later',
            license_url: 'https://www.gnu.org/licenses/gpl-3.0.html',
            nc: false,
            exportable: true,
            download: { files: NAMES.map((name) => ({ name, url: `${server.base}/data/${name}`, sha256: sha256(bvh), size: Buffer.byteLength(bvh) })) }
          }
        ]
      },
      { allowLoopbackHttp: true }
    )
    const root = path.join(tmp, 'library')
    let library: Library | null = null
    const runner = new JobRunner({
      engineDir: path.join(REPO, 'engine'),
      resolveBlender: () => BLENDER!,
      emit: (event) => library?.onJobEvent(event)
    })
    library = new Library({
      root,
      packs,
      runner,
      settingsFile: path.join(tmp, 'settings.json'),
      fetch: (url, init) => fetch(url, init),
      allowLoopbackHttp: true
    })

    const result = await library.install({ packId: 'synth', acceptLicense: true })
    expect(result).toEqual({ clips: 3, failed: [] })

    const [info] = await library.list()
    expect(info).toMatchObject({ id: 'synth', installed: true, clips: 3, stale: false, licenseAccepted: true, busy: false })
    const packDir = path.join(root, 'packs', 'synth')
    const index = JSON.parse(readFileSync(path.join(packDir, 'index.json'), 'utf8'))
    expect(index).toMatchObject({ schema: 'mpm.pack/1', pack: 'synth', exportable: true, converter_version: 1 })
    expect(index.clips.map((c: { id: string }) => c.id)).toEqual(NAMES.map((n) => n.replace(/\.bvh$/, '')).sort())
    for (const clip of index.clips) {
      const bytes = readFileSync(path.join(packDir, 'clips', `${clip.id}.f32`))
      expect(bytes.subarray(0, 4).toString('ascii')).toBe('MPM0')
    }
    expect(existsSync(path.join(root, 'packs', 'synth.installing'))).toBe(false)
    for (const name of NAMES) expect(existsSync(path.join(root, 'raw', 'synth', name))).toBe(true)
  }, 300_000)

  it('installs a zip plus a folder, appends a file and re-converts, keeping ids unique and stable', async () => {
    const bvh = syntheticBvh()
    const take = 'dataset-1_raise-arm_normal_001.bvh'
    // b's take is a different recording with the same name (hips 1 cm higher).
    const other = bvh.replace(/^0\.00000 95\.00000 /m, '0.00000 96.00000 ')
    expect(other).not.toBe(bvh)
    writeFiles(path.join(tmp, 'user'), { [`a/${take}`]: bvh, [`b/${take}`]: other, 'extra/dataset-1_raise-arm_angry_001.bvh': bvh })
    const zip = path.join(tmp, 'zipped.zip')
    writeFileSync(zip, makeZip([{ name: 'walk/dataset-1_raise-arm_happy_001.bvh', data: bvh }]))
    const packs = parsePacks({
      schema: 'mpm.packs/1',
      converter_version: 1,
      packs: [
        {
          id: 'own',
          title: 'Own takes',
          source: 'bandai',
          license: 'GPL-3.0-or-later',
          license_url: 'https://www.gnu.org/licenses/gpl-3.0.html',
          nc: false,
          exportable: true,
          download: { user_supplied: true, accepts: ['.zip', 'folder'], instructions: 'Choose them.' },
          include: null
        }
      ]
    })
    const root = path.join(tmp, 'library2')
    let library: Library | null = null
    const runner = new JobRunner({ engineDir: path.join(REPO, 'engine'), resolveBlender: () => BLENDER!, emit: (event) => library?.onJobEvent(event) })
    library = new Library({ root, packs, runner, settingsFile: path.join(tmp, 'settings2.json'), fetch: (url, init) => fetch(url, init) })
    const ids = () => JSON.parse(readFileSync(path.join(root, 'packs', 'own', 'index.json'), 'utf8')).clips.map((c: { id: string; src: string }) => `${c.id} <- ${c.src}`).sort()

    expect(await library.installFromFile({ packId: 'own', files: [zip, path.join(tmp, 'user', 'a'), path.join(tmp, 'user', 'b')], acceptLicense: true })).toEqual({
      clips: 3,
      failed: []
    })
    expect(ids()).toEqual([
      // Folder a and folder b both have the take at the top: the second copy gets a free name.
      'dataset-1_raise-arm_happy_001 <- walk/dataset-1_raise-arm_happy_001.bvh',
      'dataset-1_raise-arm_normal_001 <- dataset-1_raise-arm_normal_001.bvh',
      'dataset-1_raise-arm_normal_001-2 <- dataset-1_raise-arm_normal_001-2.bvh'
    ])

    expect(await library.installFromFile({ packId: 'own', files: [path.join(tmp, 'user', 'extra')], acceptLicense: true, append: true })).toEqual({
      clips: 4,
      failed: []
    })
    const before = ids()
    expect(before).toContain('dataset-1_raise-arm_angry_001 <- dataset-1_raise-arm_angry_001.bvh')

    expect(await library.reconvert('own')).toEqual({ clips: 4, failed: [] })
    expect(ids()).toEqual(before)
    expect(readdirSync(path.join(root, 'cache', 'jobs'))).toEqual([])
  }, 300_000)

  it('keeps same-named takes in sub-folders apart (engine `root`)', async () => {
    const bvh = syntheticBvh()
    const take = 'dataset-1_raise-arm_normal_001.bvh'
    writeFiles(path.join(tmp, 'nested'), { [`a/${take}`]: bvh, [`b/${take}`]: bvh })
    const packs = parsePacks({
      schema: 'mpm.packs/1',
      converter_version: 1,
      packs: [
        {
          id: 'nested',
          title: 'Nested takes',
          source: 'bandai',
          license: 'GPL-3.0-or-later',
          license_url: 'https://www.gnu.org/licenses/gpl-3.0.html',
          nc: false,
          exportable: true,
          download: { user_supplied: true, accepts: ['folder'], instructions: 'Choose it.' }
        }
      ]
    })
    const root = path.join(tmp, 'library3')
    let library: Library | null = null
    const runner = new JobRunner({ engineDir: path.join(REPO, 'engine'), resolveBlender: () => BLENDER!, emit: (event) => library?.onJobEvent(event) })
    library = new Library({ root, packs, runner, settingsFile: path.join(tmp, 'settings3.json'), fetch: (url, init) => fetch(url, init) })
    expect(await library.installFromFile({ packId: 'nested', files: [path.join(tmp, 'nested')], acceptLicense: true })).toEqual({ clips: 2, failed: [] })
    const index = JSON.parse(readFileSync(path.join(root, 'packs', 'nested', 'index.json'), 'utf8'))
    expect(index.clips.map((c: { id: string; src: string }) => `${c.id} <- ${c.src}`).sort()).toEqual([
      'b_dataset-1_raise-arm_normal_001 <- b/dataset-1_raise-arm_normal_001.bvh',
      'dataset-1_raise-arm_normal_001 <- a/dataset-1_raise-arm_normal_001.bvh'
    ])
  }, 300_000)
})
