// SPDX-License-Identifier: GPL-3.0-or-later
// contracts section 4: derived joints and hand frames from editable markers. Mirrors
// engine/mpm/skeleton.py derive_joints / hand_frame exactly (tested against rig.json joints).
import { Vector3 } from 'three'
import type { Vec3 } from './coords'
import { JOINTS } from './skeleton'

export interface DerivedHandFrame {
  hand_axis: Vector3
  lateral: Vector3
  palm_normal: Vector3
  hand_width: number
  grip_axis: Vector3
}

const V = (p: Vec3 | Vector3): Vector3 => (p instanceof Vector3 ? p.clone() : new Vector3(p[0], p[1], p[2]))
const lerp = (a: Vector3, b: Vector3, t: number): Vector3 => a.clone().lerp(b, t)
const unit = (v: Vector3): Vector3 => (v.lengthSq() > 1e-24 ? v.clone().normalize() : v.clone())

export function handFrame(J: Record<string, Vector3>, s: 'L' | 'R'): DerivedHandFrame {
  const wrist = J[`wrist_${s}`]
  const ha = unit(J[`middle_0_${s}`].clone().sub(wrist))
  const lat = unit(J[`index_0_${s}`].clone().sub(J[`pinky_0_${s}`]))
  const pn = s === 'L' ? unit(new Vector3().crossVectors(ha, lat)) : unit(new Vector3().crossVectors(lat, ha))
  const ga = unit(lat.clone().sub(ha.clone().multiplyScalar(lat.dot(ha))))
  return { hand_axis: ha, lateral: lat, palm_normal: pn, hand_width: J[`index_0_${s}`].distanceTo(J[`pinky_0_${s}`]), grip_axis: ga }
}

/** All 68 canonical joints from the editable markers. Throws if a needed marker is missing. */
export function deriveJoints(markers: Record<string, Vec3 | Vector3>): Record<string, Vector3> {
  const J: Record<string, Vector3> = {}
  for (const [k, v] of Object.entries(markers)) J[k] = V(v)
  const need = (k: string): Vector3 => {
    const v = J[k]
    if (!v) throw new Error(`marker ${k} is missing`)
    return v
  }
  const pel = need('pelvis')
  const neck = need('neck')
  J.spine0 = lerp(pel, need('chest'), 0.3)
  for (const [s, sign] of [['L', 1], ['R', -1]] as const) {
    const sh = need(`shoulder_${s}`)
    J[`clav_${s}`] = new Vector3(pel.x + sign * 0.18 * Math.abs(sh.x - pel.x), neck.y, neck.z - 0.25 * (neck.z - sh.z))
    const ank = need(`ankle_${s}`)
    const toe = need(`toe_${s}`)
    const ball = lerp(ank, toe, 0.68)
    ball.z = 0.35 * ank.z + 0.65 * toe.z
    J[`ball_${s}`] = ball
    for (const f of ['index', 'middle', 'ring', 'pinky']) {
      const a = need(`${f}_0_${s}`)
      const t = need(`${f}_tip_${s}`)
      J[`${f}_1_${s}`] = lerp(a, t, 0.45)
      J[`${f}_2_${s}`] = lerp(a, t, 0.75)
    }
    const ta = need(`thumb_0_${s}`)
    const tt = need(`thumb_tip_${s}`)
    J[`thumb_1_${s}`] = lerp(ta, tt, 0.4)
    J[`thumb_2_${s}`] = lerp(ta, tt, 0.73)
    const fr = handFrame(J, s)
    const centre = [`index_0_${s}`, `middle_0_${s}`, `ring_0_${s}`, `pinky_0_${s}`, `wrist_${s}`]
      .map((k) => J[k])
      .reduce((acc, v) => acc.add(v), new Vector3())
      .multiplyScalar(1 / 5)
    J[`grip_${s}`] = centre.add(fr.palm_normal.clone().multiplyScalar(0.35 * fr.hand_width))
    J[`grip_tip_${s}`] = J[`grip_${s}`].clone().add(fr.grip_axis.clone().multiplyScalar(0.1))
  }
  const missing = JOINTS.map((j) => j.name).filter((n) => !J[n])
  if (missing.length) throw new Error(`joints missing after derivation: ${missing.join(', ')}`)
  return J
}

export const EDITABLE: string[] = JOINTS.filter((j) => j.editable).map((j) => j.name)
