// SPDX-License-Identifier: GPL-3.0-or-later
// Loaded weapon GLBs by weapon id (for auto-grip's triangles and the grip-point clicks), shared by the
// viewer and the flows. Geometry is in the GLB's three.js coordinates (C^-1 * Blender weapon-local).
import type { Object3D } from 'three'
import { loadGltf } from './gltf'

const scenes = new Map<string, { url: string; scene: Object3D }>()

export function setWeaponScene(id: string, url: string, scene: Object3D | null): void {
  if (scene) scenes.set(id, { url, scene })
  else if (scenes.get(id)?.url === url) scenes.delete(id)
}

export function weaponScene(id: string): Object3D | null {
  return scenes.get(id)?.scene ?? null
}

/** The weapon's scene: the one the viewer shows, else loaded now (not added to any scene). */
export async function loadWeaponScene(id: string, url: string): Promise<Object3D> {
  const hit = scenes.get(id)
  if (hit && hit.url === url) return hit.scene
  const gltf = await loadGltf(url)
  return gltf.scene
}
