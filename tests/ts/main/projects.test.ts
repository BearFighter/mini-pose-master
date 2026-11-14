// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import * as projects from '../../../electron/main/projects'
import { removeDir, tempDir } from './helpers'

/** Writes `files` (relative path → content) under `base`, creating folders. */
function writeTree(base: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(base, ...rel.split('/'))
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, content)
  }
}

/** Every file under `dir` as a sorted list of `/`-separated relative paths. */
function listTree(dir: string, prefix = ''): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...listTree(path.join(dir, entry.name), rel))
    else out.push(rel)
  }
  return out.sort()
}

describe('mtlTextureFile', () => {
  it('skips texture options and keeps names with spaces', () => {
    expect(projects.mtlTextureFile('skin.png')).toBe('skin.png')
    expect(projects.mtlTextureFile('-s 1 1 1 -o 0 0 0 my skin.png')).toBe('my skin.png')
    expect(projects.mtlTextureFile('-bm 0.5 -clamp on n.png')).toBe('n.png')
    expect(projects.mtlTextureFile('-o 0.5 tex.png')).toBe('tex.png')
    expect(projects.mtlTextureFile('-mm 0 1 -imfchan r d.tga')).toBe('d.tga')
    expect(projects.mtlTextureFile('-s 1 1')).toBeNull()
  })
})

describe('sanitizeName', () => {
  it('makes names safe for every file system', () => {
    expect(projects.sanitizeName('Hero')).toBe('Hero')
    expect(projects.sanitizeName('  My Knight  ')).toBe('My Knight')
    expect(projects.sanitizeName('AC/DC: "Live" <1>?*|\\')).toBe('AC_DC_ _Live_ _1_____')
    expect(projects.sanitizeName('..hidden')).toBe('hidden')
    expect(projects.sanitizeName('trailing dots...')).toBe('trailing dots')
    expect(projects.sanitizeName('Orc.mposer')).toBe('Orc')
    expect(projects.sanitizeName('con')).toBe('_con')
    expect(projects.sanitizeName('LPT1.txt')).toBe('_LPT1.txt')
    expect(projects.sanitizeName('tab\there')).toBe('tab_here')
    expect(projects.sanitizeName('Héroïne')).toBe('Héroïne')
    expect(Array.from(projects.sanitizeName('x'.repeat(300)))).toHaveLength(100)
  })

  it('rejects names with nothing left', () => {
    expect(() => projects.sanitizeName('')).toThrow(/empty/)
    expect(() => projects.sanitizeName('  ... ')).toThrow(/empty/)
  })
})

