// SPDX-License-Identifier: GPL-3.0-or-later
// Pose-library clips (contracts section 9): index.json + clips/<id>.f32 reader.
import type { QuatWXYZ, Vec3 } from './coords'

export interface PackClip {
  id: string
  move: string
  style: string
  tags: string[]
  frames: number
  fps: number
  key_frames: number[]
}

export interface PackIndex {
  schema: 'mpm.pack/1'
  pack: string
  title: string
  license: string
  license_url: string
  exportable: boolean
  joints: string[]
  has_fingers: boolean
  clips: PackClip[]
}

/** One clip frame: canonical joint positions (normalised, metres, Blender frame), rotations relative to
 * the reference pose (T-pose facing -Y, palms down, feet flat), and floor contacts. */
export interface ClipFrame {
  joints: Record<string, Vec3>
  rot: Record<string, QuatWXYZ>
  contacts: { L: boolean; R: boolean }
}

export interface Clip {
  frames: number
  jointNames: string[]
  frame(i: number): ClipFrame
}

export function parseClipF32(buf: ArrayBuffer, jointNames: string[]): Clip {
  const dv = new DataView(buf)
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3))
  if (magic !== 'MPM0') throw new Error('not an MPM0 clip')
  const F = dv.getUint32(4, true)
  const J = dv.getUint32(8, true)
  const version = dv.getUint32(12, true)
  if (version !== 1) throw new Error(`unsupported clip version ${version}`)
  if (J !== jointNames.length) throw new Error(`clip has ${J} joints, index lists ${jointNames.length}`)
  const body = new Float32Array(buf, 16, F * J * 7)
  const contacts = new Uint32Array(buf, 16 + F * J * 7 * 4, F)
  return {
    frames: F,
    jointNames,
    frame(i: number): ClipFrame {
      if (i < 0 || i >= F) throw new RangeError(`frame ${i} out of 0..${F - 1}`)
      const joints: Record<string, Vec3> = {}
      const rot: Record<string, QuatWXYZ> = {}
      for (let j = 0; j < J; j++) {
        const o = (i * J + j) * 7
        joints[jointNames[j]] = [body[o], body[o + 1], body[o + 2]]
        rot[jointNames[j]] = [body[o + 3], body[o + 4], body[o + 5], body[o + 6]]
      }
      const c = contacts[i]
      return { joints, rot, contacts: { L: (c & 1) !== 0, R: (c & 2) !== 0 } }
    }
  }
}

/** Build an .f32 buffer (used by tests and by in-renderer imports). */
export function writeClipF32(frames: ClipFrame[], jointNames: string[]): ArrayBuffer {
  const F = frames.length
  const J = jointNames.length
  const buf = new ArrayBuffer(16 + F * J * 7 * 4 + F * 4)
  const dv = new DataView(buf)
  'MPM0'.split('').forEach((ch, k) => dv.setUint8(k, ch.charCodeAt(0)))
  dv.setUint32(4, F, true)
  dv.setUint32(8, J, true)
  dv.setUint32(12, 1, true)
  const body = new Float32Array(buf, 16, F * J * 7)
  const contacts = new Uint32Array(buf, 16 + F * J * 7 * 4, F)
  frames.forEach((fr, i) => {
    jointNames.forEach((n, j) => {
      const p = fr.joints[n] ?? [0, 0, 0]
      const q = fr.rot[n] ?? [1, 0, 0, 0]
      body.set([p[0], p[1], p[2], q[0], q[1], q[2], q[3]], (i * J + j) * 7)
    })
    contacts[i] = (fr.contacts.L ? 1 : 0) | (fr.contacts.R ? 2 : 0)
  })
  return buf
}
