// SPDX-License-Identifier: GPL-3.0-or-later
// Auto-grip (contracts section 11) on the fixture rig: a synthetic handle, and the fixture sword placed
// in the right hand by its truth grip.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Line3, Vector3 } from 'three'
import { ExtendedTriangle } from 'three-mesh-bvh'
import { describe, expect, it } from 'vitest'
import { autoGrip, buildBVH, capsuleDistance, fingerCapsules, MAX_FLEX, segmentDistance, type AutoGripResult } from '../../../src/renderer/lib/autoGrip'
import { handFromPreset, presetByName } from '../../../src/renderer/lib/hands'
import { gripRotation, gripTolerance, translationFor, weaponTriangles } from '../../../src/renderer/lib/weapons'
import { DEFAULT_BAKE } from '../../../src/renderer/store/bake'
import { composePose } from '../../../src/shared/composePose'
import type { Deltas } from '../../../src/shared/fk'
import type { HandPose } from '../../../src/shared/handPose'
import { applyHandPose, FINGERS } from '../../../src/shared/handPose'
import type { RigJson } from '../../../src/shared/rig'
import { attachFrame, weaponMatrix } from '../../../src/shared/weaponPose'
import { loadGlbMeshes } from './glbGeometry'

const RIG = JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'rig_auto_apose.json'), 'utf8')) as RigJson
const SWORD = join(__dirname, '..', '..', '..', 'fixtures', 'out', 'sword', 'sword.glb')
const TOL = gripTolerance(RIG, DEFAULT_BAKE) // 0.2 mm at 40 mm height
// The right hand in front of the body (as in weaponPose.test.ts), no hand pose yet.
const BASE: Deltas = composePose(RIG, { mirrored: false, planted: false, edits: [{ kind: 'reach', side: 'R', target: [-0.03, -0.3, 1.2] }] }, null).deltas
const SWORD_PRESET = handFromPreset(presetByName('sword')!)

/** A closed cylinder (radius r, length len) along the grip socket's axis, centred on the socket. */
function handle(r: number, len: number, segments = 32): Float32Array {
  const A = attachFrame(RIG, BASE, 'grip.R')!
  const p = (theta: number, y: number) => new Vector3(r * Math.cos(theta), y, r * Math.sin(theta)).applyMatrix4(A)
  const out: number[] = []
  const tri = (a: Vector3, b: Vector3, c: Vector3) => out.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z)
  const top = new Vector3(0, len / 2, 0).applyMatrix4(A)
  const bottom = new Vector3(0, -len / 2, 0).applyMatrix4(A)
  for (let k = 0; k < segments; k++) {
    const t0 = (2 * Math.PI * k) / segments
    const t1 = (2 * Math.PI * (k + 1)) / segments
    const [a, b, c, d] = [p(t0, -len / 2), p(t1, -len / 2), p(t1, len / 2), p(t0, len / 2)]
    tri(a, b, c)
    tri(a, c, d)
    tri(d, c, top)
    tri(b, a, bottom)
  }
  return new Float32Array(out)
}

/** The section 11 checks shared by both cases. */
function checkGrip(result: AutoGripResult, start: HandPose, locked: string[], triangles: Float32Array): void {
  const bvh = buildBVH(triangles)
  const deltas = applyHandPose(RIG, BASE, 'R', result.pose)
  for (const f of FINGERS) {
    const caps = fingerCapsules(RIG, deltas, 'R', f)
    const ds = caps.map((c) => capsuleDistance(bvh, c))
    // no deep penetration
    expect(Math.min(...ds), `${f} penetrates`).toBeGreaterThanOrEqual(-TOL)
    const r = result.fingers[f]
    if (locked.includes(f)) {
      expect(result.pose.fingers[f]).toEqual(start.fingers[f])
      expect(r.locked).toBe(true)
      continue
    }
    expect(r.touching || r.maxed, `${f}: touching or at max flex`).toBe(true)
    if (r.touching) expect(r.minDistance_m).toBeLessThanOrEqual(TOL)
    expect(r.minDistance_m).toBeCloseTo(Math.min(...ds), 9)
    // spread and roll stay from the preset; flex only grows, in 2 degree steps, up to the maximum
    expect(result.pose.fingers[f].spread).toBe(start.fingers[f].spread)
    expect(result.pose.fingers[f].roll).toBe(start.fingers[f].roll)
    const max = MAX_FLEX[f === 'thumb' ? 'thumb' : 'finger']
    result.pose.fingers[f].flex.forEach((v, k) => {
      expect(v).toBeGreaterThanOrEqual(start.fingers[f].flex[k])
      expect(v).toBeLessThanOrEqual(Math.max(max[k], start.fingers[f].flex[k]))
      // stop rule: every joint is at its maximum, or its capsule chain (that bone and the distal ones) is within tol_m
      expect(v >= max[k] || Math.min(...ds.slice(k)) <= TOL, `${f} joint ${k + 1} stopped early`).toBe(true)
    })
  }
}

