// SPDX-License-Identifier: GPL-3.0-or-later
// contracts section 10: hand poses in a geometry-based finger frame (works on imported rigs too).
import { Matrix4, Quaternion, Vector3 } from 'three'
import type { Deltas } from './fk'
import { canonicalIndex, resolveDeltas } from './fk'
import { inv, mul, q4, v3, wxyz } from './math'
import type { RigJson } from './rig'

export type FingerName = 'thumb' | 'index' | 'middle' | 'ring' | 'pinky'
export const FINGERS: FingerName[] = ['thumb', 'index', 'middle', 'ring', 'pinky']

export interface FingerPose {
  flex: [number, number, number]
  spread?: number
  roll?: number
}

export interface HandPose {
  schema: 'mpm.hand/1'
  name: string
  fingers: Record<FingerName, FingerPose>
}

const RAD = Math.PI / 180

/** F_b = [x, d, z] with d along the bone and z the palm normal made perpendicular to d. */
export function fingerFrame(rig: RigJson, boneIndex: number, side: 'L' | 'R'): Quaternion {
  const b = rig.bones[boneIndex]
  const hands = rig.hands[side]
  if (!hands) throw new Error(`rig has no ${side} hand frame`)
  const d = v3(b.tail).sub(v3(b.head)).normalize()
  const n = v3(hands.palm_normal)
  const z = n.clone().sub(d.clone().multiplyScalar(n.dot(d))).normalize()
  const x = new Vector3().crossVectors(d, z).normalize()
  return new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(x, d, z)).normalize()
}

/** Local delta L = Rz(+-spread) * Rx(flex) * Ry(roll), in degrees. */
export function localDelta(flex: number, spread: number, roll: number, side: 'L' | 'R'): Quaternion {
  const sp = (side === 'L' ? 1 : -1) * spread
  const Rz = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), sp * RAD)
  const Rx = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), flex * RAD)
  const Ry = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), roll * RAD)
  return mul(mul(Rz, Rx), Ry)
}

/** Apply a hand pose to one side: D_b = D_parent * F_b * L * F_b^T, parents first. Returns new deltas. */
export function applyHandPose(rig: RigJson, deltas: Deltas, side: 'L' | 'R', pose: HandPose): Deltas {
  if (!rig.hands[side]) return { ...deltas }
  const out: Deltas = { ...deltas }
  const ci = canonicalIndex(rig)
  const hand = ci.get(`hand.${side}`)
  if (hand === undefined) return out
  const resolved = resolveDeltas(rig, out)
  for (const f of FINGERS) {
    const fp = pose.fingers[f]
    if (!fp) continue
    let Dparent = q4(resolved[String(hand)])
    for (let k = 1; k <= 3; k++) {
      const idx = ci.get(`${f}.0${k}.${side}`)
      if (idx === undefined) break
      const F = fingerFrame(rig, idx, side)
      const L = localDelta(fp.flex[k - 1] ?? 0, k === 1 ? fp.spread ?? 0 : 0, k === 1 ? fp.roll ?? 0 : 0, side)
      const D = mul(mul(mul(Dparent, F), L), inv(F)).normalize()
      out[String(idx)] = wxyz(D)
      Dparent = D
    }
  }
  return out
}
