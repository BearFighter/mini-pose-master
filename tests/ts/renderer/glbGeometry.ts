// SPDX-License-Identifier: GPL-3.0-or-later
// Test helper: the triangles of a .glb (POSITION + indices of every mesh primitive, node transforms
// applied) as a three.js Mesh, without GLTFLoader (whose image loading needs a DOM).
import { readFileSync } from 'node:fs'
import { BufferAttribute, BufferGeometry, Group, Matrix4, Mesh, Quaternion, Vector3 } from 'three'

interface Gltf {
  nodes?: { mesh?: number; children?: number[]; matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[] }[]
  scenes?: { nodes: number[] }[]
  scene?: number
  meshes: { primitives: { attributes: { POSITION: number }; indices?: number }[] }[]
  accessors: { bufferView: number; byteOffset?: number; componentType: number; count: number; type: string }[]
  bufferViews: { byteOffset?: number; byteLength: number; byteStride?: number }[]
}

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC3: 3 }

function readAccessor(gltf: Gltf, bin: Buffer, i: number): Float32Array | Uint32Array {
  const acc = gltf.accessors[i]
  const view = gltf.bufferViews[acc.bufferView]
  const n = acc.count * COMPONENTS[acc.type]
  const offset = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0)
  const stride = view.byteStride
  if (acc.componentType === 5126) {
    const out = new Float32Array(n)
    const per = COMPONENTS[acc.type]
    for (let e = 0; e < acc.count; e++) for (let c = 0; c < per; c++) out[e * per + c] = bin.readFloatLE(offset + e * (stride ?? per * 4) + c * 4)
    return out
  }
  const out = new Uint32Array(n)
  const size = acc.componentType === 5125 ? 4 : acc.componentType === 5123 ? 2 : 1
  for (let e = 0; e < n; e++) {
    const at = offset + e * size
    out[e] = size === 4 ? bin.readUInt32LE(at) : size === 2 ? bin.readUInt16LE(at) : bin.readUInt8(at)
  }
  return out
}

/** All mesh primitives of a .glb, in the glTF (three.js) frame, under one Group. */
export function loadGlbMeshes(path: string): Group {
  const buf = readFileSync(path)
  const jsonLen = buf.readUInt32LE(12)
  const gltf = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8')) as Gltf
  const binStart = 20 + jsonLen
  const bin = buf.subarray(binStart + 8, binStart + 8 + buf.readUInt32LE(binStart))
  const root = new Group()
  const nodeMatrix = (n: NonNullable<Gltf['nodes']>[number]): Matrix4 => {
    if (n.matrix) return new Matrix4().fromArray(n.matrix)
    const t = new Vector3(...((n.translation ?? [0, 0, 0]) as [number, number, number]))
    const r = new Quaternion(...((n.rotation ?? [0, 0, 0, 1]) as [number, number, number, number]))
    const s = new Vector3(...((n.scale ?? [1, 1, 1]) as [number, number, number]))
    return new Matrix4().compose(t, r, s)
  }
  const visit = (i: number, parent: Matrix4) => {
    const n = gltf.nodes![i]
    const m = parent.clone().multiply(nodeMatrix(n))
    if (n.mesh !== undefined) {
      for (const p of gltf.meshes[n.mesh].primitives) {
        const g = new BufferGeometry()
        g.setAttribute('position', new BufferAttribute(readAccessor(gltf, bin, p.attributes.POSITION) as Float32Array, 3))
        if (p.indices !== undefined) g.setIndex(new BufferAttribute(readAccessor(gltf, bin, p.indices) as Uint32Array, 1))
        const mesh = new Mesh(g)
        mesh.matrixAutoUpdate = false
        mesh.matrix.copy(m)
        root.add(mesh)
      }
    }
    for (const c of n.children ?? []) visit(c, m)
  }
  const scene = gltf.scenes?.[gltf.scene ?? 0]
  for (const i of scene?.nodes ?? []) visit(i, new Matrix4())
  root.updateMatrixWorld(true)
  return root
}
