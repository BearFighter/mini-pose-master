// SPDX-License-Identifier: GPL-3.0-or-later
// Bone lines between joints (Blender frame in, three.js frame drawn), always on top of the mesh.
import { Line } from '@react-three/drei'
import { useMemo } from 'react'
import { Vector3 } from 'three'
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

export function SkeletonLines({ joints, color = '#cfe6ff' }: { joints: Record<string, Point>; color?: string }) {
  const points = useMemo(() => {
    const p = bonePositions(joints)
    const out: [number, number, number][] = []
    for (let i = 0; i < p.length; i += 3) out.push([p[i], p[i + 1], p[i + 2]])
    return out
  }, [joints])
  if (points.length < 2) return null
  // screen-space width (Line2), always on top of the mesh
  return (
    <Line
      points={points}
      segments
      lineWidth={2}
      color={color}
      renderOrder={9}
      frustumCulled={false}
      depthTest={false}
      depthWrite={false}
      transparent
      opacity={0.85}
      toneMapped={false}
    />
  )
}
