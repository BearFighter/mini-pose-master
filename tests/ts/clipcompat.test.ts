// SPDX-License-Identifier: GPL-3.0-or-later
// The TS clip reader must read clips written by the Python converter (tests/engine/test_convert.py
// writes tests/golden/convert/synth.f32 + synth.json from a synthetic BVH).
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseClipF32 } from '../../src/shared/clip'

const DIR = join(__dirname, '..', 'golden', 'convert')
const present = existsSync(join(DIR, 'synth.f32'))
if (!present && process.env.MPM_REQUIRE_GOLDEN !== '1') console.warn('clipcompat: no Python-written clip - skipped')

describe.skipIf(!present && process.env.MPM_REQUIRE_GOLDEN !== '1')('Python -> TS clip compatibility', () => {
  it('reads frames, joints and contacts exactly', () => {
    const meta = JSON.parse(readFileSync(join(DIR, 'synth.json'), 'utf8')) as {
      joints: string[]
      frames: number
      frame5_head: number[]
      contacts: number[]
    }
    const buf = readFileSync(join(DIR, 'synth.f32'))
    const clip = parseClipF32(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), meta.joints)
    expect(clip.frames).toBe(meta.frames)
    const f5 = clip.frame(5)
    const want = meta.frame5_head
    expect(f5.joints.head).toEqual(want.slice(0, 3).map((x) => Math.fround(x)))
    expect(f5.rot.head).toEqual(want.slice(3, 7).map((x) => Math.fround(x)))
    meta.contacts.forEach((c, i) => {
      const fr = clip.frame(i)
      expect((fr.contacts.L ? 1 : 0) | (fr.contacts.R ? 2 : 0)).toBe(c)
    })
  })
})
