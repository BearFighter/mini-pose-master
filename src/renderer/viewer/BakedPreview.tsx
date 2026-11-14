// SPDX-License-Identifier: GPL-3.0-or-later
// The bake's preview GLB (grey printable, red too thin), framed on load.
import { useThree } from '@react-three/fiber'
import { useEffect, useState } from 'react'
import { Box3, type Object3D } from 'three'
import { cleanError } from '../api'
import { useStore } from '../store'
import { afterFrames, boundsOf, disposeObject, loadGltf } from './gltf'

export function BakedPreview({ url }: { url: string }) {
  const [scene, setScene] = useState<Object3D | null>(null)
  const invalidate = useThree((s) => s.invalidate)

  useEffect(() => {
    let cancelled = false
    let loaded: Object3D | null = null
    useStore.getState().setViewerFlags({ bakedLoaded: false })
    loadGltf(url)
      .then((gltf) => {
        if (cancelled) return disposeObject(gltf.scene)
        loaded = gltf.scene
        // stand it on the grid, centred
        const box = new Box3().setFromObject(gltf.scene)
        gltf.scene.position.set(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2)
        setScene(gltf.scene)
        const sphere = boundsOf(gltf.scene)
        useStore.getState().requestFocus([sphere.center.x, sphere.center.y, sphere.center.z], sphere.radius, false)
      })
      .catch((e: unknown) => {
        if (!cancelled) useStore.getState().setError({ code: 'ERROR', message: `The preview could not be shown: ${cleanError(e)}` })
      })
    return () => {
      cancelled = true
      if (loaded) disposeObject(loaded)
      setScene(null)
    }
  }, [url])

  useEffect(() => {
    if (!scene) return
    invalidate()
    return afterFrames(2, () => useStore.getState().setViewerFlags({ bakedLoaded: true }))
  }, [scene, invalidate])

  return scene ? <primitive object={scene} /> : null
}
