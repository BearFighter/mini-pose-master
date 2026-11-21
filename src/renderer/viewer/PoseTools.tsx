// SPDX-License-Identifier: GPL-3.0-or-later
// Pose step tools on the bound rig: clickable joint dots, mesh picking (largest skin weight on the
// hit face), the selected bone highlighted, and the rotation / hand-reach gizmo (contracts section 13).
import { Line, TransformControls } from '@react-three/drei'
import { useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import {
  BackSide,
  BufferAttribute,
  type Group,
  type Intersection,
  Object3D,
  Quaternion,
  Raycaster,
  type SkinnedMesh,
  Vector2,
  Vector3
} from 'three'
import { vecB2T, vecT2B } from '../../shared/coords'
import type { Deltas } from '../../shared/fk'
import { canonicalIndex, posedBones } from '../../shared/fk'
import type { BoundRig, RigJson } from '../../shared/rig'
import { canonicalFor, canonicalTree, gizmoDelta, helperPose } from '../lib/pose'
import { useStore } from '../store'
import { commitReach, commitRotate, previewReach, previewRotate } from '../store/poseActions'
import { rigView, skinnedMeshes } from './rigView'

/** Alt held: rotate the bone only (chain: false). */
const keys = { alt: false }
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => (keys.alt = e.altKey))
  window.addEventListener('keyup', (e) => (keys.alt = e.altKey))
  window.addEventListener('blur', () => (keys.alt = false))
}

const CLICK_SLOP_PX = 4

/** The rig bone with the largest summed skin weight on the hit face's three vertices. */
export function boneFromHit(hit: Intersection, bound: BoundRig): number | null {
  const mesh = hit.object as SkinnedMesh
  const face = hit.face
  if (!face || !mesh.isSkinnedMesh) return null
  const si = mesh.geometry.getAttribute('skinIndex') as BufferAttribute | undefined
  const sw = mesh.geometry.getAttribute('skinWeight') as BufferAttribute | undefined
  if (!si || !sw) return null
  const weight = new Map<number, number>()
  for (const v of [face.a, face.b, face.c]) {
    for (let k = 0; k < si.itemSize; k++) {
      const w = sw.getComponent(v, k)
      if (w > 0) weight.set(si.getComponent(v, k), (weight.get(si.getComponent(v, k)) ?? 0) + w)
    }
  }
  let best = -1
  let bestW = 0
  for (const [j, w] of weight) if (w > bestW) [best, bestW] = [j, w]
  const obj = best >= 0 ? mesh.skeleton.bones[best] : undefined
  const i = obj ? bound.bones.indexOf(obj) : -1
  return i >= 0 ? i : null
}

interface ControlsLike {
  axis: string | null
}

export function PoseTools({ bound, rig, deltas }: { bound: BoundRig; rig: RigJson; deltas: Deltas }) {
  const selected = useStore((s) => s.boneSelection)
  const tool = useStore((s) => s.poseTool)
  const boneOnly = useStore((s) => s.boneOnly)
  const selectBone = useStore((s) => s.selectBone)
  const camera = useThree((s) => s.camera)
  const gl = useThree((s) => s.gl)
  const invalidate = useThree((s) => s.invalidate)
  const dots = useRef<Group>(null)
  const gizmo = useRef<ControlsLike | null>(null)

  const tree = useMemo(() => canonicalTree(rig), [rig])
  const posed = useMemo(() => posedBones(rig, deltas), [rig, deltas])
  const height = rig.height_m || 1.8
  const selIndex = selected ? canonicalIndex(rig).get(selected) : undefined

  // Click picking: joint dots first, then the skinned mesh (three's skinned raycast, on click only).
  useEffect(() => {
    const el = gl.domElement
    let down: { x: number; y: number; onGizmo: boolean } | null = null
    const onDown = (e: PointerEvent) => {
      // the gizmo's hovered axis is known before it starts a drag (and cleared when it ends)
      down = e.button === 0 ? { x: e.clientX, y: e.clientY, onGizmo: !!gizmo.current?.axis } : null
    }
    const onClick = (e: MouseEvent) => {
      if (!down || down.onGizmo || Math.hypot(e.clientX - down.x, e.clientY - down.y) > CLICK_SLOP_PX) return
      if (gizmo.current?.axis) return // a click on the gizmo
      const rect = el.getBoundingClientRect()
      const ndc = new Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1)
      const ray = new Raycaster()
      ray.setFromCamera(ndc, camera)
      const dotHit = dots.current ? ray.intersectObjects(dots.current.children, false)[0] : undefined
      if (dotHit) {
        selectBone((dotHit.object.userData.bone as string) ?? null)
        return
      }
      const hit = ray.intersectObjects(skinnedMeshes(bound), false)[0]
      const i = hit ? boneFromHit(hit, bound) : null
      selectBone(i !== null ? canonicalFor(rig, i) : null)
    }
    el.addEventListener('pointerdown', onDown, true)
    el.addEventListener('click', onClick)
    return () => {
      el.removeEventListener('pointerdown', onDown, true)
      el.removeEventListener('click', onClick)
    }
  }, [gl, camera, bound, rig, selectBone])

  const highlight = useMemo((): [Vector3, Vector3] | null => {
    if (selIndex === undefined) return null
    const h = vecB2T([posed[selIndex].head.x, posed[selIndex].head.y, posed[selIndex].head.z])
    const t = vecB2T([posed[selIndex].tail.x, posed[selIndex].tail.y, posed[selIndex].tail.z])
    return [h, t]
  }, [posed, selIndex])

  return (
    <>
      <group ref={dots}>
        {tree.map(({ name, index }) => {
          const p = posed[index].head
          const t = vecB2T([p.x, p.y, p.z])
          const isSel = name === selected
          return (
            <mesh key={name} position={t} userData={{ bone: name }} renderOrder={12}>
              <sphereGeometry args={[(isSel ? 0.009 : 0.0055) * height, 16, 10]} />
              <meshStandardMaterial
                color={isSel ? '#ffa94d' : '#e3f1ff'}
                emissive={isSel ? '#ffa94d' : '#9fd0f0'}
                emissiveIntensity={isSel ? 0.6 : 0.35}
                roughness={0.4}
                metalness={0}
                depthTest={false}
                depthWrite={false}
                transparent
                opacity={0.95}
              />
              {/* dark rim (child: the dot picking ray test is not recursive) */}
              <mesh renderOrder={11} scale={1.35}>
                <sphereGeometry args={[(isSel ? 0.009 : 0.0055) * height, 16, 10]} />
                <meshBasicMaterial color="#05080c" side={BackSide} depthTest={false} depthWrite={false} transparent opacity={0.7} toneMapped={false} />
              </mesh>
            </mesh>
          )
        })}
      </group>
      {highlight && (
        <Line
          points={highlight}
          lineWidth={3.5}
          color="#ffa94d"
          renderOrder={13}
          frustumCulled={false}
          depthTest={false}
          depthWrite={false}
          transparent
          toneMapped={false}
        />
      )}
      {selected && selIndex !== undefined && (
        <BoneGizmo
          key={`${selected}-${tool}`}
          bound={bound}
          rig={rig}
          deltas={deltas}
          bone={selected}
          index={selIndex}
          tool={tool === 'reach' && /^hand\.[LR]$/.test(selected) ? 'reach' : 'rotate'}
          boneOnly={boneOnly}
          gizmoRef={gizmo}
          onChange={invalidate}
        />
      )}
    </>
  )
}

