// SPDX-License-Identifier: GPL-3.0-or-later
// contracts section 5 mirror: D' = S D_swap S with S = diag(-1, 1, 1); [w,x,y,z] -> [w,x,-y,-z].
import type { Vec3 } from './coords'
import type { Deltas } from './fk'
import { resolveDeltas } from './fk'
import type { RigJson } from './rig'
import { mirrorName } from './skeleton'

/** Rig bone index of each bone's mirror partner (by canonical name, else by bone name, else itself). */
export function mirrorPartners(rig: RigJson): number[] {
  const byCanon = new Map<string, number>()
  const byName = new Map<string, number>()
  rig.bones.forEach((b, i) => {
    if (b.canonical) byCanon.set(b.canonical, i)
    byName.set(b.name, i)
  })
  const nameMirror = (n: string): string =>
    n
      .replace(/^(.*)Left(.*)$/, '$1\u0000$2')
      .replace(/^(.*)Right(.*)$/, '$1Left$2')
      .replace('\u0000', 'Right')
      .replace(/_l$/, '\u0001')
      .replace(/_r$/, '_l')
      .replace('\u0001', '_r')
      .replace(/ L /, ' \u0002 ')
      .replace(/ R /, ' L ')
      .replace(' \u0002 ', ' R ')
  return rig.bones.map((b, i) => {
    if (b.canonical) {
      const m = byCanon.get(mirrorName(b.canonical))
      if (m !== undefined) return m
    }
    const m = byName.get(mirrorName(b.name)) ?? byName.get(nameMirror(b.name))
    return m ?? i
  })
}

/**
 * Mirrors a pose. Only bones with a canonical name carry a pose of their own; every other bone (twist
 * bones, end bones, props) follows its parent (contracts section 8), so after a mirror it follows its
 * parent's mirrored pose rather than taking a mirrored copy of what it had on the other side.
 */
export function mirrorPose(rig: RigJson, deltas: Deltas, rootOffset: Vec3): { deltas: Deltas; rootOffset: Vec3 } {
  const res = resolveDeltas(rig, deltas)
  const partner = mirrorPartners(rig)
  const own: Deltas = {}
  rig.bones.forEach((b, i) => {
    if (!b.canonical) return
    const [w, x, y, z] = res[String(partner[i])]
    own[String(i)] = w < 0 ? [-w, -x, y, z] : [w, x, -y, -z]
  })
  return { deltas: resolveDeltas(rig, own), rootOffset: [-rootOffset[0], rootOffset[1], rootOffset[2]] }
}
