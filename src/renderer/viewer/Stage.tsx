// SPDX-License-Identifier: GPL-3.0-or-later
// The studio around the model: key / fill / rim lights, a procedural environment (no files, no
// network), a fading floor grid, a light pool and a soft shadow under the figure, all sized to the model.
import { Environment, Grid, Lightformer } from '@react-three/drei'
import { useEffect, useMemo } from 'react'
import { CanvasTexture } from 'three'

/** A radial gradient texture (white, fading out), for the floor's light pool and the soft shadow. */
function useRadialTexture(stops: [number, number][]): CanvasTexture | null {
  const key = JSON.stringify(stops)
  const texture = useMemo(() => {
    if (typeof document === 'undefined') return null
    const c = document.createElement('canvas')
    c.width = c.height = 256
    const g = c.getContext('2d')
    if (!g) return null
    const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128)
    for (const [at, alpha] of JSON.parse(key) as [number, number][]) grad.addColorStop(at, `rgba(255,255,255,${alpha})`)
    g.fillStyle = grad
    g.fillRect(0, 0, 256, 256)
    return new CanvasTexture(c)
  }, [key])
  useEffect(() => () => texture?.dispose(), [texture])
  return texture
}

const SPOT: [number, number][] = [
  [0, 1],
  [0.45, 0.55],
  [1, 0]
]
const BLOB: [number, number][] = [
  [0, 0.95],
  [0.25, 0.7],
  [0.6, 0.22],
  [1, 0]
]

/** 1, 2 or 5 times a power of ten, at most `x`. */
export function niceStep(x: number): number {
  if (!(x > 0)) return 0.1
  const p = 10 ** Math.floor(Math.log10(x))
  const f = x / p
  return (f >= 5 ? 5 : f >= 2 ? 2 : 1) * p
}

/** The lights and the environment (independent of the model's size). */
export function StudioLights() {
  return (
    <>
      <hemisphereLight args={['#dfe8f5', '#1c1712', 0.45]} />
      <directionalLight position={[3, 5, 4]} intensity={1.7} color="#fff3e4" />
      <directionalLight position={[-4, 2.5, 2]} intensity={0.45} color="#d2e2ff" />
      <directionalLight position={[-1.5, 3.5, -5]} intensity={1.25} color="#c4dcff" />
      <Environment frames={1} resolution={128} background={false} environmentIntensity={0.55}>
        <Lightformer form="rect" intensity={1.6} color="#ffffff" position={[0, 6, 0]} rotation-x={Math.PI / 2} scale={[8, 8, 1]} />
        <Lightformer form="rect" intensity={2.2} color="#fff1df" position={[5, 2.5, 4]} scale={[3, 5, 1]} target={[0, 1, 0]} />
        <Lightformer form="rect" intensity={1.2} color="#cfe0ff" position={[-5, 2, 1]} scale={[3, 5, 1]} target={[0, 1, 0]} />
        <Lightformer form="rect" intensity={2.0} color="#d8e8ff" position={[0, 3, -6]} scale={[6, 2, 1]} target={[0, 1, 0]} />
        <Lightformer form="circle" intensity={0.4} color="#3a3026" position={[0, -3, 0]} rotation-x={-Math.PI / 2} scale={[10, 10, 1]} />
      </Environment>
    </>
  )
}

/** Floor grid and contact shadow for a model about `size` metres tall standing at the origin. */
export function StudioFloor({ size, shadow }: { size: number; shadow: boolean }) {
  const h = size > 0 && Number.isFinite(size) ? size : 1.8
  const cell = niceStep(h / 16)
  const spot = useRadialTexture(SPOT)
  const blob = useRadialTexture(BLOB)
  return (
    <>
      {spot && (
        <mesh rotation-x={-Math.PI / 2} position={[0, -h * 0.0003, 0]} renderOrder={-1} raycast={() => null}>
          <circleGeometry args={[h * 1.5, 48]} />
          <meshBasicMaterial map={spot} color="#3d5068" transparent opacity={0.55} depthWrite={false} toneMapped={false} />
        </mesh>
      )}
      <Grid
        position={[0, -h * 0.0005, 0]}
        infiniteGrid
        cellSize={cell}
        sectionSize={cell * 5}
        cellThickness={0.6}
        sectionThickness={1}
        cellColor="#273140"
        sectionColor="#3a4a60"
        fadeDistance={h * 5}
        fadeStrength={2.2}
        fadeFrom={0}
        followCamera={false}
      />
      {shadow && blob && (
        // soft shadow under the figure: a dark radial falloff, no extra render pass (cheap for dense models)
        <mesh rotation-x={-Math.PI / 2} position={[0, h * 0.0004, 0]} renderOrder={0} raycast={() => null}>
          <circleGeometry args={[h * 0.32, 48]} />
          <meshBasicMaterial map={blob} color="#000000" transparent opacity={0.7} depthWrite={false} toneMapped={false} />
        </mesh>
      )}
    </>
  )
}
