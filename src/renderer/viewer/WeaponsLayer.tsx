// SPDX-License-Identifier: GPL-3.0-or-later
// Weapons on the posed rig (contracts sections 12-13). Each weapon hangs under the armature node:
//   attach (matrix = C^-1 * W * C * H^-1) -> helper (H = C^-1 * TRS(offset) * C) -> the weapon GLB
// (three.js coordinates), where W is composePose's weaponMatrices[id] for the pose shown (for a weapon
// fixed in its hand W = A * TRS(offset), so attach is the socket's frame, as before). The helper is what
// the gizmo moves (offset.t / offset.q). In the Weapons step a click selects a weapon, or sets its grip /
// support point, and both grip points are shown as markers.
import { Html, TransformControls } from '@react-three/drei'
import { createPortal, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef, useState } from 'react'
import { BackSide, type Intersection, Matrix3, Matrix4, type Mesh, Object3D, Raycaster, Vector2, Vector3 } from 'three'
import { quatB2T, quatT2B, vecB2T, vecT2B } from '../../shared/coords'
import type { WeaponEntry } from '../../shared/project'
import type { BoundRig, RigJson } from '../../shared/rig'
import { mainGripPoint, type WeaponOffset } from '../../shared/weaponPose'
import { cleanError } from '../api'
import { projectUrl } from '../lib/paths'
import { m4B2T } from '../lib/weapons'
import { useStore } from '../store'
import { commitWeaponOffset, previewWeaponOffset, setGripPoint, setSupportGrip } from '../store/weaponActions'
import { disposeObject, loadGltf } from './gltf'
import { applyDisplayLook } from './look'
import { setWeaponScene } from './weaponView'

const CLICK_SLOP_PX = 4

interface ControlsLike {
  axis: string | null
}

/** A loaded weapon's scene and where it hangs. */
interface Placed {
  id: string
  attach: Object3D
  helper: Object3D
  scene: Object3D
}

const placed = new Map<string, Placed>()

function offsetOf(helper: Object3D, s: number): WeaponOffset {
  return { t: vecT2B(helper.position), q: quatT2B(helper.quaternion), s }
}

/** Grip point colours: right hand, left hand. */
export const GRIP_COLORS = { R: '#7cc8ea', L: '#e0b46a' } as const

const noRaycast = () => null

/** One grip point on the weapon (weapon-local three.js position), labelled with its hand. */
function GripMarker({ position, side, radius, main }: { position: Vector3; side: 'L' | 'R'; radius: number; main: boolean }) {
  const color = GRIP_COLORS[side]
  return (
    <group position={position}>
      <mesh renderOrder={21} raycast={noRaycast}>
        <sphereGeometry args={[radius, 16, 12]} />
        <meshBasicMaterial color={color} depthTest={false} depthWrite={false} transparent opacity={0.95} toneMapped={false} />
      </mesh>
      <mesh renderOrder={20} scale={1.45} raycast={noRaycast}>
        <sphereGeometry args={[radius, 16, 12]} />
        <meshBasicMaterial color="#05080c" side={BackSide} depthTest={false} depthWrite={false} transparent opacity={0.8} toneMapped={false} />
      </mesh>
      <Html center zIndexRange={[18, 12]} style={{ pointerEvents: 'none' }} position={main ? [radius * 3.2, radius * 3.2, 0] : [-radius * 3.2, -radius * 3.2, 0]}>
        <div className={`grip-tag grip-${side}`}>
          {side === 'R' ? 'Right' : 'Left'} hand{main ? '' : ' (support)'}
        </div>
      </Html>
    </group>
  )
}

