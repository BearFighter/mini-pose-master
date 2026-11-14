// SPDX-License-Identifier: GPL-3.0-or-later
// derive.ts must reproduce the engine's derived joints (rig.json joints came from skeleton.py).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EDITABLE, deriveJoints, handFrame } from '../../src/shared/derive'
import type { RigJson } from '../../src/shared/rig'

const rig = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'rig_auto_apose.json'), 'utf8')) as RigJson

describe('derived joints (contracts section 4)', () => {
  it('matches the engine on the auto rig to 1e-6 m', () => {
    const markers = Object.fromEntries(EDITABLE.map((k) => [k, rig.joints[k]]))
    const J = deriveJoints(markers)
    expect(Object.keys(J).length).toBe(68)
    let worst = 0
    for (const [k, v] of Object.entries(rig.joints)) {
      worst = Math.max(worst, Math.hypot(J[k].x - v[0], J[k].y - v[1], J[k].z - v[2]))
    }
    expect(worst).toBeLessThan(1e-6)
    for (const s of ['L', 'R'] as const) {
      const fr = handFrame(J, s)
      const pn = rig.hands[s]!.palm_normal
      expect(fr.palm_normal.x * pn[0] + fr.palm_normal.y * pn[1] + fr.palm_normal.z * pn[2]).toBeGreaterThan(0.999999)
    }
  })
  it('names the missing marker', () => {
    const markers = Object.fromEntries(EDITABLE.filter((k) => k !== 'toe_R').map((k) => [k, rig.joints[k]]))
    expect(() => deriveJoints(markers)).toThrow(/toe_R/)
  })
})
