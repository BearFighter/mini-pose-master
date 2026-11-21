// SPDX-License-Identifier: GPL-3.0-or-later
// Runs the real `import` job through JobRunner. Skipped unless MPM_BLENDER points at a Blender 5.2.
// This checks the plumbing (copy into the project, job events, files written), on a model that is not a
// figure made for the app: a real kit from the local kit config when there is one, else the generated
// sword. What the engine makes of a model is tested in tests/engine on real kits.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { BlenderManager, probe } from '../../../electron/main/blender'
import { JobRunner } from '../../../electron/main/jobs'
import * as projects from '../../../electron/main/projects'
import { EventLog, REPO, removeDir, tempDir } from './helpers'

const BLENDER = process.env.MPM_BLENDER

/**
 * The model to import: the first kit (by name, dense ones last) of the local kit config that
 * tests/engine/kits.py uses (tests/local/kits.json, or the file named by MPM_KITS; git-ignored), else
 * fixtures/out/sword/sword.fbx (git-ignored, from fixtures/generate.py). Null when neither exists.
 */
function findModel(): string | null {
  const config = process.env.MPM_KITS || path.join(REPO, 'tests', 'local', 'kits.json')
  if (existsSync(config)) {
    const kits = (JSON.parse(readFileSync(config, 'utf8')) as { kits?: Record<string, { model?: string; dense?: boolean }> }).kits ?? {}
    const names = Object.keys(kits).sort((a, b) => Number(!!kits[a].dense) - Number(!!kits[b].dense) || a.localeCompare(b))
    for (const name of names) {
      const model = kits[name].model
      if (model && existsSync(model)) return path.resolve(model)
    }
  }
  const sword = path.join(REPO, 'fixtures', 'out', 'sword', 'sword.fbx')
  return existsSync(sword) ? sword : null
}

const MODEL = BLENDER ? findModel() : null
if (BLENDER && !MODEL) {
  console.warn('integration: no model to import (tests/local/kits.json or fixtures/out/sword/sword.fbx) - the import job test is skipped')
}

describe.skipIf(!BLENDER)('integration with Blender 5.2 (MPM_BLENDER)', () => {
  let root: string
  beforeAll(() => {
    root = tempDir('integration')
  })
  afterAll(() => removeDir(root))

  it('probes MPM_BLENDER as Blender 5.2 and accepts it as the user path', async () => {
    const result = await probe(BLENDER!)
    expect(result.ok).toBe(true)
    expect(result.version).toMatch(/^5\.2\.\d+$/)
    const manager = new BlenderManager({ dataDir: path.join(root, 'data') })
    const status = await manager.setPath(BLENDER!)
    expect(status).toMatchObject({ found: true, path: path.resolve(BLENDER!), version: result.version, source: 'installed' })
  }, 60_000)

  it.skipIf(!MODEL)('runs the import job on a real kit (or the generated sword)', async () => {
    const model = MODEL!
    const { dir } = await projects.create({ name: 'Integration', parentDir: root }, '0.0.1')
    const imported = await projects.importModel({ dir, file: model })
    // the model first, then its companions (which ones is covered in projects.test.ts), all inside source/
    expect(imported.copied[0]).toBe(`source/${path.basename(model)}`)
    for (const rel of imported.copied) {
      expect(rel.startsWith('source/'), rel).toBe(true)
      expect(existsSync(path.join(dir, ...rel.split('/'))), rel).toBe(true)
    }
    const copied = imported.project.source!.file
    expect(copied).toBe(imported.copied[0])

    const log = new EventLog()
    const runner = new JobRunner({
      engineDir: path.join(REPO, 'engine'),
      resolveBlender: () => BLENDER!,
      emit: log.emit
    })
    const jobId = runner.run({ dir, type: 'import', args: { file: copied } })
    const end = await log.terminal(jobId, 170_000)
    if (end.kind !== 'result') throw new Error(`import failed: ${JSON.stringify(end.payload)}`)

    // the numbers depend on the model (the engine tests check them per kit); here: a complete, sane result
    const result = end.payload as { height_m: number; has_armature: boolean; tri_count: number; source_file: string }
    expect(Number.isFinite(result.height_m)).toBe(true)
    expect(result.height_m).toBeGreaterThan(0)
    expect(typeof result.has_armature).toBe('boolean')
    expect(result.tri_count).toBeGreaterThan(0)
    expect(result.source_file).toBe(copied)

    const events = log.forJob(jobId)
    const stages = events.flatMap((e) => (e.kind === 'progress' ? [e.payload.stage] : []))
    expect(stages).toEqual(expect.arrayContaining(['import', 'normalise', 'save']))
    expect(events[events.length - 1]).toBe(end)
    expect(existsSync(path.join(dir, 'rig', 'scene.blend'))).toBe(true)
    expect(readFileSync(path.join(dir, 'cache', 'jobs', `${jobId}.log`), 'utf8')).toContain('@@result ')
  }, 180_000)
})
