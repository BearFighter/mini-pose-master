// SPDX-License-Identifier: GPL-3.0-or-later
// Test helper: rig.json objects (contracts section 8) built in code, with no mesh, no file and no
// Blender. The only input is a table of marker positions of a standard human; everything else follows
// from the contracts:
//   markers --(section 4, src/shared/derive.ts)--> 68 joints --(resources/skeleton.json)--> 53 bones
//   in Blender's bone order, rest rotations by the roll rule of engine/mpm/rig/build.py
//   build_armature (section 3).
// `autoRig()` is what the engine's rig job writes for an auto rig; `importedRig()` is an imported-style
// rig (Mixamo bone names, extra unmapped bones, arbitrary rolls, another bone order) on the same joints.
// Nothing here says how a mesh behaves: skinning, markers detection and baking are tested in the engine
// on real kits.
import { createHash } from 'node:crypto'
import { Matrix4, Quaternion, Vector3 } from 'three'
import type { QuatWXYZ, Vec3 } from '../../../src/shared/coords'
import { deriveJoints, handFrame, type DerivedHandFrame } from '../../../src/shared/derive'
import type { HandFrame, RigBone, RigJson } from '../../../src/shared/rig'
import { BONES, JOINTS, type Bone } from '../../../src/shared/skeleton'

type Side = 'L' | 'R'
type Hands = Record<Side, DerivedHandFrame>
type FingerName = 'thumb' | 'index' | 'middle' | 'ring' | 'pinky'

const SIDES: readonly Side[] = ['L', 'R']
const FINGER_NAMES: readonly FingerName[] = ['thumb', 'index', 'middle', 'ring', 'pinky']

// ---------------------------------------------------------------------------------------------------
// The marker table
// ---------------------------------------------------------------------------------------------------

/** How far the arms of the table hang below horizontal (degrees). */
export const ARM_DROP_DEG = 50

/**
 * Editable markers of a standard 1.80 m human in an A-pose: the centre line and the LEFT side.
 * Blender space (contracts section 2): metres, Z up, the figure faces -Y, its left is +X, feet on z = 0.
 * The right side is the mirror image (x -> -x), see MARKERS_APOSE.
 *
 * Proportions are the usual anthropometric shares of the standing height H = 1.80 m (Drillis and
 * Contini): ankle 0.039 H, knee 0.285 H, hip joint 0.530 H and shoulder joint 0.818 H above the floor;
 * upper arm 0.186 H (0.335 m), forearm 0.146 H (0.263 m), hand 0.108 H (0.194 m, wrist to the tip of
 * the middle finger, of which 0.100 m to the knuckle). The knuckle row is 0.064 m wide, the thumb
 * 0.105 m long and abducted about 40 degrees, the fingers almost straight and slightly fanned.
 * The arm hangs ARM_DROP_DEG below horizontal, palm toward the thigh; the elbow sits a little behind
 * the shoulder-wrist line (a bend of about 5.5 degrees), so the arm is not exactly planar.
 * Numbers are rounded to 0.1 mm.
 */
const CENTRE_AND_LEFT: Record<string, Vec3> = {
  pelvis: [0, 0.006, 0.985],
  chest: [0, 0.018, 1.3],
  neck: [0, 0.024, 1.53],
  head: [0, 0.01, 1.61],
  head_top: [0, 0.004, 1.8],
  shoulder_L: [0.195, 0.022, 1.4724],
  elbow_L: [0.4101, 0.034, 1.2161],
  wrist_L: [0.5787, 0.018, 1.0152],
  thumb_0_L: [0.5903, -0.009, 0.9857],
  thumb_tip_L: [0.6161, -0.0721, 0.9059],
  index_0_L: [0.6419, -0.007, 0.9429],
  index_tip_L: [0.6925, -0.0112, 0.8747],
  middle_0_L: [0.6453, 0.016, 0.9405],
  middle_tip_L: [0.7013, 0.016, 0.865],
  ring_0_L: [0.6413, 0.037, 0.9437],
  ring_tip_L: [0.6931, 0.0405, 0.8738],
  pinky_0_L: [0.6346, 0.056, 0.9485],
  pinky_tip_L: [0.6749, 0.0621, 0.8941],
  hip_L: [0.09, 0.004, 0.954],
  knee_L: [0.098, -0.008, 0.513],
  ankle_L: [0.104, 0.028, 0.0702],
  toe_L: [0.118, -0.182, 0.012]
}

