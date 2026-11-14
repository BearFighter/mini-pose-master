// SPDX-License-Identifier: GPL-3.0-or-later
// rig.json types (contracts section 8) and binding a loaded rig.glb to it by glTF node index
// (contracts section 3: never by three.js names, which GLTFLoader sanitises).
import { Matrix4, Object3D, Quaternion, SkinnedMesh, Vector3 } from 'three'
import type { QuatWXYZ, Vec3 } from './coords'

export interface RigBone {
  index: number
  name: string
  canonical: string | null
  parent: number
  head: Vec3
  tail: Vec3
  rest_q: QuatWXYZ
  deform: boolean
  gltf_node: number
  radius_m: number | null
}

export interface HandFrame {
  hand_axis: Vec3
  lateral: Vec3
  palm_normal: Vec3
  hand_width: number
  grip_axis?: Vec3
}

export interface RigJson {
  schema: 'mpm.rig/1'
  hash: string
  kind: 'auto' | 'imported'
  height_m: number
  floor_z: number
  bones: RigBone[]
  meshes: { name: string; gltf_node: number; vertices: number; normal_map: boolean }[]
  joints: Record<string, Vec3>
  hands: { L: HandFrame | null; R: HandFrame | null }
}

/** Minimal shape of a GLTFLoader result that we rely on. */
export interface LoadedGltf {
  scene: Object3D
  parser: { associations: Map<Object3D, { nodes?: number; meshes?: number; primitives?: number }> }
}

export interface BoundRig {
  rig: RigJson
  armature: Object3D
  /** bones[i] is the Object3D of rig.bones[i]. */
  bones: Object3D[]
  /** rest local quaternion (relative to the parent object) as loaded */
  restLocal: Quaternion[]
  /** rest local position as loaded */
  restPos: Vector3[]
  /** rest rotation relative to the armature node, three space (R_rest_b) */
  restArm: Quaternion[]
  /** parents before children */
  order: number[]
  meshes: Record<string, SkinnedMesh[]>
  hipsIndex: number | null
}

function topoOrder(rig: RigJson): number[] {
  const out: number[] = []
  const seen = new Set<number>()
  const visit = (i: number): void => {
    if (seen.has(i)) return
    const p = rig.bones[i].parent
    if (p >= 0) visit(p)
    seen.add(i)
    out.push(i)
  }
  rig.bones.forEach((_b, i) => visit(i))
  return out
}

export function bindRig(gltf: LoadedGltf, rig: RigJson): BoundRig {
  const byNode = new Map<number, Object3D>()
  for (const [obj, assoc] of gltf.parser.associations) {
    if (assoc && typeof assoc.nodes === 'number' && !byNode.has(assoc.nodes)) byNode.set(assoc.nodes, obj)
  }
  const bones = rig.bones.map((b) => {
    const o = byNode.get(b.gltf_node)
    if (!o) throw new Error(`rig.glb has no node ${b.gltf_node} for bone ${b.name}`)
    return o
  })
  const root = rig.bones.findIndex((b) => b.parent < 0)
  const armature = bones[root].parent
  if (!armature) throw new Error('root bone has no parent node (armature)')
  gltf.scene.updateMatrixWorld(true)
  const armInv = new Matrix4().copy(armature.matrixWorld).invert()
  const restArm = bones.map((o) => {
    const m = new Matrix4().multiplyMatrices(armInv, o.matrixWorld)
    const q = new Quaternion()
    m.decompose(new Vector3(), q, new Vector3())
    return q.normalize()
  })
  const meshes: Record<string, SkinnedMesh[]> = {}
  for (const m of rig.meshes) {
    const o = byNode.get(m.gltf_node)
    if (!o) throw new Error(`rig.glb has no node ${m.gltf_node} for mesh ${m.name}`)
    const list: SkinnedMesh[] = []
    o.traverse((c) => {
      if ((c as SkinnedMesh).isSkinnedMesh) list.push(c as SkinnedMesh)
    })
    meshes[m.name] = list
  }
  const hips = rig.bones.findIndex((b) => b.canonical === 'hips')
  return {
    rig,
    armature,
    bones,
    restLocal: bones.map((o) => o.quaternion.clone()),
    restPos: bones.map((o) => o.position.clone()),
    restArm,
    order: topoOrder(rig),
    meshes,
    hipsIndex: hips >= 0 ? hips : null
  }
}
