// SPDX-License-Identifier: GPL-3.0-or-later
// The skinned rig (rig.glb + rig.json), bound by glTF node index and posed with applyPoseState.
// In the Pose step it stands on the grid (ground display) and carries the pose tools.
import { useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Group, Object3D, SkinnedMesh } from 'three'
import type { Deltas } from '../../shared/fk'
import type { WeaponEntry } from '../../shared/project'
import { posedJoints } from '../../shared/fk'
import { applyPoseState } from '../../shared/poseMath'
import { bindRig, type BoundRig, type LoadedGltf, type RigJson } from '../../shared/rig'
import { cleanError } from '../api'
import { useStore } from '../store'
import { afterFrames, boundsOf, disposeObject, loadGltf } from './gltf'
import { applyDisplayLook } from './look'
import { PoseTools } from './PoseTools'
import { groundModel, posedBounds, rigView, skinnedMeshes } from './rigView'
import { SkeletonLines } from './SkeletonLines'
import { WeaponsLayer } from './WeaponsLayer'

interface Loaded {
  scene: Object3D
  bound: BoundRig
}

let poseSeq = 0

export function RigModel({
  url,
  rig,
  deltas,
  label,
  showBones,
  ground,
  tools,
  weapons = [],
  weaponMatrices = {},
  weaponTools = false
}: {
  url: string
  rig: RigJson
  deltas: Deltas
  /** What the pose is, for the viewer flags: 'rest' | 'test' | 'pose'. */
  label: 'rest' | 'test' | 'pose'
  showBones: boolean
  ground: boolean
  tools: boolean
  /** Weapons on the grip sockets (with any preview). */
  weapons?: WeaponEntry[]
  /** composePose weaponMatrices for this pose (armature space): where each weapon is drawn. */
  weaponMatrices?: Record<string, number[]>
  /** Weapons step: weapon selection, gizmo and grip-point clicks. */
  weaponTools?: boolean
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const group = useRef<Group>(null)
  const framed = useRef(useStore.getState().frameSeq)
  const invalidate = useThree((s) => s.invalidate)
  const joints = useMemo(() => posedJoints(rig, deltas), [rig, deltas])

  useEffect(() => {
    let cancelled = false
    let scene: Object3D | null = null
    useStore.getState().setViewerFlags({ rigLoaded: false, pose: null, boneCount: 0 })
    loadGltf(url)
      .then((gltf) => {
        if (cancelled) return disposeObject(gltf.scene)
        scene = gltf.scene
        applyDisplayLook(gltf.scene, 'model')
        const bound = bindRig(gltf as unknown as LoadedGltf, rig)
        // Posed skinned meshes leave their rest bounds; never cull them.
        gltf.scene.traverse((o) => {
          if ((o as SkinnedMesh).isSkinnedMesh) o.frustumCulled = false
        })
        rigView.bound = bound
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
      if (rigView.bound && rigView.bound.armature.parent && scene && isInside(rigView.bound.armature, scene)) rigView.bound = null
      setLoaded(null)
    }
  }, [url, rig])

  useEffect(() => {
    if (!loaded) return
    applyPoseState(loaded.bound, deltas)
    if (group.current) {
      if (ground) groundModel(group.current, skinnedMeshes(loaded.bound))
      else {
        group.current.position.y = 0
        group.current.updateMatrixWorld(true)
      }
    }
    // A new clip was picked: frame the posed model (raised arms may leave the rest-pose framing).
    const frameSeq = useStore.getState().frameSeq
    if (tools && frameSeq !== framed.current) {
      framed.current = frameSeq
      const sphere = posedBounds(skinnedMeshes(loaded.bound))
      if (sphere) useStore.getState().requestFocus([sphere.center.x, sphere.center.y, sphere.center.z], sphere.radius, true)
    }
    invalidate()
    const seq = ++poseSeq
    return afterFrames(2, () =>
      useStore.getState().setViewerFlags({ rigLoaded: true, pose: label, poseSeq: seq, boneCount: rig.bones.length })
    )
  }, [loaded, deltas, label, ground, tools, rig, invalidate])

  if (!loaded) return null
  return (
    <group ref={group}>
      <primitive object={loaded.scene} />
      {showBones && <SkeletonLines joints={joints} color="#8fd0f0" />}
      {tools && <PoseTools bound={loaded.bound} rig={rig} deltas={deltas} />}
      {weapons.length > 0 && <WeaponsLayer bound={loaded.bound} rig={rig} matrices={weaponMatrices} weapons={weapons} tools={weaponTools} />}
    </group>
  )
}

function isInside(node: Object3D, root: Object3D): boolean {
  let o: Object3D | null = node
  while (o) {
    if (o === root) return true
    o = o.parent
  }
  return false
}
