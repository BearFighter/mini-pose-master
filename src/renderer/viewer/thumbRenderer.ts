// SPDX-License-Identifier: GPL-3.0-or-later
// Clip thumbnails: a stick figure of one clip frame, drawn by one shared offscreen WebGLRenderer
// (128x128, 3/4 front view) and returned as PNG bytes.
import {
  Box3,
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  LineBasicMaterial,
  LineSegments,
  PerspectiveCamera,
  Points,
  PointsMaterial,
  Scene,
  Sphere,
  Vector3,
  WebGLRenderer
} from 'three'
import type { ClipFrame } from '../../shared/clip'
import { vecB2T } from '../../shared/coords'
import { BONES } from '../../shared/skeleton'

export const THUMB_SIZE = 128

let renderer: WebGLRenderer | null = null

function getRenderer(): WebGLRenderer {
  if (!renderer) {
    renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: false })
    renderer.setPixelRatio(1)
    renderer.setSize(THUMB_SIZE, THUMB_SIZE, false)
    renderer.setClearColor(new Color('#232733'))
  }
  return renderer
}

/** Bone segments (head joint, tail joint) the clip has both joints of. */
export function stickBones(jointNames: string[]): [string, string][] {
  const have = new Set(jointNames)
  return BONES.filter((b) => have.has(b.head) && have.has(b.tail)).map((b) => [b.head, b.tail])
}

/** Renders the stick figure of `frame` and returns PNG bytes. */
export async function renderStickFigure(frame: ClipFrame, allJoints: string[]): Promise<Uint8Array> {
  const jointNames = allJoints.filter((n) => frame.joints[n])
  if (jointNames.length === 0) throw new Error('the clip frame has no joints')
  const r = getRenderer()
  const scene = new Scene()
  const pos: number[] = []
  for (const [h, t] of stickBones(jointNames)) {
    const a = vecB2T(frame.joints[h])
    const b = vecB2T(frame.joints[t])
    pos.push(a.x, a.y, a.z, b.x, b.y, b.z)
  }
  const lines = new BufferGeometry()
  lines.setAttribute('position', new Float32BufferAttribute(pos, 3))
  const pts = new BufferGeometry()
  pts.setAttribute('position', new Float32BufferAttribute(jointNames.flatMap((n) => vecB2T(frame.joints[n]).toArray()), 3))
  const lineMat = new LineBasicMaterial({ color: '#9fd0ff' })
  const ptMat = new PointsMaterial({ color: '#ffffff', size: 3, sizeAttenuation: false })
  scene.add(new LineSegments(lines, lineMat), new Points(pts, ptMat))

  // 3/4 front view (the figure faces +Z in three.js), fitted to the figure.
  const sphere = new Box3().setFromBufferAttribute(pts.getAttribute('position') as Float32BufferAttribute).getBoundingSphere(new Sphere())
  const camera = new PerspectiveCamera(30, 1, 0.01, 100)
  const dir = new Vector3(0.7, 0.25, 1).normalize()
  const dist = Math.max(sphere.radius, 0.2) / Math.sin((15 * Math.PI) / 180)
  camera.position.copy(sphere.center).addScaledVector(dir, dist)
  camera.lookAt(sphere.center)
  r.render(scene, camera)

  lines.dispose()
  pts.dispose()
  lineMat.dispose()
  ptMat.dispose()
  const blob = await new Promise<Blob | null>((resolve) => r.domElement.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('the thumbnail could not be encoded')
  return new Uint8Array(await blob.arrayBuffer())
}
