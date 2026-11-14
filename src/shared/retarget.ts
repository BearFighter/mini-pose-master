// SPDX-License-Identifier: GPL-3.0-or-later
// contracts section 6: retarget a clip frame onto a rig by copying bone directions (never bone axes).
import { Quaternion, Vector3 } from 'three'
import type { ClipFrame } from './clip'
import type { Deltas } from './fk'
import { canonicalIndex, restJoints } from './fk'
import { frameDelta, mul, q4, rotate, rotBetween, v3, wxyz } from './math'
import type { RigJson } from './rig'
import { BONES } from './skeleton'

const TORSO = new Set(['hips', 'spine', 'chest', 'neck'])
const FOLD_MIN = Math.sin((12 * Math.PI) / 180)

/** The clip rotation that drives a bone is stored at the bone's head joint. */
const ROT_JOINT: Record<string, string> = {
  head: 'head',
  'hand.L': 'wrist_L',
  'hand.R': 'wrist_R',
  'foot.L': 'ankle_L',
  'foot.R': 'ankle_R'
}

function side(J: Record<string, Vector3>, a: string, b: string): Vector3 | null {
  return J[a] && J[b] ? J[a].clone().sub(J[b]) : null
}

function torsoSide(J: Record<string, Vector3>, bone: string): Vector3 | null {
  const hips = side(J, 'hip_L', 'hip_R')
  const chest = side(J, 'shoulder_L', 'shoulder_R')
  if (bone === 'hips') return hips
  if (bone === 'chest' || bone === 'neck') return chest
  if (bone === 'spine') return hips && chest ? hips.clone().normalize().add(chest.clone().normalize()) : hips ?? chest
  return null
}

const dir = (J: Record<string, Vector3>, head: string, tail: string): Vector3 | null =>
  J[head] && J[tail] ? J[tail].clone().sub(J[head]) : null

/** Canonical deltas for one clip frame (by canonical bone name), then mapped to rig bone indices. */
export function retargetCanonical(rig: RigJson, frame: ClipFrame): Map<string, Quaternion> {
  const R = restJoints(rig)
  const T: Record<string, Vector3> = {}
  for (const [k, p] of Object.entries(frame.joints)) T[k] = v3(p)
  const D = new Map<string, Quaternion>()
  const byName = new Map(BONES.map((b) => [b.name, b]))
  const inherited = (name: string): Quaternion => {
    let p = byName.get(name)?.parent ?? null
    while (p) {
      const d = D.get(p)
      if (d) return d.clone()
      p = byName.get(p)?.parent ?? null
    }
    return new Quaternion()
  }
  for (const b of BONES) {
    if (b.name.startsWith('grip.')) continue // sockets follow the hand
    const dT = dir(T, b.head, b.tail)
    const dR = dir(R, b.head, b.tail)
    if (!dT || !dR || dT.lengthSq() < 1e-14 || dR.lengthSq() < 1e-14) continue
    const s = b.name.endsWith('.L') ? 'L' : b.name.endsWith('.R') ? 'R' : null
    let q: Quaternion | null = null
    if (TORSO.has(b.name)) {
      const sT = torsoSide(T, b.name)
      const sR = torsoSide(R, b.name)
      if (sT && sR) q = frameDelta(dT, sT, dR, sR)
    } else if (b.name in ROT_JOINT && frame.rot[ROT_JOINT[b.name]]) {
      const qr = q4(frame.rot[ROT_JOINT[b.name]])
      let secT: Vector3 | null = null
      let secR: Vector3 | null = null
      if (b.name === 'head') {
        secT = rotate(qr, new Vector3(0, -1, 0))
        secR = new Vector3(0, -1, 0)
      } else if (b.name.startsWith('hand.') && s && rig.hands[s]) {
        secT = rotate(qr, new Vector3(0, 0, -1))
        secR = v3(rig.hands[s]!.palm_normal)
      } else if (b.name.startsWith('foot.')) {
        secT = rotate(qr, new Vector3(0, 0, 1))
        secR = new Vector3(0, 0, 1)
      }
      if (secT && secR) q = frameDelta(dT, secT, dR, secR)
    } else if ((b.name.startsWith('upper_arm.') || b.name.startsWith('thigh.')) && s) {
      const child = (b.name.startsWith('upper_arm.') ? 'forearm.' : 'shin.') + s
      const cb = byName.get(child)!
      const lT = dir(T, cb.head, cb.tail)
      const lR = dir(R, cb.head, cb.tail)
      if (lT && lR) {
        const u = dT.clone().normalize()
        const foldT = lT.clone().normalize().sub(u.clone().multiplyScalar(lT.clone().normalize().dot(u)))
        if (foldT.length() > FOLD_MIN) {
          const ur = dR.clone().normalize()
          let foldR = lR.clone().normalize().sub(ur.clone().multiplyScalar(lR.clone().normalize().dot(ur)))
          if (foldR.length() <= FOLD_MIN) {
            const hint = b.name.startsWith('upper_arm.') ? new Vector3(0, -1, 0) : new Vector3(0, 1, 0)
            foldR = hint.sub(ur.clone().multiplyScalar(hint.dot(ur)))
          }
          q = frameDelta(dT, foldT, dR, foldR)
        }
      }
    }
    if (!q) {
      const Dinh = inherited(b.name)
      const c = rotate(Dinh, dR)
      q = mul(rotBetween(c, dT), Dinh)
    }
    D.set(b.name, q.normalize())
  }
  return D
}

/** Rig deltas (by rig.json bone index) for one clip frame; unmapped bones are left out (D_parent). */
export function retargetFrame(rig: RigJson, frame: ClipFrame): Deltas {
  const canon = retargetCanonical(rig, frame)
  const ci = canonicalIndex(rig)
  const out: Deltas = {}
  for (const [name, q] of canon) {
    const i = ci.get(name)
    if (i !== undefined) out[String(i)] = wxyz(q)
  }
  return out
}