function WeaponObject({
  bound,
  rig,
  matrix,
  weapon,
  gizmo,
  gizmoRef,
  showGrips
}: {
  bound: BoundRig
  rig: RigJson
  matrix: number[] | undefined
  weapon: WeaponEntry
  gizmo: 'translate' | 'rotate' | null
  gizmoRef: React.MutableRefObject<ControlsLike | null>
  showGrips: boolean
}) {
  const version = useStore((s) => s.weaponVersion[weapon.id])
  const url = projectUrl(weapon.file, version)
  const invalidate = useThree((s) => s.invalidate)
  const attach = useMemo(() => {
    const o = new Object3D()
    o.matrixAutoUpdate = false
    return o
  }, [])
  const helper = useMemo(() => new Object3D(), [])
  const [scene, setScene] = useState<Object3D | null>(null)
  const dragging = useRef(false)

  useEffect(() => {
    attach.add(helper)
    bound.armature.add(attach)
    return () => {
      bound.armature.remove(attach)
    }
  }, [bound, attach, helper])

  useEffect(() => {
    let cancelled = false
    let loaded: Object3D | null = null
    loadGltf(url)
      .then((gltf) => {
        if (cancelled) return disposeObject(gltf.scene)
        loaded = gltf.scene
        applyDisplayLook(gltf.scene, 'weapon')
        helper.add(gltf.scene)
        setWeaponScene(weapon.id, url, gltf.scene)
        placed.set(weapon.id, { id: weapon.id, attach, helper, scene: gltf.scene })
        setScene(gltf.scene)
        invalidate()
      })
      .catch((e: unknown) => {
        if (!cancelled) useStore.getState().setError({ code: 'ERROR', message: `The weapon could not be shown: ${cleanError(e)}` })
      })
    return () => {
      cancelled = true
      if (loaded) {
        helper.remove(loaded)
        disposeObject(loaded)
        setWeaponScene(weapon.id, url, null)
        if (placed.get(weapon.id)?.scene === loaded) placed.delete(weapon.id)
      }
      setScene(null)
    }
  }, [url, weapon.id, helper, attach, invalidate])

  // The attach frame follows the pose (W from composePose); the helper carries the offset (unless the
  // gizmo is moving it). attach = C^-1 W C * H^-1 with H the helper's matrix for weapon.offset.
  useEffect(() => {
    attach.visible = !!matrix
    const H = new Matrix4().compose(vecB2T(weapon.offset.t), quatB2T(weapon.offset.q), new Vector3().setScalar(weapon.offset.s))
    if (matrix) attach.matrix.copy(m4B2T(new Matrix4().fromArray(matrix))).multiply(H.invert())
    attach.matrixWorldNeedsUpdate = true
    if (!dragging.current) {
      helper.position.copy(vecB2T(weapon.offset.t))
      helper.quaternion.copy(quatB2T(weapon.offset.q))
      helper.scale.setScalar(weapon.offset.s)
    }
    attach.updateMatrixWorld(true)
    invalidate()
  }, [matrix, weapon, attach, helper, invalidate, scene])

  // Both grip points (weapon-local), sized to the figure, not to the weapon's scale.
  const grips = useMemo(() => {
    if (!showGrips) return []
    const main = (weapon.attach_bone === 'grip.L' ? 'L' : 'R') as 'L' | 'R'
    const out: { side: 'L' | 'R'; position: Vector3; main: boolean }[] = [{ side: main, position: vecB2T(mainGripPoint(weapon).toArray() as [number, number, number]), main: true }]
    if (weapon.support?.enabled) out.push({ side: main === 'R' ? 'L' : 'R', position: vecB2T(weapon.support.point), main: false })
    return out
  }, [showGrips, weapon])
  const markerRadius = (0.0065 * (rig.height_m || 1.8)) / Math.max(weapon.offset.s, 1e-6)
  const markers =
    scene && grips.length > 0
      ? createPortal(
          <>
            {grips.map((g) => (
              <GripMarker key={g.side} position={g.position} side={g.side} radius={markerRadius} main={g.main} />
            ))}
          </>,
          helper
        )
      : null

  if (!gizmo || !scene) return markers
  return (
    <>
      {markers}
      <TransformControls
        ref={gizmoRef as never}
        object={helper}
        mode={gizmo}
        space="local"
        size={0.7}
        onMouseDown={() => {
          dragging.current = true
        }}
        onObjectChange={() => {
          if (dragging.current) previewWeaponOffset(weapon.id, offsetOf(helper, weapon.offset.s))
        }}
        onMouseUp={() => {
          if (!dragging.current) return
          dragging.current = false
          commitWeaponOffset(weapon.id, offsetOf(helper, weapon.offset.s))
        }}
      />
    </>
  )
}