/** Places the helper at bone i's posed head, oriented D_b * R_rest_b (lib/pose helperPose). */
export function placeHelper(helper: Object3D, rig: RigJson, deltas: Deltas, i: number): void {
  const { position, quaternion } = helperPose(rig, deltas, i)
  helper.position.copy(position)
  helper.quaternion.copy(quaternion)
  helper.updateMatrixWorld(true)
}

function BoneGizmo({
  bound,
  rig,
  deltas,
  bone,
  index,
  tool,
  boneOnly,
  gizmoRef,
  onChange
}: {
  bound: BoundRig
  rig: RigJson
  deltas: Deltas
  bone: string
  index: number
  tool: 'rotate' | 'reach'
  boneOnly: boolean
  gizmoRef: React.MutableRefObject<ControlsLike | null>
  onChange: () => void
}) {
  const helper = useMemo(() => new Object3D(), [])
  const drag = useRef<{ start: Quaternion; chain: boolean; moved: boolean } | null>(null)
  const side = (/^hand\.([LR])$/.exec(bone)?.[1] ?? 'L') as 'L' | 'R'

  const camera = useThree((s) => s.camera)
  const gl = useThree((s) => s.gl)
  useEffect(() => {
    bound.armature.add(helper)
    rigView.helper = helper
    rigView.camera = camera
    rigView.canvas = gl.domElement
    rigView.gizmo = gizmoRef.current
    return () => {
      bound.armature.remove(helper)
      if (rigView.helper === helper) rigView.helper = null
    }
  }, [bound, helper, camera, gl, gizmoRef])

  useEffect(() => {
    if (drag.current) return // the gizmo owns the helper while dragging
    placeHelper(helper, rig, deltas, index)
    onChange()
  }, [helper, rig, deltas, index, onChange])

  const final = (): void => {
    const d = drag.current
    drag.current = null
    if (!d || !d.moved) return
    if (tool === 'rotate') commitRotate(bone, gizmoDelta(d.start, helper.quaternion), d.chain)
    else commitReach(side, vecT2B(helper.position))
  }

  return (
    <TransformControls
      ref={gizmoRef as never}
      object={helper}
      mode={tool === 'rotate' ? 'rotate' : 'translate'}
      space={tool === 'rotate' ? 'local' : 'world'}
      size={tool === 'rotate' ? 0.7 : 0.6}
      onMouseDown={() => {
        drag.current = { start: helper.quaternion.clone(), chain: !(boneOnly || keys.alt), moved: false }
      }}
      onObjectChange={() => {
        const d = drag.current
        if (!d) return
        d.moved = true
        if (tool === 'rotate') previewRotate(bone, gizmoDelta(d.start, helper.quaternion), d.chain)
        else previewReach(side, vecT2B(helper.position))
      }}
      onMouseUp={final}
    />
  )
}
