// SPDX-License-Identifier: GPL-3.0-or-later
// Auto-grip (contracts section 11): close each unlocked finger, proximal joint first, in 2 degree steps
// until a finger capsule comes within tol_m of the weapon. Pure: rig, deltas, triangles in, hand pose out.
import { Box3, BufferGeometry, Float32BufferAttribute, Line3, Vector3 } from 'three'
import { MeshBVH } from 'three-mesh-bvh'
import type { Deltas } from '../../shared/fk'
import { canonicalIndex, posedBones } from '../../shared/fk'
import type { FingerName, HandPose } from '../../shared/handPose'
import { applyHandPose, FINGERS } from '../../shared/handPose'
import type { RigJson } from '../../shared/rig'
import { cloneHand } from './hands'

export const STEP_DEG = 2
export const MAX_FLEX: Record<'finger' | 'thumb', [number, number, number]> = {
  finger: [95, 110, 85],
  thumb: [60, 70, 85]
}
/** Capsule radius when rig.json has no radius_m for a finger bone, as a share of the hand width. */
export const RADIUS_FALLBACK = 0.09

/** A BVH over triangles given as xyz triples (9 numbers per triangle), in Blender armature space. */
export function buildBVH(triangles: Float32Array): MeshBVH {
  const g = new BufferGeometry()
  g.setAttribute('position', new Float32BufferAttribute(triangles, 3))
  return new MeshBVH(g)
}

/** A lower bound of the distance between a segment and a box: the gap between their boxes. */
function gap(seg: Box3, box: Box3): number {
  const dx = Math.max(0, box.min.x - seg.max.x, seg.min.x - box.max.x)
  const dy = Math.max(0, box.min.y - seg.max.y, seg.min.y - box.max.y)
  const dz = Math.max(0, box.min.z - seg.max.z, seg.min.z - box.max.z)
  return Math.hypot(dx, dy, dz)
}

/** Shortest distance from segment a-b to the triangles (0 when it crosses one). */
export function segmentDistance(bvh: MeshBVH, a: Vector3, b: Vector3): number {
  const seg = new Line3(a, b)
  const segBox = new Box3().setFromPoints([a, b])
  const mid = a.clone().add(b).multiplyScalar(0.5)
  let best = Infinity
  bvh.shapecast({
    boundsTraverseOrder: (box) => box.distanceToPoint(mid),
    intersectsBounds: (box) => gap(segBox, box) < best,
    intersectsTriangle: (tri) => {
      const d = tri.closestPointToSegment(seg)
      if (d < best) best = d
      return best <= 0
    }
  })
  return best
}

export interface Capsule {
  bone: number
  a: Vector3
  b: Vector3
  r: number
}

/** The capsules of one finger's bones (.01, .02, .03), posed with `deltas`. */
export function fingerCapsules(rig: RigJson, deltas: Deltas, side: 'L' | 'R', finger: FingerName): Capsule[] {
  const ci = canonicalIndex(rig)
  const pb = posedBones(rig, deltas)
  const width = rig.hands[side]?.hand_width ?? 0.08
  const out: Capsule[] = []
  for (let k = 1; k <= 3; k++) {
    const i = ci.get(`${finger}.0${k}.${side}`)
    if (i === undefined) break
    out.push({ bone: i, a: pb[i].head.clone(), b: pb[i].tail.clone(), r: rig.bones[i].radius_m ?? RADIUS_FALLBACK * width })
  }
  return out
}

/** Capsule-to-mesh distance (axis distance minus radius; negative inside). */
export function capsuleDistance(bvh: MeshBVH, c: Capsule): number {
  return segmentDistance(bvh, c.a, c.b) - c.r
}

export interface FingerGrip {
  /** Within tol_m of the weapon. */
  touching: boolean
  /** Not touching with every joint at its maximum flex. */
  maxed: boolean
  /** Smallest capsule distance of the finger, metres. */
  minDistance_m: number
  locked: boolean
}

export interface AutoGripInput {
  rig: RigJson
  /** The composed deltas without this side's hand pose (contracts section 13: hand poses come last). */
  base: Deltas
  side: 'L' | 'R'
  /** The starting hand pose (usually a preset). */
  start: HandPose
  locked: string[]
  bvh: MeshBVH
  tolM: number
}

export interface AutoGripResult {
  pose: HandPose
  fingers: Record<FingerName, FingerGrip>
}

/** Smallest capsule distance of a finger's bones from joint k (0-based) outwards. */
function distalDistance(input: AutoGripInput, pose: HandPose, finger: FingerName, from: number): number {
  const deltas = applyHandPose(input.rig, input.base, input.side, pose)
  const caps = fingerCapsules(input.rig, deltas, input.side, finger).slice(from)
  return Math.min(...caps.map((c) => capsuleDistance(input.bvh, c)))
}

/**
 * Per unlocked finger, joints proximal -> distal: flex grows in 2 degree steps up to the joint's maximum
 * and stops as soon as that bone's capsule, or any capsule distal to it, is within tol_m; then the next
 * joint. Spread and roll stay as in the start pose; locked fingers are left alone.
 */
export function autoGrip(input: AutoGripInput): AutoGripResult {
  const { rig, side, tolM } = input
  const pose = cloneHand(input.start)
  pose.name = `${input.start.name}+grip`
  const fingers = {} as Record<FingerName, FingerGrip>
  for (const f of FINGERS) {
    const locked = input.locked.includes(f)
    const caps = fingerCapsules(rig, input.base, side, f).length
    const max = MAX_FLEX[f === 'thumb' ? 'thumb' : 'finger']
    if (!locked) {
      for (let k = 0; k < caps; k++) {
        let d = distalDistance(input, pose, f, k)
        while (d > tolM && pose.fingers[f].flex[k] < max[k]) {
          pose.fingers[f].flex[k] = Math.min(pose.fingers[f].flex[k] + STEP_DEG, max[k])
          d = distalDistance(input, pose, f, k)
        }
      }
    }
    const d = caps ? distalDistance(input, pose, f, 0) : Infinity
    const atMax = pose.fingers[f].flex.slice(0, caps).every((v, k) => v >= max[k])
    fingers[f] = { touching: d <= tolM, maxed: d > tolM && atMax, minDistance_m: d, locked }
  }
  return { pose, fingers }
}
