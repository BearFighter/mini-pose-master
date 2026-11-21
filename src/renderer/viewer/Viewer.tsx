// SPDX-License-Identifier: GPL-3.0-or-later
// The 3D viewport: R3F canvas with orbit controls, the studio (lights, floor, shadow), frame-to-fit, and what the
// current step shows (preview, markers + bone lines, or the skinned rig).
import { OrbitControls } from '@react-three/drei'
import { Canvas } from '@react-three/fiber'
import { useMemo } from 'react'
import type { Vector3 } from 'three'
import type { Vec3 } from '../../shared/coords'
import type { ComposeResult } from '../../shared/composePose'
import { deriveJoints } from '../../shared/derive'
import type { Deltas } from '../../shared/fk'
import type { MarkerMap } from '../../shared/project'
import { projectUrl } from '../lib/paths'
import { computePose, setupInputs, showsSetupStance } from '../lib/pose'
import { testPoseDeltas } from '../lib/testPose'
import { useStore } from '../store'
import { BakedPreview } from './BakedPreview'
import { CameraRig } from './CameraRig'
import { Markers } from './Markers'
import { PreviewModel } from './PreviewModel'
import { RigModel } from './RigModel'
import { SkeletonLines } from './SkeletonLines'
import { StudioFloor, StudioLights } from './Stage'

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

const NO_DELTAS: Deltas = {}
const NO_MATRICES: Record<string, number[]> = {}

/**
 * The pose the viewer shows, memoised: composePose of the inputs + preview, or in the Weapons and Hands
 * steps the setup stance (lib/pose setupInputs; never stored in the user's pose).
 */
export function usePoseResult(): ComposeResult | null {
  const rig = useStore((s) => s.rigJson)
  const inputs = useStore((s) => s.poseInputs)
  const preview = useStore((s) => s.posePreview)
  const clip = useStore((s) => s.loadedClip)
  const hands = useStore((s) => s.hands)
  const weapons = useStore((s) => s.weapons)
  const setup = useStore((s) => showsSetupStance(s.step))
  return useMemo(() => {
    if (!rig) return null
    if (setup) return computePose(rig, setupInputs(rig, weapons), preview, null, hands, weapons)
    return computePose(rig, inputs, preview, clip, hands, weapons)
  }, [rig, inputs, preview, clip, hands, weapons, setup])
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
  const pose = usePoseResult()
  const testDeltas = useMemo(() => (rigJson ? testPoseDeltas(rigJson) : NO_DELTAS), [rigJson])
  const weapons = useStore((s) => s.posePreview?.weapons ?? s.weapons)
  const bakedUrl = useStore((s) => (s.showBaked && s.bakeResult ? projectUrl(s.bakeResult.preview_glb, s.bakeVersion) : null))
  // floor and shadow scale: the model's height (the baked preview is at print size, in metres)
  const modelHeight = useStore((s) => s.importInfo?.height_m ?? s.rigJson?.height_m ?? 1.8)
  const bakedSize = useStore((s) => (s.bakeResult ? Math.max(...s.bakeResult.report.final_dims_mm) / 1000 : null))

  if (!hasProject) return <StudioFloor size={1.8} shadow={false} />
  const rigReady = rigJson !== null && glbUrl !== null
  const showRig = rigReady && (step === 'rig' ? view === 'rig' : step !== 'import')
  const showMarkers = step === 'rig' && !showRig && rigPath === 'auto' && markers !== null
  // The Rig step shows rest or the fixed test pose; the Pose step and the later steps the pose.
  const posing = step !== 'rig' && step !== 'import'
  const deltas = posing ? (pose?.deltas ?? NO_DELTAS) : testPose ? testDeltas : NO_DELTAS
  const label = posing ? 'pose' : testPose ? 'test' : 'rest'
  const baked = step === 'export' && bakedUrl !== null
  const shown = baked || showRig || previewUrl !== null

  return (
    <>
      <StudioFloor size={baked ? (bakedSize ?? modelHeight) : modelHeight} shadow={shown} />
      {!showRig && previewUrl && <PreviewModel url={previewUrl} xray={showMarkers && xray} />}
      {baked && bakedUrl && <BakedPreview url={bakedUrl} />}
      {showRig && !baked && rigJson && glbUrl && (
        <RigModel
          url={glbUrl}
          rig={rigJson}
          deltas={deltas}
          label={label}
          showBones={step === 'rig' || step === 'pose'}
          ground={posing}
          tools={step === 'pose'}
          weapons={posing ? weapons : []}
          weaponMatrices={pose?.weaponMatrices ?? NO_MATRICES}
          weaponTools={step === 'weapons'}
        />
      )}
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
      gl={{ alpha: true, antialias: true }}
      camera={{ position: [1.6, 1.4, 3.6], fov: 40, near: 0.01, far: 200 }}
      onPointerMissed={() => select(null)}
    >
      {/* transparent canvas: the viewport's CSS gradient and vignette show through */}
      <StudioLights />
      <OrbitControls makeDefault />
      <CameraRig />
      <Scene />
    </Canvas>
  )
}