/** Markers that turn with the arm (about the shoulder) when the pose changes between A and T. */
const ARM_MARKERS: readonly string[] = [
  'elbow',
  'wrist',
  ...FINGER_NAMES.flatMap((f) => [`${f}_0`, `${f}_tip`])
]

/** No -0 (JSON has none, and toEqual tells it from 0). */
const round = (x: number, digits: number): number => {
  const k = 10 ** digits
  return Math.round(x * k) / k + 0
}
const mirrorX = (p: Vec3): Vec3 => [-p[0] + 0, p[1], p[2]]

function bothSides(left: Record<string, Vec3>): Record<string, Vec3> {
  const out: Record<string, Vec3> = {}
  for (const j of JOINTS) {
    if (!j.editable) continue
    const own = left[j.name]
    const mirrored = left[j.name.replace(/_R$/, '_L')]
    if (own) out[j.name] = [...own]
    else if (j.name.endsWith('_R') && mirrored) out[j.name] = mirrorX(mirrored)
    else throw new Error(`marker table has no ${j.name}`)
  }
  return out
}

/**
 * The 39 editable markers of the standard figure in its A-pose (arms ARM_DROP_DEG below horizontal),
 * in skeleton.json order. Exactly symmetric in x.
 */
export const MARKERS_APOSE: Readonly<Record<string, Vec3>> = Object.freeze(bothSides(CENTRE_AND_LEFT))

export interface MarkerOptions {
  /** Arms horizontal: the arm markers are turned ARM_DROP_DEG up about the shoulders. Default: A-pose. */
  tpose?: boolean
}

/** A fresh copy of the standard markers, in the A-pose or (tpose) with the arms horizontal. */
export function standardMarkers(opts: MarkerOptions = {}): Record<string, Vec3> {
  if (!opts.tpose) return bothSides(CENTRE_AND_LEFT)
  // Turn the left arm up about the axis through the shoulder that points along Y (the figure's
  // front-back axis); the right arm is the mirror image, so the result stays symmetric.
  const a = (ARM_DROP_DEG * Math.PI) / 180
  const [c, s] = [Math.cos(a), Math.sin(a)]
  const sh = CENTRE_AND_LEFT.shoulder_L
  const left: Record<string, Vec3> = { ...CENTRE_AND_LEFT }
  for (const m of ARM_MARKERS) {
    const [x, y, z] = CENTRE_AND_LEFT[`${m}_L`]
    const [dx, dz] = [x - sh[0], z - sh[2]]
    left[`${m}_L`] = [round(sh[0] + dx * c - dz * s, 7), y, round(sh[2] + dx * s + dz * c, 7)]
  }
  return bothSides(left)
}

// ---------------------------------------------------------------------------------------------------
// The roll rule
// ---------------------------------------------------------------------------------------------------

const isFingerBone = (name: string): boolean => (FINGER_NAMES as readonly string[]).includes(name.split('.')[0])
const sideOf = (name: string): Side | null => (name.endsWith('.L') ? 'L' : name.endsWith('.R') ? 'R' : null)

/**
 * Rest rotation of a bone from head to tail whose local Z is `align` made perpendicular to the bone:
 * Y = normalize(tail - head), Z = normalize(align - Y * dot(align, Y)), X = Y x Z.
 * This is what Blender's EditBone.align_roll(align) produces (bone.matrix_local).
 */
export function alignedRest(head: Vector3, tail: Vector3, align: Vector3): Quaternion {
  const y = tail.clone().sub(head)
  if (y.lengthSq() < 1e-20) throw new Error('bone has no length')
  y.normalize()
  const z = align.clone().sub(y.clone().multiplyScalar(align.dot(y)))
  if (z.lengthSq() < 1e-12) throw new Error('roll target is parallel to the bone')
  z.normalize()
  const x = new Vector3().crossVectors(y, z)
  return new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(x, y, z)).normalize()
}

/**
 * The vector build_armature passes to align_roll for a canonical bone: the side's palm normal for
 * finger and grip bones (contracts section 3); for every other bone -Y, or +Z when the bone itself
 * runs along Y (|d.y| > 0.9, the feet and toes).
 */
export function rollTarget(canonical: string | null, head: Vector3, tail: Vector3, hands: Hands): Vector3 {
  const side = canonical ? sideOf(canonical) : null
  if (canonical && side && (isFingerBone(canonical) || canonical.startsWith('grip.'))) return hands[side].palm_normal.clone()
  const d = tail.clone().sub(head).normalize()
  return Math.abs(d.y) > 0.9 ? new Vector3(0, 0, 1) : new Vector3(0, -1, 0)
}