describe('segment distance', () => {
  it('matches a brute-force search over the triangles', () => {
    const tris = handle(0.012, 0.25, 12)
    const bvh = buildBVH(tris)
    const t = new ExtendedTriangle()
    const A = attachFrame(RIG, BASE, 'grip.R')!
    for (const [a, b] of [
      [new Vector3(0.03, -0.05, 0.02), new Vector3(0.05, 0.08, 0.01)],
      [new Vector3(-0.004, 0, 0), new Vector3(0.004, 0.01, 0)],
      [new Vector3(0.2, 0.2, 0.2), new Vector3(0.25, 0.1, 0.3)]
    ]) {
      a.applyMatrix4(A)
      b.applyMatrix4(A)
      let brute = Infinity
      for (let i = 0; i < tris.length; i += 9) {
        t.set(new Vector3(tris[i], tris[i + 1], tris[i + 2]), new Vector3(tris[i + 3], tris[i + 4], tris[i + 5]), new Vector3(tris[i + 6], tris[i + 7], tris[i + 8]))
        t.needsUpdate = true
        brute = Math.min(brute, t.closestPointToSegment(new Line3(a, b)))
      }
      expect(segmentDistance(bvh, a, b)).toBeCloseTo(brute, 9)
    }
  })
})

describe('auto-grip', () => {
  it('closes the fingers onto a handle; locked fingers stay; the stop rule holds', () => {
    const tris = handle(0.014, 0.3)
    const bvh = buildBVH(tris)
    const t0 = performance.now()
    const free = autoGrip({ rig: RIG, base: BASE, side: 'R', start: SWORD_PRESET, locked: [], bvh, tolM: TOL })
    const ms = performance.now() - t0
    console.log(`[timing] auto-grip (handle, ${tris.length / 9} triangles): ${ms.toFixed(1)} ms`)
    checkGrip(free, SWORD_PRESET, [], tris)
    expect(FINGERS.filter((f) => free.fingers[f].touching).length).toBeGreaterThanOrEqual(3)
    const kept = autoGrip({ rig: RIG, base: BASE, side: 'R', start: SWORD_PRESET, locked: ['index'], bvh, tolM: TOL })
    checkGrip(kept, SWORD_PRESET, ['index'], tris)
  })

  it('leaves a finger already within tol_m alone and stops at the maximum without a weapon nearby', () => {
    const far = handle(0.014, 0.3).map((v, i) => v + (i % 3 === 0 ? 5 : 0)) // the handle 5 m away
    const r = autoGrip({ rig: RIG, base: BASE, side: 'R', start: SWORD_PRESET, locked: [], bvh: buildBVH(far), tolM: TOL })
    for (const f of FINGERS) {
      expect(r.fingers[f].maxed).toBe(true)
      expect(r.pose.fingers[f].flex).toEqual(MAX_FLEX[f === 'thumb' ? 'thumb' : 'finger'].map((m, k) => Math.max(m, SWORD_PRESET.fingers[f].flex[k])))
    }
  })
})

describe.skipIf(!existsSync(SWORD))('auto-grip on the fixture sword', () => {
  it('grips the sword placed by its truth grip', () => {
    const truth = JSON.parse(readFileSync(SWORD.replace(/\.glb$/, '.truth.json'), 'utf8')).grips.main
    const q = gripRotation(truth.axis, truth.palm_normal)
    const offset = { t: translationFor(q, 1, truth.point), q, s: 1 }
    const Mb = weaponMatrix(RIG, BASE, { attach_bone: 'grip.R', offset })!
    // the truth grip point lands on the socket
    const socket = attachFrame(RIG, BASE, 'grip.R')!
    const gp = new Vector3(...(truth.point as [number, number, number])).applyMatrix4(Mb)
    expect(gp.distanceTo(new Vector3().setFromMatrixPosition(socket))).toBeLessThan(1e-9)
    const tris = weaponTriangles(loadGlbMeshes(SWORD), Mb)
    const bvh = buildBVH(tris)
    const t0 = performance.now()
    const r = autoGrip({ rig: RIG, base: BASE, side: 'R', start: SWORD_PRESET, locked: [], bvh, tolM: TOL })
    const ms = performance.now() - t0
    console.log(`[timing] auto-grip (fixture sword, ${tris.length / 9} triangles): ${ms.toFixed(1)} ms`)
    console.log(`[auto-grip] sword: ${FINGERS.map((f) => `${f} ${r.fingers[f].touching ? 'touching' : r.fingers[f].maxed ? 'max' : '?'} ${(r.fingers[f].minDistance_m * 1000).toFixed(1)}mm`).join(', ')}`)
    checkGrip(r, SWORD_PRESET, [], tris)
  })
})
