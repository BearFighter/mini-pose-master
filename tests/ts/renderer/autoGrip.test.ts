// SPDX-License-Identifier: GPL-3.0-or-later
// Auto-grip (contracts section 11) on the standard skeleton (tests/ts/helpers/skeletonRig.ts, finger radii
// from its table): a synthetic handle, and the generated sword placed in the right hand by its truth grip
// (skipped when fixtures/out/sword is absent).
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Line3, Vector3 } from 'three'
import { ExtendedTriangle } from 'three-mesh-bvh'
import { describe, expect, it } from 'vitest'
import { autoGrip, buildBVH, capsuleDistance, fingerCapsules, MAX_FLEX, penetrationLimit, segmentDistance, stepTravel, type AutoGripResult } from '../../../src/renderer/lib/autoGrip'
import { handFromPreset, presetByName } from '../../../src/renderer/lib/hands'
import { gripRotation, translationFor, unitMm, weaponTriangles } from '../../../src/renderer/lib/weapons'
import { DEFAULT_BAKE } from '../../../src/renderer/store/bake'
import { composePose } from '../../../src/shared/composePose'
import type { Deltas } from '../../../src/shared/fk'
import type { HandPose } from '../../../src/shared/handPose'
import { applyHandPose, FINGERS } from '../../../src/shared/handPose'
import { attachFrame, weaponMatrix } from '../../../src/shared/weaponPose'
import { autoRig } from '../helpers/skeletonRig'
import { loadGlbMeshes } from './glbGeometry'

const RIG = autoRig()
const SWORD = join(__dirname, '..', '..', '..', 'fixtures', 'out', 'sword', 'sword.glb')
const UNIT = unitMm(RIG, DEFAULT_BAKE) // mm per model metre at 40 mm height
const PEN = penetrationLimit(UNIT) // 0.05 mm at print scale
// The right hand in front of the body (as in weaponPose.test.ts), no hand pose yet.
const BASE: Deltas = composePose(RIG, { mirrored: false, planted: false, edits: [{ kind: 'reach', side: 'R', target: [-0.03, -0.3, 1.2] }] }, null).deltas
const SWORD_PRESET = handFromPreset(presetByName('sword')!)
const FIST_PRESET = handFromPreset(presetByName('fist')!)
const EPS = 1e-9

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

/** The section 11 checks shared by every case. */
function checkGrip(result: AutoGripResult, start: HandPose, locked: string[], triangles: Float32Array): void {
  const bvh = buildBVH(triangles)
  const deltas = applyHandPose(RIG, BASE, 'R', result.pose)
  for (const f of FINGERS) {
    const caps = fingerCapsules(RIG, deltas, 'R', f)
    const ds = caps.map((c) => capsuleDistance(bvh, c))
    const r = result.fingers[f]
    if (locked.includes(f)) {
      expect(result.pose.fingers[f]).toEqual(start.fingers[f])
      expect(r.locked).toBe(true)
      continue
    }
    expect(r.minDistance_m).toBeCloseTo(Math.min(...ds), 9)
    expect(r.stepTravel_m).toBeCloseTo(stepTravel(RIG, 'R', f), 12)
    // touching, overlapping by at most one step's travel (or by what it already overlapped where the closing
    // started: the preset, or flex 0 when reopened); or not touching at max flex
    if (r.touching) {
      expect(r.minDistance_m).toBeLessThanOrEqual(0)
      const bound = Math.min(-r.stepTravel_m, r.startDistance_m)
      expect(r.minDistance_m, `${f} overlaps deeper than one step`).toBeGreaterThanOrEqual(bound - EPS)
      if (r.startDistance_m > 0) expect(r.minDistance_m).toBeGreaterThanOrEqual(-r.stepTravel_m - EPS)
    } else expect(r.maxed, `${f}: touching or at max flex`).toBe(true)
    // a finger only starts over from 0 when the preset was deeper than pen_m
    if (r.reopened) expect(Math.min(...fingerCapsules(RIG, applyHandPose(RIG, BASE, 'R', start), 'R', f).map((c) => capsuleDistance(bvh, c)))).toBeLessThan(-PEN)
    // spread and roll stay from the preset; flex grows from the preset (or from 0 when reopened) up to the maximum
    expect(result.pose.fingers[f].spread).toBe(start.fingers[f].spread)
    expect(result.pose.fingers[f].roll).toBe(start.fingers[f].roll)
    const from = r.reopened ? [0, 0, 0] : start.fingers[f].flex
    const max = MAX_FLEX[f === 'thumb' ? 'thumb' : 'finger']
    result.pose.fingers[f].flex.forEach((v, k) => {
      expect(v).toBeGreaterThanOrEqual(from[k])
      expect(v).toBeLessThanOrEqual(Math.max(max[k], from[k]))
      // stop rule: every joint is at its maximum, or its chain (that bone and the distal ones) touches
      expect(v >= max[k] || Math.min(...ds.slice(k)) <= 0, `${f} joint ${k + 1} stopped early`).toBe(true)
    })
  }
}