/** Quaternion -> JSON [w, x, y, z] as export.py writes it: w >= 0, 9 decimals. */
function restQ(q: Quaternion): QuatWXYZ {
  const s = q.w < 0 ? -1 : 1
  return [round(s * q.w, 9), round(s * q.x, 9), round(s * q.y, 9), round(s * q.z, 9)]
}

// ---------------------------------------------------------------------------------------------------
// Shared pieces of both rigs
// ---------------------------------------------------------------------------------------------------

/**
 * radius_m of the finger bones (.01, .02, .03). On a real rig this is measured on the mesh (the mean
 * distance from the bone axis to the vertices weighted > 0.5 to the bone); here it is the radius of an
 * adult finger at each phalanx.
 */
export const FINGER_RADIUS_M: Readonly<Record<FingerName, readonly [number, number, number]>> = {
  thumb: [0.011, 0.0105, 0.01],
  index: [0.009, 0.0085, 0.008],
  middle: [0.0095, 0.009, 0.0085],
  ring: [0.009, 0.0085, 0.008],
  pinky: [0.0085, 0.008, 0.008]
}

function fingerRadius(canonical: string | null): number | null {
  if (!canonical || !isFingerBone(canonical)) return null
  const [finger, k] = canonical.split('.')
  return FINGER_RADIUS_M[finger as FingerName][Number(k) - 1]
}

const vec = (p: Vec3 | Vector3): Vector3 => (p instanceof Vector3 ? p.clone() : new Vector3(p[0], p[1], p[2]))
const pos = (v: Vector3): Vec3 => [round(v.x, 7), round(v.y, 7), round(v.z, 7)]

function toVectors(joints: Record<string, Vec3 | Vector3>): Record<string, Vector3> {
  const J: Record<string, Vector3> = {}
  for (const j of JOINTS) {
    const p = joints[j.name]
    if (!p) throw new Error(`joint ${j.name} is missing`)
    J[j.name] = vec(p)
  }
  return J
}

function handsJson(hands: Hands): RigJson['hands'] {
  const one = (f: DerivedHandFrame): HandFrame => ({
    hand_axis: pos(f.hand_axis),
    lateral: pos(f.lateral),
    palm_normal: pos(f.palm_normal),
    hand_width: round(f.hand_width, 7),
    grip_axis: pos(f.grip_axis)
  })
  return { L: one(hands.L), R: one(hands.R) }
}

/** All 68 joints in skeleton.json order, rounded to 7 decimals like export.py. */
function jointsJson(J: Record<string, Vector3>): Record<string, Vec3> {
  return Object.fromEntries(JOINTS.map((j) => [j.name, pos(J[j.name])]))
}

/** Same recipe as export.py (sha1 of the bone table), without the weights it also hashes. */
function rigHash(kind: string, bones: RigBone[]): string {
  const key = JSON.stringify([kind, ...bones.map((b) => [b.name, b.parent, b.head, b.tail, b.rest_q])])
  return createHash('sha1').update(key).digest('hex')
}

export interface RigOptions extends MarkerOptions {
  /** Markers to use instead of the standard table (all 39 editable ones). */
  markers?: Record<string, Vec3>
}

/** All 68 joints (contracts section 4) of the standard figure, or of the given markers. */
export function standardJoints(opts: RigOptions = {}): Record<string, Vec3> {
  return jointsJson(deriveJoints(opts.markers ?? standardMarkers(opts)))
}

// ---------------------------------------------------------------------------------------------------
// Auto rig
// ---------------------------------------------------------------------------------------------------

/**
 * The canonical bones in the order Blender lists them (`armature.bones`, which export.py writes to
 * rig.json): depth first, every bone followed by its whole subtree, children in skeleton.json order.
 * So the left arm down to its fingers and socket comes before shoulder.R, and the legs come last.
 * This is NOT the skeleton.json order (BONES), where L and R alternate.
 */
export function blenderBoneOrder(): Bone[] {
  const out: Bone[] = []
  const visit = (b: Bone): void => {
    out.push(b)
    for (const c of BONES) if (c.parent === b.name) visit(c)
  }
  for (const b of BONES) if (b.parent === null) visit(b)
  return out
}

/**
 * The rig.json of an auto rig whose 68 joints are `joints`: the 53 canonical bones in Blender's bone
 * order, rest rotations by the build_armature roll rule, bone index = glTF node index, no meshes.
 * height_m and floor_z describe the mesh on a real rig; here the figure stands on z = 0 and is as tall
 * as its head_top joint unless told otherwise.
 */
