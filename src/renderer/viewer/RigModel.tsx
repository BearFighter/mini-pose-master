// SPDX-License-Identifier: GPL-3.0-or-later
// The skinned rig (rig.glb + rig.json), bound by glTF node index and posed with applyPoseState.
import { useThree } from '@react-three/fiber'
import { useEffect, useMemo, useState } from 'react'
import type { Object3D, SkinnedMesh } from 'three'
import type { Deltas } from '../../shared/fk'
import { posedJoints } from '../../shared/fk'
import { applyPoseState } from '../../shared/poseMath'
import { bindRig, type BoundRig, type LoadedGltf, type RigJson } from '../../shared/rig'
import { cleanError } from '../api'
import { testPoseDeltas } from '../lib/testPose'
import { useStore } from '../store'
import { afterFrames, boundsOf, disposeObject, loadGltf } from './gltf'
import { SkeletonLines } from './SkeletonLines'

interface Loaded {
  scene: Object3D
  bound: BoundRig
}

export function RigModel({ url, rig, testPose, showBones }: { url: string; rig: RigJson; testPose: boolean; showBones: boolean }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const invalidate = useThree((s) => s.invalidate)
  const deltas: Deltas = useMemo(() => (testPose ? testPoseDeltas(rig) : {}), [rig, testPose])
  const joints = useMemo(() => posedJoints(rig, deltas), [rig, deltas])

  useEffect(() => {
    let cancelled = false
    let scene: Object3D | null = null
    useStore.getState().setViewerFlags({ rigLoaded: false, pose: null, boneCount: 0 })
    loadGltf(url)
      .then((gltf) => {
        if (cancelled) return disposeObject(gltf.scene)
        scene = gltf.scene
        const bound = bindRig(gltf as unknown as LoadedGltf, rig)
        // Posed skinned meshes leave their rest bounds; never cull them.
        gltf.scene.traverse((o) => {
          if ((o as SkinnedMesh).isSkinnedMesh) o.frustumCulled = false
        })
        setLoaded({ scene: gltf.scene, bound })
        const sphere = boundsOf(gltf.scene)
        useStore.getState().requestFocus([sphere.center.x, sphere.center.y, sphere.center.z], sphere.radius, false)
      })
      .catch((e: unknown) => {
        if (!cancelled) useStore.getState().setError({ code: 'ERROR', message: `The rig could not be shown: ${cleanError(e)}` })
      })
    return () => {
      cancelled = true
      if (scene) disposeObject(scene)
      setLoaded(null)
    }
  }, [url, rig])

  useEffect(() => {
    if (!loaded) return
    applyPoseState(loaded.bound, deltas)
    invalidate()
    return afterFrames(2, () =>
      useStore.getState().setViewerFlags({ rigLoaded: true, pose: testPose ? 'test' : 'rest', boneCount: rig.bones.length })
    )
  }, [loaded, deltas, testPose, rig, invalidate])

  if (!loaded) return null
  return (
    <>
      <primitive object={loaded.scene} />
      {showBones && <SkeletonLines joints={joints} color="#7fb4ff" />}
    </>
  )
}
