// SPDX-License-Identifier: GPL-3.0-or-later
// contracts section 13: the pose state handed to the bake (every bone resolved).
import type { QuatWXYZ, Vec3 } from './coords'
import type { Deltas } from './fk'
import { resolveDeltas } from './fk'
import type { RigJson } from './rig'

export interface PoseEdit {
  bone: number
  q: QuatWXYZ
}

export interface PoseProvenance {
  pack: string | null
  clip: string | null
  frame: number | null
  mirrored: boolean
  edits: PoseEdit[]
}

export interface PoseState {
  schema: 'mpm.pose/1'
  rig_hash: string
  root_offset: Vec3
  deltas: Deltas
  provenance: PoseProvenance
}

export function makePoseState(
  rig: RigJson,
  deltas: Deltas,
  rootOffset: Vec3,
  provenance: PoseProvenance = { pack: null, clip: null, frame: null, mirrored: false, edits: [] }
): PoseState {
  return {
    schema: 'mpm.pose/1',
    rig_hash: rig.hash,
    root_offset: rootOffset,
    deltas: resolveDeltas(rig, deltas),
    provenance
  }
}
