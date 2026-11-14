// SPDX-License-Identifier: GPL-3.0-or-later
// Moves the camera for focus requests from the store (frame-to-fit, focus a marker, zoom to a hand).
import { useThree } from '@react-three/fiber'
import { useEffect } from 'react'
import { PerspectiveCamera, Vector3 } from 'three'
import { useStore } from '../store'

/** The part of the OrbitControls (drei, `makeDefault`) the viewer uses. */
export interface ControlsLike {
  target: Vector3
  enabled: boolean
  update(): void
}

/** Default viewing direction for frame-to-fit: front (the figure faces +Z in three.js), slightly right and above. */
const FRONT_RIGHT = new Vector3(0.45, 0.3, 1).normalize()

export function CameraRig() {
  const focus = useStore((s) => s.focus)
  const camera = useThree((s) => s.camera) as PerspectiveCamera
  const controls = useThree((s) => s.controls) as unknown as ControlsLike | null
  const invalidate = useThree((s) => s.invalidate)

  useEffect(() => {
    if (!focus || !controls) return
    const center = new Vector3(...focus.center)
    const dir = focus.keepDirection ? camera.position.clone().sub(controls.target) : FRONT_RIGHT.clone()
    if (dir.lengthSq() < 1e-12) dir.copy(FRONT_RIGHT)
    dir.normalize()
    const vfov = (camera.fov * Math.PI) / 180
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect)
    const fit = Math.min(vfov, hfov)
    const distance = (Math.max(focus.radius, 0.01) / Math.sin(fit / 2)) * 1.05
    controls.target.copy(center)
    camera.position.copy(center).addScaledVector(dir, distance)
    camera.near = Math.max(0.001, distance / 500)
    camera.far = Math.max(100, distance * 100)
    camera.updateProjectionMatrix()
    controls.update()
    invalidate()
    // Only a new request (seq) or the controls appearing should move the camera.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.seq, controls])

  return null
}
