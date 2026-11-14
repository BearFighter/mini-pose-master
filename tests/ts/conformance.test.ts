// SPDX-License-Identifier: GPL-3.0-or-later
// WP5: what three.js shows must equal what Blender bakes. Golden data comes from
// `blender -b --factory-startup --python-exit-code 1 -P tests/engine/make_golden.py`.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { bindRig } from '../../src/shared/rig'
import type { LoadedGltf, RigJson } from '../../src/shared/rig'
import { applyPoseState, posedHeadsBlender } from '../../src/shared/poseMath'
import { skinnedPositionsBlender } from '../../src/shared/skinSample'
import type { QuatWXYZ, Vec3 } from '../../src/shared/coords'

const GOLDEN = join(__dirname, '..', 'golden')
const CASES = ['auto_apose', 'imported_mixamo']
const REQUIRE = process.env.MPM_REQUIRE_GOLDEN === '1'

interface Pose {
  deltas: Record<string, QuatWXYZ>
  root_offset: Vec3
}
interface Expected {
  meshes: Record<string, { indices: number[]; positions: Vec3[] }>
  bones: { index: number; head: Vec3; tail: Vec3 }[]
}

function load(path: string): Promise<LoadedGltf> {
  const buf = readFileSync(path)
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  return new Promise((resolve, reject) => {
    new GLTFLoader().parse(ab, '', (g) => resolve(g as unknown as LoadedGltf), reject)
  })
}

const dist = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

const present = CASES.every((c) => existsSync(join(GOLDEN, c, 'expected.json')))
if (!present && !REQUIRE) {
  console.warn('conformance: tests/golden missing - skipped (run tests/engine/make_golden.py with Blender)')
}

describe.skipIf(!present && !REQUIRE)('GLB <-> three conformance (contracts s5, s7)', () => {
  for (const name of CASES) {
    it(`${name}: bones within 1e-5 m and skinned vertices within 1e-4 m for every pose`, async () => {
      const dir = join(GOLDEN, name)
      expect(existsSync(join(dir, 'expected.json')), `golden case ${name} missing`).toBe(true)
      const rig = JSON.parse(readFileSync(join(dir, 'rig.json'), 'utf8')) as RigJson
      const poses = JSON.parse(readFileSync(join(dir, 'poses.json'), 'utf8')) as Pose[]
      const expected = JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8')) as Expected[]
      const bound = bindRig(await load(join(dir, 'rig_noimg.glb')), rig)
      const report: string[] = []
      poses.forEach((pose, k) => {
        applyPoseState(bound, pose.deltas, pose.root_offset)
        const heads = posedHeadsBlender(bound)
        let worstHead = 0
        expected[k].bones.forEach((eb) => (worstHead = Math.max(worstHead, dist(heads[eb.index], eb.head))))
        let worstVert = 0
        for (const [mesh, e] of Object.entries(expected[k].meshes)) {
          const got = skinnedPositionsBlender(bound, mesh, e.indices)
          got.forEach((p, j) => (worstVert = Math.max(worstVert, dist(p, e.positions[j]))))
        }
        report.push(`pose ${k}: head ${worstHead.toExponential(2)} m, vertex ${worstVert.toExponential(2)} m`)
        expect(worstHead, `${name} pose ${k} bone heads`).toBeLessThan(1e-5)
        expect(worstVert, `${name} pose ${k} skinned vertices`).toBeLessThan(1e-4)
      })
      console.log(`${name}: ${report.join('; ')}`)
    })
  }
})