export function autoRigFromJoints(
  joints: Record<string, Vec3 | Vector3>,
  opts: { height_m?: number; floor_z?: number } = {}
): RigJson {
  const J = toVectors(joints)
  const hands: Hands = { L: handFrame(J, 'L'), R: handFrame(J, 'R') }
  const order = blenderBoneOrder()
  const index = new Map(order.map((b, i) => [b.name, i]))
  const bones: RigBone[] = order.map((b, i) => {
    const head = J[b.head]
    const tail = J[b.tail]
    return {
      index: i,
      name: b.name,
      canonical: b.name,
      parent: b.parent === null ? -1 : (index.get(b.parent) as number),
      head: pos(head),
      tail: pos(tail),
      rest_q: restQ(alignedRest(head, tail, rollTarget(b.name, head, tail, hands))),
      deform: b.deform,
      gltf_node: i,
      radius_m: fingerRadius(b.name)
    }
  })
  const floor = opts.floor_z ?? 0
  return {
    schema: 'mpm.rig/1',
    hash: rigHash('auto', bones),
    kind: 'auto',
    height_m: opts.height_m ?? round(J.head_top.z - floor, 6),
    floor_z: floor,
    bones,
    meshes: [],
    joints: jointsJson(J),
    hands: handsJson(hands)
  }
}

/** The canonical auto rig of the standard figure (A-pose; `tpose` for horizontal arms). A new object each call. */
export function autoRig(opts: RigOptions = {}): RigJson {
  return autoRigFromJoints(deriveJoints(opts.markers ?? standardMarkers(opts)))
}

// ---------------------------------------------------------------------------------------------------
// Imported rig
// ---------------------------------------------------------------------------------------------------

/** Prefix of the imported rig's own bones. */
export const IMPORTED_PREFIX = 'mixamorig:'

/**
 * Roll (degrees) added about bone i's own axis on the imported rig, on top of the roll build_armature
 * would give the bone: 25..335, so the result is never the canonical roll.
 */
const importedRoll = (i: number): number => 25 + ((i * 47) % 311)

const MIXAMO_FINGER: Record<FingerName, string> = { thumb: 'Thumb', index: 'Index', middle: 'Middle', ring: 'Ring', pinky: 'Pinky' }
const lerp = (a: Vector3, b: Vector3, t: number): Vector3 => a.clone().lerp(b, t)
/** The point `t` bone lengths past b on the line a -> b. */
const beyond = (a: Vector3, b: Vector3, t = 1): Vector3 => b.clone().add(b.clone().sub(a).multiplyScalar(t))

/**
 * An imported (pre-rigged) character as rig_imported writes it (contracts section 8, "Imported rigs"),
 * on the joints of the standard figure. T-pose by default, as such assets usually are; `tpose: false`
 * gives the A-pose.
 *
 * What differs from the auto rig, on purpose:
 * - Mixamo bone names; `canonical` is what the engine's suggest_mapping gives for these names.
 * - 17 extra bones with canonical null: `Spine1` inside the spine chain (between spine and chest), a
 *   forearm twist bone per side (a leaf under the forearm), end bones (`HeadTop_End`, `*Toe_End`, the
 *   fourth bone of every finger) and a prop bone under the right hand.
 * - Another bone order (Blender's depth-first order with the legs first: parents still come before
 *   their children, as in every armature Blender lists), and glTF node indices that are not the bone
 *   indices (reversed).
 * - Tails that stop short of the next canonical joint (hips, spine, chest, hands) while keeping the
 *   canonical direction.
 * - Rest rotations with an arbitrary roll about each bone's own axis (importedRoll), so nothing can rely
 *   on the contracts section 3 roll. Only the two sockets `mpm_grip.L/R`, which the engine itself adds,
 *   have the canonical roll (local Z = palm normal).
 * - `joints` and `hands` are the ones rig_imported derives from the mapped bones; because the mapped
 *   bones start on the standard joints, they equal the auto rig's.
 */
