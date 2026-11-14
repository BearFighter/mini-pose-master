// SPDX-License-Identifier: GPL-3.0-or-later
// The 3D viewport: R3F canvas with orbit controls, grid, lights, frame-to-fit, and what the
// current step shows (preview, markers + bone lines, or the skinned rig).
import { OrbitControls } from '@react-three/drei'
import { Canvas } from '@react-three/fiber'
import { useMemo } from 'react'
import type { Vector3 } from 'three'
import type { Vec3 } from '../../shared/coords'
import { deriveJoints } from '../../shared/derive'
import type { MarkerMap } from '../../shared/project'
import { useStore } from '../store'
import { CameraRig } from './CameraRig'
import { Markers } from './Markers'
import { PreviewModel } from './PreviewModel'
import { RigModel } from './RigModel'
import { SkeletonLines } from './SkeletonLines'

/** All joints derived from the markers (finger joints included); just the markers when some are missing. */
function useDerivedJoints(markers: MarkerMap | null): Record<string, Vec3 | Vector3> {
  return useMemo(() => {
    if (!markers) return {}
    const points: Record<string, Vec3> = {}
    for (const [k, m] of Object.entries(markers)) points[k] = m.p
    try {
      return deriveJoints(points)
    } catch {
      return points
    }
  }, [markers])
}

function Scene() {
  const hasProject = useStore((s) => s.dir !== null)
  const step = useStore((s) => s.step)
  const view = useStore((s) => s.view)
  const previewUrl = useStore((s) => s.previewUrl)
  const rigJson = useStore((s) => s.rigJson)
  const glbUrl = useStore((s) => s.glbUrl)
  const testPose = useStore((s) => s.testPose)
  const markers = useStore((s) => s.markers)
  const xray = useStore((s) => s.xray)
  const rigPath = useStore((s) => s.rigPath)
  const joints = useDerivedJoints(markers)

  if (!hasProject) return null
  const rigReady = rigJson !== null && glbUrl !== null
  const showRig = rigReady && (step === 'rig' ? view === 'rig' : step !== 'import')
  const showMarkers = step === 'rig' && !showRig && rigPath === 'auto' && markers !== null

  return (
    <>
      {!showRig && previewUrl && <PreviewModel url={previewUrl} xray={showMarkers && xray} />}
      {showRig && rigJson && glbUrl && <RigModel url={glbUrl} rig={rigJson} testPose={testPose} showBones={step === 'rig'} />}
      {showMarkers && (
        <>
          <SkeletonLines joints={joints} />
          <Markers />
        </>
      )}
    </>
  )
}

export function Viewer() {
  const select = useStore((s) => s.select)
  return (
    <Canvas
      frameloop="demand"
      dpr={[1, 2]}
      camera={{ position: [1.6, 1.4, 3.6], fov: 40, near: 0.01, far: 200 }}
      onPointerMissed={() => select(null)}
    >
      <color attach="background" args={['#15171c']} />
      <hemisphereLight args={['#e4e9ff', '#2b2620', 1.1]} />
      <directionalLight position={[3, 5, 4]} intensity={1.8} />
      <directionalLight position={[-4, 3, -3]} intensity={0.7} />
      <gridHelper args={[10, 20, '#4a5263', '#2a2f3a']} />
      <OrbitControls makeDefault />
      <CameraRig />
      <Scene />
    </Canvas>
  )
}
