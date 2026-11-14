// SPDX-License-Identifier: GPL-3.0-or-later
// The rig the viewer has bound (for picking, the e2e hook's vertex sampling) and display helpers.
import { Box3, type Camera, type Object3D, Sphere, type SkinnedMesh, Vector3 } from 'three'
import type { BoundRig } from '../../shared/rig'

/** What the viewer shows, for picking and the e2e hook (gizmo position and hovered axis). */
export const rigView: {
  bound: BoundRig | null
  helper: Object3D | null
  gizmo: { axis: string | null; dragging?: boolean } | null
  camera: Camera | null
  canvas: HTMLCanvasElement | null
} = { bound: null, helper: null, gizmo: null, camera: null, canvas: null }

/** Client (CSS pixel) position of the gizmo centre and its hovered axis, or null without a gizmo. */
export function gizmoInfo(): { x: number; y: number; axis: string | null; dragging: boolean } | null {
  const { helper, camera, canvas, gizmo } = rigView
  if (!helper || !camera || !canvas || !helper.parent) return null
  const p = helper.getWorldPosition(new Vector3()).project(camera)
  const r = canvas.getBoundingClientRect()
  return { x: r.left + ((p.x + 1) / 2) * r.width, y: r.top + ((1 - p.y) / 2) * r.height, axis: gizmo?.axis ?? null, dragging: !!gizmo?.dragging }
}

/** Skinned meshes of a bound rig. */
export function skinnedMeshes(bound: BoundRig): SkinnedMesh[] {
  return Object.values(bound.meshes).flat()
}

/** Vertex count above which the lowest point is estimated from a vertex sample (display only). */
const EXACT_LIMIT = 20_000

/**
 * The lowest posed point (world y) of the skinned meshes. SkinnedMesh.computeBoundingBox applies the
 * bone transforms; very dense meshes are sampled instead, which is close enough for the display.
 */
export function lowestPoint(meshes: SkinnedMesh[]): number {
  let min = Infinity
  const box = new Box3()
  const v = new Vector3()
  for (const m of meshes) {
    const count = m.geometry.getAttribute('position').count
    if (count <= EXACT_LIMIT) {
      m.computeBoundingBox()
      if (m.boundingBox) min = Math.min(min, box.copy(m.boundingBox).applyMatrix4(m.matrixWorld).min.y)
    } else {
      const step = Math.ceil(count / EXACT_LIMIT)
      for (let i = 0; i < count; i += step) min = Math.min(min, m.getVertexPosition(i, v).applyMatrix4(m.matrixWorld).y)
    }
  }
  return min
}

/** Ground display: moves `group` so the lowest posed point of the meshes sits at y = 0. */
export function groundModel(group: Object3D, meshes: SkinnedMesh[]): void {
  group.position.y = 0
  group.updateMatrixWorld(true)
  const low = lowestPoint(meshes)
  group.position.y = Number.isFinite(low) ? -low : 0
  group.updateMatrixWorld(true)
}

/** Bounding sphere (world) of the posed skinned meshes, for framing the camera on a new pose. */
export function posedBounds(meshes: SkinnedMesh[]): Sphere | null {
  const all = new Box3()
  const box = new Box3()
  for (const m of meshes) {
    m.computeBoundingBox()
    if (m.boundingBox) all.union(box.copy(m.boundingBox).applyMatrix4(m.matrixWorld))
  }
  return all.isEmpty() ? null : all.getBoundingSphere(new Sphere())
}