describe('projects', () => {
  let root: string
  beforeEach(() => {
    root = tempDir('projects')
  })
  afterEach(() => removeDir(root))

  it('create makes the folder layout and the .mposer file', async () => {
    const { dir, project } = await projects.create({ name: 'Space: Marine', parentDir: root }, '1.2.3')
    expect(dir).toBe(path.join(root, 'Space_ Marine'))
    expect(readdirSync(dir).sort()).toEqual(['Space_ Marine.mposer', 'cache', 'exports', 'rig', 'source', 'weapons'])
    const expected = {
      schemaVersion: 1,
      app: 'Mini Pose Master',
      appVersion: '1.2.3',
      source: null,
      rig: null,
      pose: null,
      hands: null,
      weapons: [],
      bake: {
        schema: 'mpm.bake/1',
        scale: { mode: 'height_mm', height_mm: 40 },
        detail: 2.0,
        flatten_mm: 0.5,
        base_mm: 0,
        min_wall_mm: 0.6,
        weapons_separate: false,
        max_tris: 2000000
      }
    }
    expect(project).toEqual(expected)
    expect(JSON.parse(readFileSync(path.join(dir, 'Space_ Marine.mposer'), 'utf8'))).toEqual(expected)
  })

  it('create refuses an existing non-empty folder but accepts an empty one', async () => {
    await projects.create({ name: 'Hero', parentDir: root }, '0.0.1')
    await expect(projects.create({ name: 'Hero', parentDir: root }, '0.0.1')).rejects.toThrow(/already exists/)
    mkdirSync(path.join(root, 'Empty'))
    await expect(projects.create({ name: 'Empty', parentDir: root }, '0.0.1')).resolves.toMatchObject({ dir: path.join(root, 'Empty') })
    await expect(projects.create({ name: 'X', parentDir: path.join(root, 'nope') }, '0.0.1')).rejects.toThrow(/not found/)
  })

  it('open accepts the .mposer file and the folder; save round-trips atomically', async () => {
    const created = await projects.create({ name: 'Hero', parentDir: root }, '0.0.1')
    const file = path.join(created.dir, 'Hero.mposer')

    const byFile = await projects.open(file)
    const byFolder = await projects.open(created.dir)
    expect(byFile).toEqual({ dir: created.dir, project: created.project })
    expect(byFolder).toEqual(byFile)

    const edited = {
      ...created.project,
      pose: { schema: 'mpm.pose/1', rig_hash: 'abc', root_offset: [0, 0, 0.1], deltas: { '0': [1, 0, 0, 0] } },
      weapons: [{ id: 'w1', file: 'weapons/rifle.glb' }]
    }
    await projects.save({ dir: created.dir, project: edited })
    expect((await projects.open(created.dir)).project).toEqual(edited)
    expect(readdirSync(created.dir).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('open finds a renamed .mposer when it is the only one in the folder', async () => {
    const dir = path.join(root, 'Renamed')
    mkdirSync(dir)
    writeFileSync(path.join(dir, 'Old Name.mposer'), JSON.stringify(projects.newProject('0.0.1')))
    expect((await projects.open(dir)).dir).toBe(dir)
    await projects.save({ dir, project: { ...projects.newProject('0.0.1'), hands: { L: null } } })
    expect(JSON.parse(readFileSync(path.join(dir, 'Old Name.mposer'), 'utf8')).hands).toEqual({ L: null })
  })

  it('open validates the file', async () => {
    const dir = path.join(root, 'Bad')
    mkdirSync(dir)
    const file = path.join(dir, 'Bad.mposer')
    await expect(projects.open(dir)).rejects.toThrow(/No \.mposer/)
    writeFileSync(file, '{ broken')
    await expect(projects.open(file)).rejects.toThrow(/not a valid project/)
    writeFileSync(file, JSON.stringify({ app: 'Mini Pose Master' }))
    await expect(projects.open(file)).rejects.toThrow(/schemaVersion/)
    writeFileSync(file, JSON.stringify({ ...projects.newProject('9.0.0'), schemaVersion: 2 }))
    await expect(projects.open(file)).rejects.toThrow(/newer version/)
    writeFileSync(path.join(dir, 'notes.txt'), 'x')
    await expect(projects.open(path.join(dir, 'notes.txt'))).rejects.toThrow(/Not a \.mposer/)
    await expect(projects.save({ dir, project: { schemaVersion: 2 } })).rejects.toThrow(/schemaVersion/)
  })

  it('importModel copies the model, its images, textures/, same-stem files and <stem>.fbm/', async () => {
    const { dir } = await projects.create({ name: 'Hero', parentDir: root }, '0.0.1')
    const models = path.join(root, 'downloads', 'hero pack')
    const files: Record<string, string> = {
      'hero.fbx': 'FBX',
      'hero_d.png': 'PNG',
      'hero_n.PNG': 'PNG2',
      'spec.tga': 'TGA',
      'hero.txt': 'same stem',
      'Hero.json': 'same stem, other case',
      'hero.fbm/skin.png': 'FBM1',
      'hero.fbm/sub/data.bin': 'FBM2',
      'textures/skin/body.tif': 'TIF',
      'textures/detail.exr': 'EXR',
      'notes.txt': 'skip',
      'villain.fbx': 'skip',
      'villain.fbm/x.png': 'skip',
      'hero.fbx.bak': 'skip (its stem is hero.fbx)',
      'textures/readme.txt': 'skip',
      'other/b.png': 'skip'
    }
    writeTree(models, files)

    const result = await projects.importModel({ dir, file: path.join(models, 'hero.fbx') })
    const expected = [
      'hero.fbx',
      'hero_d.png',
      'hero_n.PNG',
      'spec.tga',
      'hero.txt',
      'Hero.json',
      'hero.fbm/skin.png',
      'hero.fbm/sub/data.bin',
      'textures/skin/body.tif',
      'textures/detail.exr'
    ]
    expect(result.copied[0]).toBe('source/hero.fbx')
    expect([...result.copied].sort()).toEqual(expected.map((rel) => `source/${rel}`).sort())
    expect(result.skipped).toEqual([])
    expect(listTree(path.join(dir, 'source'))).toEqual([...expected].sort())
    for (const rel of expected) expect(readFileSync(path.join(dir, 'source', rel), 'utf8')).toBe(files[rel])
    expect(result.project.source).toEqual({ file: 'source/hero.fbx', orientation: null })
    expect((await projects.open(dir)).project).toEqual(result.project)
  })

  it('importModel follows OBJ mtllib files and their textures, skipping anything outside the folder', async () => {
    const { dir } = await projects.create({ name: 'Hero', parentDir: root }, '0.0.1')
    const models = path.join(root, 'models')
    const pack = path.join(models, 'pack')
    writeTree(pack, {
      'hero.obj': ['# exported', 'mtllib mats/hero mats.mtl', 'mtllib extra.mtl ../outside.mtl', 'o Body', 'v 0 0 0'].join('\r\n'),
      'mats/hero mats.mtl': [
        'newmtl skin',
        'Kd 1 1 1',
        'map_Kd -s 1 1 1 -o 0 0 0 ../maps/skin diffuse.png',
        'map_Bump -bm 0.5 ..\\maps\\skin_n.png',
        'bump ../maps/bump.png',
        'norm ../maps/norm.png',
        'map_Ks ../../shared/spec.png',
        'map_d C:\\abs\\alpha.png',
        'map_Ns ../maps/missing.png'
      ].join('\n'),
      'extra.mtl': 'newmtl cloth\nmap_Kd sub/cloth.dds\n',
      'maps/skin diffuse.png': 'D',
      'maps/skin_n.png': 'N',
      'maps/bump.png': 'B',
      'maps/norm.png': 'M',
      'maps/unused.png': 'not referenced',
      'sub/cloth.dds': 'C'
    })
    writeTree(models, { 'outside.mtl': 'newmtl x\nmap_Kd pack/maps/unused.png\n', 'shared/spec.png': 'S' })

    const result = await projects.importModel({ dir, file: path.join(pack, 'hero.obj') })
    const expected = [
      'hero.obj',
      'mats/hero mats.mtl',
      'extra.mtl',
      'maps/skin diffuse.png',
      'maps/skin_n.png',
      'maps/bump.png',
      'maps/norm.png',
      'sub/cloth.dds'
    ]
    expect(listTree(path.join(dir, 'source'))).toEqual([...expected].sort())
    expect([...result.copied].sort()).toEqual(expected.map((rel) => `source/${rel}`).sort())
    expect([...result.skipped].sort()).toEqual(['../../shared/spec.png', '../maps/missing.png', '../outside.mtl', 'C:\\abs\\alpha.png'].sort())
    expect(readFileSync(path.join(dir, 'source', 'maps', 'skin diffuse.png'), 'utf8')).toBe('D')
  })

  it('importModel copies the relative buffer and image URIs of a .gltf', async () => {
    const { dir } = await projects.create({ name: 'Hero', parentDir: root }, '0.0.1')
    const models = path.join(root, 'models')
    const pack = path.join(models, 'pack')
    const gltf = {
      asset: { version: '2.0' },
      buffers: [
        { uri: 'geometry/mesh.bin', byteLength: 3 },
        { uri: 'data:application/octet-stream;base64,AAAA', byteLength: 3 }
      ],
      images: [{ uri: 'tex/base%20color.png' }, { uri: '../outside.png' }, { uri: 'https://example.com/x.png' }, { bufferView: 0, mimeType: 'image/png' }]
    }
    writeTree(pack, {
      'scene.gltf': JSON.stringify(gltf),
      'geometry/mesh.bin': 'BIN',
      'tex/base color.png': 'PNG',
      'tex/unused.png': 'not referenced'
    })
    writeTree(models, { 'outside.png': 'O' })

    const result = await projects.importModel({ dir, file: path.join(pack, 'scene.gltf') })
    expect(listTree(path.join(dir, 'source'))).toEqual(['geometry/mesh.bin', 'scene.gltf', 'tex/base color.png'])
    expect(result.copied).toEqual(['source/scene.gltf', 'source/geometry/mesh.bin', 'source/tex/base color.png'])
    expect(result.skipped).toEqual(['../outside.png', 'https://example.com/x.png'])
  })

  it.skipIf(process.platform === 'win32')('importModel skips links that point outside the model folder', async () => {
    const { dir } = await projects.create({ name: 'Hero', parentDir: root }, '0.0.1')
    const pack = path.join(root, 'models', 'pack')
    writeTree(pack, { 'hero.fbx': 'FBX', 'textures/inside.png': 'I' })
    writeTree(path.join(root, 'models'), { 'secret.png': 'S' })
    symlinkSync(path.join(root, 'models', 'secret.png'), path.join(pack, 'textures', 'link.png'))
    const result = await projects.importModel({ dir, file: path.join(pack, 'hero.fbx') })
    expect(listTree(path.join(dir, 'source'))).toEqual(['hero.fbx', 'textures/inside.png'])
    expect(result.skipped).toEqual(['textures/link.png'])
  })

  it('re-import empties source/ and resets the rig, but leaves rig/ files alone', async () => {
    const { dir } = await projects.create({ name: 'Hero', parentDir: root }, '0.0.1')
    const source = path.join(dir, 'source')
    writeTree(path.join(root, 'a'), { 'hero.fbx': 'H', 'hero_d.png': 'HD', 'textures/t.png': 'T' })
    writeTree(path.join(root, 'b'), { 'villain.obj': 'mtllib villain.mtl\n', 'villain.mtl': 'map_Kd v.png\n', 'v.png': 'V' })
    const withRig = async () => {
      const { project } = await projects.open(dir)
      await projects.save({ dir, project: { ...project, rig: { kind: 'auto', hash: 'abc' } } })
    }

    await projects.importModel({ dir, file: path.join(root, 'a', 'hero.fbx') })
    await withRig()
    writeFileSync(path.join(dir, 'rig', 'rig.json'), '{"keep":true}')
    writeFileSync(path.join(source, 'leftover.txt'), 'old')

    // Re-importing the model from source/ itself keeps its files (and drops everything else).
    const again = await projects.importModel({ dir, file: path.join(source, 'hero.fbx') })
    expect(listTree(source)).toEqual(['hero.fbx', 'hero_d.png', 'textures/t.png'])
    expect(readFileSync(path.join(source, 'hero.fbx'), 'utf8')).toBe('H')
    expect(again.project.rig).toBeNull()

    // A failed import leaves source/ as it was.
    await expect(projects.importModel({ dir, file: path.join(root, 'b', 'missing.obj') })).rejects.toThrow(/not found/)
    expect(listTree(source)).toEqual(['hero.fbx', 'hero_d.png', 'textures/t.png'])

    // Another model replaces everything in source/.
    await withRig()
    const result = await projects.importModel({ dir, file: path.join(root, 'b', 'villain.obj') })
    expect(listTree(source)).toEqual(['v.png', 'villain.mtl', 'villain.obj'])
    expect(result.copied[0]).toBe('source/villain.obj')
    expect(result.project.source).toEqual({ file: 'source/villain.obj', orientation: null })
    expect(result.project.rig).toBeNull()
    expect((await projects.open(dir)).project).toEqual(result.project)
    expect(readFileSync(path.join(dir, 'rig', 'rig.json'), 'utf8')).toBe('{"keep":true}')
    expect(readdirSync(path.join(dir, 'cache'))).toEqual([]) // staging folder removed
  })

  it('addWeapon copies the weapon into weapons/<stem>/, using a free stem when taken', async () => {
    const { dir } = await projects.create({ name: 'Hero', parentDir: root }, '0.0.1')
    writeTree(path.join(root, 'a'), { 'rifle.glb': 'A' })
    writeTree(path.join(root, 'b'), { 'rifle.glb': 'B' })
    expect(await projects.addWeapon({ dir, file: path.join(root, 'a', 'rifle.glb') })).toEqual({
      weaponFile: 'weapons/rifle/rifle.glb',
      copied: ['weapons/rifle/rifle.glb'],
      skipped: []
    })
    expect(await projects.addWeapon({ dir, file: path.join(root, 'b', 'rifle.glb') })).toEqual({
      weaponFile: 'weapons/rifle-2/rifle.glb',
      copied: ['weapons/rifle-2/rifle.glb'],
      skipped: []
    })
    expect(readFileSync(path.join(dir, 'weapons', 'rifle', 'rifle.glb'), 'utf8')).toBe('A')
    expect(readFileSync(path.join(dir, 'weapons', 'rifle-2', 'rifle.glb'), 'utf8')).toBe('B')
    // A weapon already inside weapons/ is used where it is.
    expect(await projects.addWeapon({ dir, file: path.join(dir, 'weapons', 'rifle', 'rifle.glb') })).toEqual({
      weaponFile: 'weapons/rifle/rifle.glb',
      copied: [],
      skipped: []
    })
  })

  it('addWeapon copies FBX and OBJ sidecars like importModel', async () => {
    const { dir } = await projects.create({ name: 'Hero', parentDir: root }, '0.0.1')
    const kit = path.join(root, 'kit')
    writeTree(kit, {
      'sword.fbx': 'FBX',
      'sword_d.png': 'D',
      'sword.fbm/blade.png': 'B',
      'textures/grip.tga': 'G',
      'axe.obj': 'mtllib axe.mtl\nmtllib ../shared.mtl\n',
      'axe.mtl': 'newmtl m\nmap_Kd maps/axe.png\n',
      'maps/axe.png': 'A'
    })
    writeTree(root, { 'shared.mtl': 'newmtl s\n' })

    const sword = await projects.addWeapon({ dir, file: path.join(kit, 'sword.fbx') })
    expect(sword.weaponFile).toBe('weapons/sword/sword.fbx')
    expect([...sword.copied].sort()).toEqual([
      'weapons/sword/sword.fbm/blade.png',
      'weapons/sword/sword.fbx',
      'weapons/sword/sword_d.png',
      'weapons/sword/textures/grip.tga'
    ])
    expect(listTree(path.join(dir, 'weapons', 'sword'))).toEqual(['sword.fbm/blade.png', 'sword.fbx', 'sword_d.png', 'textures/grip.tga'])

    const axe = await projects.addWeapon({ dir, file: path.join(kit, 'axe.obj') })
    expect(axe.weaponFile).toBe('weapons/axe/axe.obj')
    expect(listTree(path.join(dir, 'weapons', 'axe'))).toEqual(['axe.mtl', 'axe.obj', 'maps/axe.png', 'sword_d.png', 'textures/grip.tga'])
    expect(axe.skipped).toEqual(['../shared.mtl'])
  })
})
