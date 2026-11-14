// SPDX-License-Identifier: GPL-3.0-or-later
// The static rest-pose preview (mpm://project/rig/preview.glb) written by the import job.
import { useThree } from '@react-three/fiber'
import { useEffect, useState } from 'react'
import type { Object3D } from 'three'
import { cleanError } from '../api'
import { useStore } from '../store'
import { afterFrames, boundsOf, disposeObject, loadGltf, setXray } from './gltf'

export function PreviewModel({ url, xray, frameOnLoad = true }: { url: string; xray: boolean; frameOnLoad?: boolean }) {
  const [scene, setScene] = useState<Object3D | null>(null)
  const invalidate = useThree((s) => s.invalidate)

  useEffect(() => {
    let cancelled = false
    let loaded: Object3D | null = null
    const s = useStore.getState()
    s.setViewerFlags({ previewLoaded: false })
    loadGltf(url)
      .then((gltf) => {
        if (cancelled) return disposeObject(gltf.scene)
        loaded = gltf.scene
        setScene(gltf.scene)
        if (frameOnLoad) {
          const sphere = boundsOf(gltf.scene)
          useStore.getState().requestFocus([sphere.center.x, sphere.center.y, sphere.center.z], sphere.radius, false)
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) useStore.getState().setPreviewError(`No preview of the model (${cleanError(e)}). Run the import again.`)
      })
    return () => {
      cancelled = true
      if (loaded) disposeObject(loaded)
      setScene(null)
    }
    // frameOnLoad only matters for a new URL
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url])

  useEffect(() => {
    if (!scene) return
    setXray(scene, xray)
    invalidate()
  }, [scene, xray, invalidate])

  useEffect(() => {
    if (!scene) return
    invalidate()
    return afterFrames(2, () => useStore.getState().setViewerFlags({ previewLoaded: true }))
  }, [scene, invalidate])

  return scene ? <primitive object={scene} /> : null
}