export function importedRig(opts: RigOptions = {}): RigJson {
  const J = deriveJoints(opts.markers ?? standardMarkers({ tpose: opts.tpose ?? true }))
  const hands: Hands = { L: handFrame(J, 'L'), R: handFrame(J, 'R') }
  interface Spec {
    name: string
    canonical: string | null
    parent: string | null
    head: Vector3
    tail: Vector3
    deform: boolean
    socket: boolean
  }
  const specs: Spec[] = []
  const add = (name: string, canonical: string | null, parent: string | null, head: Vector3, tail: Vector3, deform = true): string => {
    const full = IMPORTED_PREFIX + name
    specs.push({ name: full, canonical, parent, head, tail, deform, socket: false })
    return full
  }

  const hips = add('Hips', 'hips', null, J.pelvis, lerp(J.pelvis, J.spine0, 0.9))
  for (const s of SIDES) {
    const S = s === 'L' ? 'Left' : 'Right'
    const thigh = add(`${S}UpLeg`, `thigh.${s}`, hips, J[`hip_${s}`], J[`knee_${s}`])
    const shin = add(`${S}Leg`, `shin.${s}`, thigh, J[`knee_${s}`], J[`ankle_${s}`])
    const foot = add(`${S}Foot`, `foot.${s}`, shin, J[`ankle_${s}`], J[`ball_${s}`])
    const toe = add(`${S}ToeBase`, `toe.${s}`, foot, J[`ball_${s}`], J[`toe_${s}`])
    add(`${S}Toe_End`, null, toe, J[`toe_${s}`], beyond(J[`ball_${s}`], J[`toe_${s}`]))
  }
  const mid = lerp(J.spine0, J.chest, 0.5)
  const spine = add('Spine', 'spine', hips, J.spine0, mid)
  const spine1 = add('Spine1', null, spine, mid, J.chest)
  const chest = add('Spine2', 'chest', spine1, J.chest, lerp(J.chest, J.neck, 0.95))
  const neck = add('Neck', 'neck', chest, J.neck, J.head)
  const head = add('Head', 'head', neck, J.head, J.head_top)
  add('HeadTop_End', null, head, J.head_top, beyond(J.head, J.head_top, 0.5))
  for (const s of SIDES) {
    const S = s === 'L' ? 'Left' : 'Right'
    const shoulder = add(`${S}Shoulder`, `shoulder.${s}`, chest, J[`clav_${s}`], J[`shoulder_${s}`])
    const upper = add(`${S}Arm`, `upper_arm.${s}`, shoulder, J[`shoulder_${s}`], J[`elbow_${s}`])
    const fore = add(`${S}ForeArm`, `forearm.${s}`, upper, J[`elbow_${s}`], J[`wrist_${s}`])
    add(`${S}ForeArmTwist`, null, fore, lerp(J[`elbow_${s}`], J[`wrist_${s}`], 0.5), J[`wrist_${s}`])
    const hand = add(`${S}Hand`, `hand.${s}`, fore, J[`wrist_${s}`], lerp(J[`wrist_${s}`], J[`middle_0_${s}`], 0.85))
    for (const f of FINGER_NAMES) {
      const chain = [`${f}_0_${s}`, `${f}_1_${s}`, `${f}_2_${s}`, `${f}_tip_${s}`].map((k) => J[k])
      let parent = hand
      for (let k = 1; k <= 3; k++) parent = add(`${S}Hand${MIXAMO_FINGER[f]}${k}`, `${f}.0${k}.${s}`, parent, chain[k - 1], chain[k])
      add(`${S}Hand${MIXAMO_FINGER[f]}4`, null, parent, chain[3], beyond(chain[2], chain[3]))
    }
    if (s === 'R') add('RightHandProp', null, hand, J.grip_R, J.grip_R.clone().add(new Vector3(0, -0.1, 0)), false)
    // rig_imported adds the socket last, so it is the hand's last child
    specs.push({ name: `mpm_grip.${s}`, canonical: `grip.${s}`, parent: hand, head: J[`grip_${s}`], tail: J[`grip_tip_${s}`], deform: false, socket: true })
  }

  const index = new Map(specs.map((b, i) => [b.name, i]))
  const bones: RigBone[] = specs.map((b, i) => {
    let rest: Quaternion
    if (b.socket) rest = alignedRest(b.head, b.tail, hands[sideOf(b.canonical as string) as Side].palm_normal)
    else {
      const roll = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), (importedRoll(i) * Math.PI) / 180)
      rest = alignedRest(b.head, b.tail, rollTarget(b.canonical, b.head, b.tail, hands)).multiply(roll)
    }
    return {
      index: i,
      name: b.name,
      canonical: b.canonical,
      parent: b.parent === null ? -1 : (index.get(b.parent) as number),
      head: pos(b.head),
      tail: pos(b.tail),
      rest_q: restQ(rest),
      deform: b.deform,
      gltf_node: specs.length - 1 - i,
      radius_m: fingerRadius(b.canonical)
    }
  })
  return {
    schema: 'mpm.rig/1',
    hash: rigHash('imported', bones),
    kind: 'imported',
    height_m: round(J.head_top.z, 6),
    floor_z: 0,
    bones,
    meshes: [],
    joints: jointsJson(J),
    hands: handsJson(hands)
  }
}
