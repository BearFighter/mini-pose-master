// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { isAllowedUrl, loadPacks, parsePacks } from '../../../electron/main/packs'
import { REPO } from './helpers'

const PACKS_JSON = path.join(REPO, 'resources', 'packs.json')
const BANDAI_PREFIX =
  'https://raw.githubusercontent.com/BandaiNamcoResearchInc/Bandai-Namco-Research-Motiondataset/' +
  '74ead3ba1ae4696404e6086233779f60de8bf9ef/dataset/Bandai-Namco-Research-Motiondataset-1/data/'

function minimal(overrides: Record<string, unknown> = {}, file: Record<string, unknown> = {}) {
  return {
    schema: 'mpm.packs/1',
    converter_version: 1,
    packs: [
      {
        id: 'demo',
        title: 'Demo',
        source: 'bandai',
        license: 'CC BY-NC 4.0',
        license_url: 'https://creativecommons.org/licenses/by-nc/4.0/',
        nc: true,
        exportable: true,
        download: { files: [{ name: 'a.bvh', url: 'https://example.com/0123456789abcdef0123456789abcdef01234567/a.bvh', sha256: 'a'.repeat(64), size: 10, ...file }] },
        ...overrides
      }
    ]
  }
}

describe('resources/packs.json', () => {
  it('passes the schema and lists bandai1, lafan1 and cmu as specified', async () => {
    const packs = await loadPacks(PACKS_JSON)
    expect(packs.packs.map((p) => p.id)).toEqual(['bandai1', 'lafan1', 'cmu'])
    const [bandai, lafan, cmu] = packs.packs

    expect(bandai).toMatchObject({ source: 'bandai', license: 'CC BY-NC 4.0', license_url: 'https://creativecommons.org/licenses/by-nc/4.0/', nc: true, exportable: true })
    expect(bandai.attribution).toBe('Bandai Namco Research Inc. — Bandai-Namco-Research-Motiondataset (dataset 1)')
    expect(bandai.homepage).toBe('https://github.com/BandaiNamcoResearchInc/Bandai-Namco-Research-Motiondataset')
    if (!('files' in bandai.download)) throw new Error('bandai1 must be downloadable')
    expect(bandai.download.files).toHaveLength(175)
    for (const f of bandai.download.files) {
      expect(f.name).toMatch(/^dataset-1_.+\.bvh$/)
      expect(f.url).toBe(BANDAI_PREFIX + f.name)
    }

    expect(lafan).toMatchObject({ source: 'lafan1', license: 'CC BY-NC-ND 4.0', nc: true, exportable: false })
    expect(lafan.download).toEqual({
      user_supplied: true,
      accepts: ['.zip'],
      instructions: 'Download lafan1.zip from the LaFAN1 page (lafan1 folder) and choose it here.'
    })
    expect(cmu).toMatchObject({
      source: 'cmu',
      license: 'CMU Graphics Lab Motion Capture Database terms',
      license_url: 'http://mocap.cs.cmu.edu/faqs.php',
      nc: false,
      exportable: true,
      include: null
    })
    expect('user_supplied' in cmu.download && cmu.download.accepts).toEqual(['.zip', 'folder'])
  })

  it('has the converter_version of engine/mpm/convert/clipio.py', async () => {
    const clipio = readFileSync(path.join(REPO, 'engine', 'mpm', 'convert', 'clipio.py'), 'utf8')
    const m = /^CONVERTER_VERSION\s*=\s*(\d+)/m.exec(clipio)
    expect(m).not.toBeNull()
    expect((await loadPacks(PACKS_JSON)).converter_version).toBe(Number(m![1]))
  })
})

describe('packs.json schema', () => {
  it('accepts a minimal pack', () => {
    expect(parsePacks(minimal()).packs[0].id).toBe('demo')
  })

  it('rejects bad entries', () => {
    expect(() => parsePacks(minimal({}, { url: 'http://example.com/a.bvh' }))).toThrow(/https/)
    expect(() => parsePacks(minimal({}, { sha256: 'ABC' }))).toThrow(/hex/)
    expect(() => parsePacks(minimal({}, { name: '../a.bvh' }))).toThrow(/file name/)
    expect(() => parsePacks(minimal({}, { name: '..' }))).toThrow(/file name/)
    expect(() => parsePacks(minimal({}, { size: 0 }))).toThrow()
    expect(() => parsePacks(minimal({ id: 'mine' }))).toThrow(/reserved/)
    expect(() => parsePacks(minimal({ id: 'Bad Id' }))).toThrow()
    expect(() => parsePacks(minimal({ license: 'CC BY-NC-ND 4.0', exportable: true }))).toThrow(/ND/)
    expect(() => parsePacks({ ...minimal(), schema: 'mpm.packs/2' })).toThrow()
    const twice = minimal()
    twice.packs.push({ ...twice.packs[0] })
    expect(() => parsePacks(twice)).toThrow(/duplicate pack id/)
    const dupFiles = minimal()
    const files = (dupFiles.packs[0].download as { files: unknown[] }).files
    files.push({ ...(files[0] as object) })
    expect(() => parsePacks(dupFiles)).toThrow(/duplicate file/)
  })

  it('allows loopback http only for tests', () => {
    const local = minimal({}, { url: 'http://127.0.0.1:8080/a.bvh' })
    expect(() => parsePacks(local)).toThrow(/https/)
    expect(parsePacks(local, { allowLoopbackHttp: true }).packs).toHaveLength(1)
    expect(isAllowedUrl('http://example.com/a', true)).toBe(false)
    expect(isAllowedUrl('https://example.com/a')).toBe(true)
    expect(isAllowedUrl('ftp://example.com/a', true)).toBe(false)
    expect(isAllowedUrl('not a url')).toBe(false)
  })
})
