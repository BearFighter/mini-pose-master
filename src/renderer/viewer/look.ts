// SPDX-License-Identifier: GPL-3.0-or-later
// Display look of loaded models: materials only (never geometry, transforms or skinning).
// glTF materials without a metallic factor default to fully metallic, which renders as near-black
// without strong reflections; the viewer shows them as a matte surface so the form reads clearly.
import { Color, type Material, type Mesh, type MeshStandardMaterial, type Object3D } from 'three'

export type LookKind = 'model' | 'weapon' | 'baked'

/** Untextured models: a warm grey like unpainted resin. */
const CLAY = new Color('#bdb6aa')
/** Untextured weapons: brushed steel. */
const STEEL = new Color('#c4cad3')

function isStandard(m: Material): m is MeshStandardMaterial {
  return (m as MeshStandardMaterial).isMeshStandardMaterial === true
}

function isWhite(c: Color): boolean {
  return c.r > 0.99 && c.g > 0.99 && c.b > 0.99
}

/** Adjusts the materials under `root` for the studio lighting (once per material). */
export function applyDisplayLook(root: Object3D, kind: LookKind): void {
  root.traverse((o) => {
    const mesh = o as Mesh
    if (!mesh.isMesh) return
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if (!isStandard(m) || m.userData.mpmDisplay) continue
      m.userData.mpmDisplay = true
      if (kind === 'baked') {
        // grey printable / red too thin: keep the colours, matte plastic
        m.metalness = 0
        m.roughness = 0.6
      } else if (!m.map && isWhite(m.color)) {
        if (kind === 'weapon') {
          m.color.copy(STEEL)
          if (!m.metalnessMap) m.metalness = 0.55
          if (!m.roughnessMap) m.roughness = 0.38
        } else {
          m.color.copy(CLAY)
          if (!m.metalnessMap) m.metalness = 0
          if (!m.roughnessMap) m.roughness = 0.72
        }
      } else if (!m.metalnessMap) {
        m.metalness = Math.min(m.metalness, kind === 'weapon' ? 0.5 : 0.15)
      }
      m.needsUpdate = true
    }
  })
}