/** The per-finger numbers, in mm on the model and at print scale. */
function describeGrip(r: AutoGripResult): string {
  return FINGERS.map((f) => {
    const g = r.fingers[f]
    const state = g.touching ? 'touching' : g.maxed ? 'max flex' : '?'
    const reopened = g.reopened ? ` (reopened, d at flex 0 = ${(g.startDistance_m * 1000).toFixed(2)}mm)` : ''
    return `${f} ${state}${reopened} d=${(g.minDistance_m * 1000).toFixed(2)}mm model / ${(g.minDistance_m * UNIT).toFixed(3)}mm print, step ${(g.stepTravel_m * 1000).toFixed(2)}mm`
  }).join('; ')
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
    const free = autoGrip({ rig: RIG, base: BASE, side: 'R', start: SWORD_PRESET, locked: [], bvh, unitMm: UNIT })
    const ms = performance.now() - t0
    console.log(`[timing] auto-grip (handle, ${tris.length / 9} triangles): ${ms.toFixed(1)} ms`)
    console.log(`[auto-grip] handle: ${describeGrip(free)}`)
    checkGrip(free, SWORD_PRESET, [], tris)
    expect(FINGERS.filter((f) => free.fingers[f].touching).length).toBeGreaterThanOrEqual(3)
    const kept = autoGrip({ rig: RIG, base: BASE, side: 'R', start: SWORD_PRESET, locked: ['index'], bvh, unitMm: UNIT })
    checkGrip(kept, SWORD_PRESET, ['index'], tris)
  })

  it('reopens a finger whose preset starts deeper than pen_m, then closes it to a touch', () => {
    const tris = handle(0.012, 0.3)
    const bvh = buildBVH(tris)
    // the fist preset curls the fingers right through a thin handle
    const deltas = applyHandPose(RIG, BASE, 'R', FIST_PRESET)
    const startDepth = Math.min(...fingerCapsules(RIG, deltas, 'R', 'middle').map((c) => capsuleDistance(bvh, c)))
    expect(startDepth).toBeLessThan(-PEN)
    const r = autoGrip({ rig: RIG, base: BASE, side: 'R', start: FIST_PRESET, locked: [], bvh, unitMm: UNIT })
    console.log(`[auto-grip] fist on a thin handle: ${describeGrip(r)}`)
    expect(r.fingers.middle.reopened).toBe(true)
    expect(r.fingers.middle.touching).toBe(true)
    expect(r.fingers.middle.startDistance_m).toBeGreaterThan(0) // clear when open...
    expect(r.fingers.middle.minDistance_m).toBeGreaterThanOrEqual(-r.fingers.middle.stepTravel_m) // ...so within one step
    checkGrip(r, FIST_PRESET, [], tris)
    // a locked finger is never reopened
    const kept = autoGrip({ rig: RIG, base: BASE, side: 'R', start: FIST_PRESET, locked: ['middle'], bvh, unitMm: UNIT })
    expect(kept.fingers.middle.reopened).toBe(false)
    expect(kept.pose.fingers.middle).toEqual(FIST_PRESET.fingers.middle)
  })

  it('stops at the maximum without a weapon nearby', () => {
    const far = handle(0.014, 0.3).map((v, i) => v + (i % 3 === 0 ? 5 : 0)) // the handle 5 m away
    const r = autoGrip({ rig: RIG, base: BASE, side: 'R', start: SWORD_PRESET, locked: [], bvh: buildBVH(far), unitMm: UNIT })
    for (const f of FINGERS) {
      expect(r.fingers[f].maxed).toBe(true)
      expect(r.fingers[f].reopened).toBe(false)
      expect(r.pose.fingers[f].flex).toEqual(MAX_FLEX[f === 'thumb' ? 'thumb' : 'finger'].map((m, k) => Math.max(m, SWORD_PRESET.fingers[f].flex[k])))
    }
  })

  it('pen_m is 0.05 mm at print scale; a step travels the finger length times 2 degrees', () => {
    expect(PEN).toBeCloseTo(0.05 / (40 / RIG.height_m), 12)
    let len = 0
    for (const k of [1, 2, 3]) {
      const b = RIG.bones.find((x) => x.canonical === `index.0${k}.R`)!
      len += Math.hypot(b.tail[0] - b.head[0], b.tail[1] - b.head[1], b.tail[2] - b.head[2])
    }
    expect(stepTravel(RIG, 'R', 'index')).toBeCloseTo((len * 2 * Math.PI) / 180, 9)
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
    const r = autoGrip({ rig: RIG, base: BASE, side: 'R', start: SWORD_PRESET, locked: [], bvh, unitMm: UNIT })
    const ms = performance.now() - t0
    console.log(`[timing] auto-grip (fixture sword, ${tris.length / 9} triangles): ${ms.toFixed(1)} ms`)
    console.log(`[auto-grip] sword: ${describeGrip(r)}`)
    checkGrip(r, SWORD_PRESET, [], tris)
  })
})
