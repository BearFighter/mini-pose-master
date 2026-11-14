// SPDX-License-Identifier: GPL-3.0-or-later
// Auto-rig markers: spheres coloured by confidence, click to select, drag in screen space at a
// constant camera depth. Positions are stored in the Blender frame and drawn in three's.
import { Html } from '@react-three/drei'
import { useThree, type ThreeEvent } from '@react-three/fiber'
import { useMemo, useRef, useState } from 'react'
import { Plane, Vector3 } from 'three'
import { vecB2T, vecT2B } from '../../shared/coords'
import type { MarkerEntry } from '../../shared/project'
import { confidenceColor, displayConfidence, isFingerMarker, markerHeight } from '../lib/markers'
import { useStore } from '../store'
import type { ControlsLike } from './CameraRig'

interface PointerTarget {
  setPointerCapture(id: number): void
  releasePointerCapture(id: number): void
}

const DRAG_THRESHOLD_PX = 3

interface DragState {
  plane: Plane
  offset: Vector3
  x: number
  y: number
  moved: boolean
}

function MarkerSphere({ name, entry, radius, selected }: { name: string; entry: MarkerEntry; radius: number; selected: boolean }) {
  const camera = useThree((s) => s.camera)
  const controls = useThree((s) => s.controls) as unknown as ControlsLike | null
  const drag = useRef<DragState | null>(null)
  const [hover, setHover] = useState(false)
  const position = useMemo(() => vecB2T(entry.p), [entry.p])
  const confidence = displayConfidence(entry)

  const onPointerDown = (e: ThreeEvent<PointerEvent>) => {
    if (e.nativeEvent.button !== 0) return
    e.stopPropagation()
    useStore.getState().select(name)
    const normal = camera.getWorldDirection(new Vector3())
    const plane = new Plane().setFromNormalAndCoplanarPoint(normal, position)
    const hit = e.ray.intersectPlane(plane, new Vector3())
    drag.current = {
      plane,
      offset: hit ? position.clone().sub(hit) : new Vector3(),
      x: e.nativeEvent.clientX,
      y: e.nativeEvent.clientY,
      moved: false
    }
    ;(e.target as unknown as PointerTarget).setPointerCapture(e.pointerId)
    if (controls) controls.enabled = false
  }

  const onPointerMove = (e: ThreeEvent<PointerEvent>) => {
    const d = drag.current
    if (!d) return
    e.stopPropagation()
    if (!d.moved && Math.hypot(e.nativeEvent.clientX - d.x, e.nativeEvent.clientY - d.y) < DRAG_THRESHOLD_PX) return
    d.moved = true
    const hit = e.ray.intersectPlane(d.plane, new Vector3())
    if (!hit) return
    useStore.getState().moveMarker(name, vecT2B(hit.add(d.offset)))
  }

  const endDrag = (e: ThreeEvent<PointerEvent>) => {
    if (!drag.current) return
    drag.current = null
    ;(e.target as unknown as PointerTarget).releasePointerCapture(e.pointerId)
    if (controls) controls.enabled = true
  }

  return (
    <mesh
      position={position}
      renderOrder={10}
      scale={selected ? 1.4 : hover ? 1.2 : 1}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onPointerOver={(e) => {
        e.stopPropagation()
        setHover(true)
      }}
      onPointerOut={() => setHover(false)}
    >
      <sphereGeometry args={[radius, 18, 12]} />
      <meshBasicMaterial color={confidenceColor(confidence)} depthTest={false} depthWrite={false} transparent opacity={0.95} />
      {selected && (
        <mesh renderOrder={11}>
          <sphereGeometry args={[radius * 1.25, 18, 12]} />
          <meshBasicMaterial color="#ffffff" wireframe depthTest={false} depthWrite={false} transparent opacity={0.9} />
        </mesh>
      )}
      {(hover || selected) && (
        <Html center zIndexRange={[20, 10]} style={{ pointerEvents: 'none' }} position={[0, radius * 2.6, 0]}>
          <div className="marker-tip">
            {name} · {Math.round(entry.confidence * 100)}%{entry.source === 'user' ? ' · edited' : ''}
          </div>
        </Html>
      )}
    </mesh>
  )
}

export function Markers() {
  const markers = useStore((s) => s.markers)
  const selection = useStore((s) => s.selection)
  const importHeight = useStore((s) => s.importInfo?.height_m ?? null)
  const suggested = useStore((s) => s.suggested)
  // Marker size follows the model height, not the markers being dragged.
  const height = useMemo(() => importHeight ?? markerHeight(suggested ?? markers ?? {}), [importHeight, suggested, markers === null])
  if (!markers) return null
  return (
    <group>
      {Object.entries(markers).map(([name, entry]) => (
        <MarkerSphere
          key={name}
          name={name}
          entry={entry}
          selected={selection === name}
          radius={(isFingerMarker(name) ? 0.003 : 0.011) * height}
        />
      ))}
    </group>
  )
}
