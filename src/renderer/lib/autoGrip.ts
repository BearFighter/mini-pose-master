// SPDX-License-Identifier: GPL-3.0-or-later
// Auto-grip (contracts section 11): close each unlocked finger, proximal joint first, in 2 degree steps
// until a finger capsule touches the weapon (d <= 0). A finger whose preset already overlaps deeper than
// pen_m starts again from flex [0, 0, 0]. Pure: rig, deltas, triangles in, hand pose out.
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
  /** Some capsule of the finger has d <= 0 (it touches or slightly overlaps the weapon). */
  touching: boolean
  /** Not touching with every joint at its maximum flex. */
  maxed: boolean
  /** Smallest capsule distance d of the finger, metres (negative: overlap). */
  minDistance_m: number
  locked: boolean
  /** The preset overlapped deeper than pen_m, so the finger started again from flex [0, 0, 0]. */
  reopened: boolean
  /**
   * Smallest d where the closing started (the preset, or flex [0, 0, 0] when reopened). A finger that
   * starts clear (d > 0) ends overlapping by at most one step; one that already overlaps there keeps it.
   */
  startDistance_m: number
  /** The finger's largest travel in one 2 degree step (its length times the step angle): the deepest overlap a touching finger can end with. */
  stepTravel_m: number
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
  /** Millimetres per model metre at the bake scale (contracts section 14). */
  unitMm: number
}

export interface AutoGripResult {
  pose: HandPose
  fingers: Record<FingerName, FingerGrip>
}

/** pen_m: the overlap a preset may start with before the finger is reopened, 0.05 mm at print scale. */
export function penetrationLimit(unitMm: number): number {
  return 0.05 / unitMm
}

/** A finger's largest one-step travel: its straight length (all its bones) times 2 degrees in radians. */
export function stepTravel(rig: RigJson, side: 'L' | 'R', finger: FingerName): number {
  const caps = fingerCapsules(rig, {}, side, finger)
  const length = caps.reduce((n, c) => n + c.a.distanceTo(c.b), 0)
  return (length * STEP_DEG * Math.PI) / 180
}

/** Capsule distances of a finger's bones (.01, .02, .03) with this hand pose. */
function fingerDistances(input: AutoGripInput, pose: HandPose, finger: FingerName): number[] {
  const deltas = applyHandPose(input.rig, input.base, input.side, pose)
  return fingerCapsules(input.rig, deltas, input.side, finger).map((c) => capsuleDistance(input.bvh, c))
}

/**
 * Per unlocked finger: if any capsule starts deeper than pen_m, the finger starts again from flex
 * [0, 0, 0] (spread and roll kept). Then joints proximal -> distal: flex grows in 2 degree steps up to the
 * joint's maximum and stops at the first step where that bone's capsule, or a distal one, has d <= 0;
 * then the next joint. Locked fingers are left alone.
 */
export function autoGrip(input: AutoGripInput): AutoGripResult {
  const { rig, side } = input
  const pen = penetrationLimit(input.unitMm)
  const pose = cloneHand(input.start)
  pose.name = `${input.start.name}+grip`
  const fingers = {} as Record<FingerName, FingerGrip>
  for (const f of FINGERS) {
    const locked = input.locked.includes(f)
    const max = MAX_FLEX[f === 'thumb' ? 'thumb' : 'finger']
    let ds = fingerDistances(input, pose, f)
    const caps = ds.length
    let reopened = false
    let start = caps ? Math.min(...ds) : Infinity
    if (!locked && caps > 0) {
      if (start < -pen) {
        pose.fingers[f].flex = [0, 0, 0]
        reopened = true
        start = Math.min(...fingerDistances(input, pose, f))
      }
      for (let k = 0; k < caps; k++) {
        let d = Math.min(...fingerDistances(input, pose, f).slice(k))
        while (d > 0 && pose.fingers[f].flex[k] < max[k]) {
          pose.fingers[f].flex[k] = Math.min(pose.fingers[f].flex[k] + STEP_DEG, max[k])
          d = Math.min(...fingerDistances(input, pose, f).slice(k))
        }
      }
      ds = fingerDistances(input, pose, f)
    }
    const d = caps ? Math.min(...ds) : Infinity
    const atMax = pose.fingers[f].flex.slice(0, caps).every((v, k) => v >= max[k])
    fingers[f] = {
      touching: d <= 0,
      maxed: d > 0 && atMax,
      minDistance_m: d,
      locked,
      reopened,
      startDistance_m: start,
      stepTravel_m: stepTravel(rig, side, f)
    }
  }
  return { pose, fingers }
}
