// SPDX-License-Identifier: GPL-3.0-or-later
// CPU-skinned vertex positions on a bound rig, addressed by the engine's _ORIG_INDEX (contracts s7).
import { BufferAttribute, Matrix4, Vector3 } from 'three'
import type { SkinnedMesh } from 'three'
import { vecT2B } from './coords'
import type { Vec3 } from './coords'
import type { BoundRig } from './rig'

/** GLTFLoader lowercases custom attribute names (_ORIG_INDEX -> _orig_index). */
function origAttr(m: SkinnedMesh): BufferAttribute | undefined {
  return (m.geometry.getAttribute('_orig_index') ?? m.geometry.getAttribute('_ORIG_INDEX')) as
    | BufferAttribute
    | undefined
}

export function skinnedPositionsBlender(b: BoundRig, meshName: string, origIndices: number[]): Vec3[] {
  const parts = b.meshes[meshName]
  if (!parts || !parts.length) throw new Error(`no skinned mesh named ${meshName}`)
  const where = new Map<number, [SkinnedMesh, number]>()
  for (const m of parts) {
    const a = origAttr(m)
    if (!a) throw new Error(`mesh ${meshName} has no _ORIG_INDEX attribute`)
    for (let v = 0; v < a.count; v++) {
      const k = Math.round(a.getX(v))
      if (!where.has(k)) where.set(k, [m, v])
    }
  }
  const inv = new Matrix4().copy(b.armature.matrixWorld).invert()
  const t = new Vector3()
  return origIndices.map((k) => {
    const hit = where.get(k)
    if (!hit) throw new Error(`vertex ${k} not found in ${meshName}`)
    const [m, v] = hit
    m.getVertexPosition(v, t)
    t.applyMatrix4(m.matrixWorld).applyMatrix4(inv)
    return vecT2B(t)
  })
}
