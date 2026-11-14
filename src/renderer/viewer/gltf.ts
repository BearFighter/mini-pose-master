// SPDX-License-Identifier: GPL-3.0-or-later
// GLB loading (mpm:// URLs only), disposal, the x-ray look and frame-to-fit helpers.
import { Box3, Material, Mesh, Object3D, Sphere, Texture, TextureLoader, Vector3 } from 'three'
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'

export function loadGltf(url: string): Promise<GLTF> {
  const loader = new GLTFLoader()
  // Embedded images become blob: URLs. The default ImageBitmapLoader fetch()es them, which the
  // CSP's connect-src does not allow; the <img>-based TextureLoader is covered by img-src blob:.
  loader.register((parser) => {
    const textures = new TextureLoader(parser.options.manager)
    textures.setCrossOrigin(parser.options.crossOrigin)
    parser.textureLoader = textures
    return { name: 'MPM_img_texture_loader' }
  })
  return loader.loadAsync(url)
}

function materialsOf(mesh: Mesh): Material[] {
  return Array.isArray(mesh.material) ? mesh.material : [mesh.material]
}

/** Frees the GPU resources of a loaded scene. */
export function disposeObject(root: Object3D): void {
  root.traverse((o) => {
    const mesh = o as Mesh
    if (!mesh.isMesh) return
    mesh.geometry?.dispose()
    for (const m of materialsOf(mesh)) {
      for (const value of Object.values(m)) if (value instanceof Texture) value.dispose()
      m.dispose()
    }
  })
}

interface SavedLook {
  transparent: boolean
  opacity: number
  depthWrite: boolean
}

/** Makes the model see-through (so markers and bones inside it stay visible) or restores it. */
export function setXray(root: Object3D, on: boolean, opacity = 0.35): void {
  root.traverse((o) => {
    const mesh = o as Mesh
    if (!mesh.isMesh) return
    for (const m of materialsOf(mesh)) {
      const saved = (m.userData.mpmLook ??= { transparent: m.transparent, opacity: m.opacity, depthWrite: m.depthWrite }) as SavedLook
      m.transparent = on ? true : saved.transparent
      m.opacity = on ? opacity * saved.opacity : saved.opacity
      m.depthWrite = on ? false : saved.depthWrite
      m.needsUpdate = true
    }
  })
}

/** Bounding sphere of everything in `root` (world space). */
export function boundsOf(root: Object3D): Sphere {
  root.updateMatrixWorld(true)
  const box = new Box3().setFromObject(root, true)
  if (box.isEmpty()) return new Sphere(new Vector3(0, 0.9, 0), 1)
  return box.getBoundingSphere(new Sphere())
}

/** Calls `cb` after `n` animation frames; returns a cancel function. */
export function afterFrames(n: number, cb: () => void): () => void {
  let id = 0
  let cancelled = false
  const step = (left: number) => {
    id = requestAnimationFrame(() => {
      if (cancelled) return
      if (left <= 1) cb()
      else step(left - 1)
    })
  }
  step(n)
  return () => {
    cancelled = true
    cancelAnimationFrame(id)
  }
}