/** The weapon hit by a click, with the hit point and normal in the weapon's own (Blender) coordinates. */
export function weaponHit(hit: Intersection, scene: Object3D): { point: [number, number, number]; normal: [number, number, number] } {
  const local = scene.worldToLocal(hit.point.clone())
  const mesh = hit.object as Mesh
  const n = hit.face ? hit.face.normal.clone() : new Vector3(0, 1, 0)
  // the face normal is in the mesh's space: bring it into the weapon scene's space
  const rel = scene.matrixWorld.clone().invert().multiply(mesh.matrixWorld)
  n.applyMatrix3(new Matrix3().getNormalMatrix(rel)).normalize()
  return { point: vecT2B(local), normal: vecT2B(n) }
}

export function WeaponsLayer({
  bound,
  rig,
  matrices,
  weapons,
  tools
}: {
  bound: BoundRig
  rig: RigJson
  /** composePose weaponMatrices (armature space, column-major) for the pose shown. */
  matrices: Record<string, number[]>
  weapons: WeaponEntry[]
  tools: boolean
}) {
  const selected = useStore((s) => s.weaponSelection)
  const tool = useStore((s) => s.weaponTool)
  const selectWeapon = useStore((s) => s.selectWeapon)
  const camera = useThree((s) => s.camera)
  const gl = useThree((s) => s.gl)
  const gizmoRef = useRef<ControlsLike | null>(null)

  // Weapons step clicks: select a weapon, or set the selected weapon's grip / support point.
  useEffect(() => {
    if (!tools) return
    const el = gl.domElement
    let down: { x: number; y: number; onGizmo: boolean } | null = null
    const onDown = (e: PointerEvent) => {
      down = e.button === 0 ? { x: e.clientX, y: e.clientY, onGizmo: !!gizmoRef.current?.axis } : null
    }
    const onClick = (e: MouseEvent) => {
      if (!down || down.onGizmo || Math.hypot(e.clientX - down.x, e.clientY - down.y) > CLICK_SLOP_PX) return
      const rect = el.getBoundingClientRect()
      const ndc = new Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1)
      const ray = new Raycaster()
      ray.setFromCamera(ndc, camera)
      const s = useStore.getState()
      let best: { id: string; hit: Intersection; scene: Object3D } | null = null
      for (const p of placed.values()) {
        if (!p.attach.visible) continue
        const hit = ray.intersectObject(p.scene, true)[0]
        if (hit && (!best || hit.distance < best.hit.distance)) best = { id: p.id, hit, scene: p.scene }
      }
      if (!best) return
      const sel = s.weaponSelection
      if (sel === best.id && (s.weaponTool === 'grip' || s.weaponTool === 'support')) {
        const { point, normal } = weaponHit(best.hit, best.scene)
        if (s.weaponTool === 'grip') setGripPoint(best.id, point)
        else setSupportGrip(best.id, point, normal, s.weaponInfo[best.id]?.principal_axis ?? [0, 0, 1])
      } else selectWeapon(best.id)
    }
    el.addEventListener('pointerdown', onDown, true)
    el.addEventListener('click', onClick)
    return () => {
      el.removeEventListener('pointerdown', onDown, true)
      el.removeEventListener('click', onClick)
    }
  }, [tools, gl, camera, selectWeapon])

  return (
    <>
      {weapons.map((w) => (
        <WeaponObject
          key={w.id}
          bound={bound}
          rig={rig}
          matrix={matrices[w.id]}
          weapon={w}
          showGrips={tools}
          gizmo={tools && selected === w.id && (tool === 'move' || tool === 'rotate') ? (tool === 'move' ? 'translate' : 'rotate') : null}
          gizmoRef={gizmoRef}
        />
      ))}
    </>
  )
}
