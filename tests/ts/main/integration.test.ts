// SPDX-License-Identifier: GPL-3.0-or-later
// Runs the real `import` job through JobRunner. Skipped unless MPM_BLENDER points at a Blender 5.2.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { BlenderManager, probe } from '../../../electron/main/blender'
import { JobRunner } from '../../../electron/main/jobs'
import * as projects from '../../../electron/main/projects'
import { EventLog, REPO, removeDir, tempDir } from './helpers'

const BLENDER = process.env.MPM_BLENDER
const APOSE = path.join(REPO, 'fixtures', 'out', 'apose', 'apose.fbx')

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

  it('runs the import job on fixtures/out/apose/apose.fbx', async () => {
    if (!existsSync(APOSE)) throw new Error(`fixture missing: ${APOSE} (run fixtures/generate.py with Blender)`)
    const { dir } = await projects.create({ name: 'Integration', parentDir: root }, '0.0.1')
    const imported = await projects.importModel({ dir, file: APOSE })
    expect(imported.copied[0]).toBe('source/apose.fbx')
    expect(imported.copied).toEqual(expect.arrayContaining(['source/apose_d.png', 'source/apose_n.png', 'source/apose.mtl']))
    const copied = imported.project.source!.file

    const log = new EventLog()
    const runner = new JobRunner({
      engineDir: path.join(REPO, 'engine'),
      resolveBlender: () => BLENDER!,
      emit: log.emit
    })
    const jobId = runner.run({ dir, type: 'import', args: { file: copied } })
    const end = await log.terminal(jobId, 170_000)
    if (end.kind !== 'result') throw new Error(`import failed: ${JSON.stringify(end.payload)}`)

    const result = end.payload as { height_m: number; has_armature: boolean; tri_count: number }
    expect(Math.abs(result.height_m - 1.815)).toBeLessThan(0.005)
    expect(result.has_armature).toBe(false)
    expect(result.tri_count).toBeGreaterThan(0)

    const events = log.forJob(jobId)
    const stages = events.flatMap((e) => (e.kind === 'progress' ? [e.payload.stage] : []))
    expect(stages).toEqual(expect.arrayContaining(['import', 'normalise', 'save']))
    expect(events[events.length - 1]).toBe(end)
    expect(existsSync(path.join(dir, 'rig', 'scene.blend'))).toBe(true)
    expect(readFileSync(path.join(dir, 'cache', 'jobs', `${jobId}.log`), 'utf8')).toContain('@@result ')
  }, 180_000)
})
