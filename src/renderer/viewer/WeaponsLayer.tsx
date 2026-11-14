// SPDX-License-Identifier: GPL-3.0-or-later
// Weapons on the posed rig (contracts section 12). Each weapon hangs under the armature node:
//   attach (matrix = C^-1 * A * C, A = attachFrame of its socket) -> helper (C^-1 * TRS(offset) * C)
//   -> the weapon GLB (three.js coordinates). The helper is what the gizmo moves (offset.t / offset.q).
// In the Weapons step a click selects a weapon, or sets its grip / support point.
import { TransformControls } from '@react-three/drei'
import { useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef, useState } from 'react'
import { type Intersection, Matrix3, type Mesh, Object3D, Raycaster, Vector2, Vector3 } from 'three'
import { quatB2T, quatT2B, vecB2T, vecT2B } from '../../shared/coords'
import type { Deltas } from '../../shared/fk'
import type { WeaponEntry } from '../../shared/project'
import type { BoundRig, RigJson } from '../../shared/rig'
import { attachFrame, type WeaponOffset } from '../../shared/weaponPose'
import { cleanError } from '../api'
import { projectUrl } from '../lib/paths'
import { m4B2T } from '../lib/weapons'
import { useStore } from '../store'
import { commitWeaponOffset, previewWeaponOffset, setGripPoint, setSupportGrip } from '../store/weaponActions'
import { disposeObject, loadGltf } from './gltf'
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

function WeaponObject({
  bound,
  rig,
  deltas,
  weapon,
  gizmo,
  gizmoRef
}: {
  bound: BoundRig
  rig: RigJson
  deltas: Deltas
  weapon: WeaponEntry
  gizmo: 'translate' | 'rotate' | null
  gizmoRef: React.MutableRefObject<ControlsLike | null>
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

  // The attach frame follows the pose; the helper carries the offset (unless the gizmo is moving it).
  useEffect(() => {
    const A = attachFrame(rig, deltas, weapon.attach_bone)
    attach.visible = A !== null
    if (A) attach.matrix.copy(m4B2T(A))
    attach.matrixWorldNeedsUpdate = true
    if (!dragging.current) {
      helper.position.copy(vecB2T(weapon.offset.t))
      helper.quaternion.copy(quatB2T(weapon.offset.q))
      helper.scale.setScalar(weapon.offset.s)
    }
    attach.updateMatrixWorld(true)
    invalidate()
  }, [rig, deltas, weapon, attach, helper, invalidate, scene])

  if (!gizmo || !scene) return null
  return (
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
  deltas,
  weapons,
  tools
}: {
  bound: BoundRig
  rig: RigJson
  deltas: Deltas
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
          deltas={deltas}
          weapon={w}
          gizmo={tools && selected === w.id && (tool === 'move' || tool === 'rotate') ? (tool === 'move' ? 'translate' : 'rotate') : null}
          gizmoRef={gizmoRef}
        />
      ))}
    </>
  )
}
