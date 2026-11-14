// SPDX-License-Identifier: GPL-3.0-or-later
// Bone lines between joints (Blender frame in, three.js frame drawn), always on top of the mesh.
import { useEffect, useMemo } from 'react'
import { BufferGeometry, Float32BufferAttribute, Vector3 } from 'three'
import type { Vec3 } from '../../shared/coords'
import { BONES } from '../../shared/skeleton'

type Point = Vec3 | Vector3

const asArray = (p: Point): Vec3 => (p instanceof Vector3 ? [p.x, p.y, p.z] : p)

/** Line-segment positions (three.js frame) for every canonical bone whose two joints exist. */
export function bonePositions(joints: Record<string, Point>): number[] {
  const out: number[] = []
  for (const b of BONES) {
    const h = joints[b.head]
    const t = joints[b.tail]
    if (!h || !t) continue
    const [hx, hy, hz] = asArray(h)
    const [tx, ty, tz] = asArray(t)
    // Blender (x, y, z) -> three (x, z, -y)
    out.push(hx, hz, -hy, tx, tz, -ty)
  }
  return out
}

export function SkeletonLines({ joints, color = '#9fd0ff' }: { joints: Record<string, Point>; color?: string }) {
  const geometry = useMemo(() => {
    const g = new BufferGeometry()
    g.setAttribute('position', new Float32BufferAttribute(bonePositions(joints), 3))
    return g
  }, [joints])
  useEffect(() => () => geometry.dispose(), [geometry])
  return (
    <lineSegments geometry={geometry} renderOrder={9} frustumCulled={false}>
      <lineBasicMaterial color={color} depthTest={false} depthWrite={false} transparent opacity={0.9} />
    </lineSegments>
  )
}
