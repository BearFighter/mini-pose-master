# SPDX-License-Identifier: GPL-3.0-or-later
"""Posed bone and skinned-vertex dumps for the GLB <-> three.js conformance tests (WP5, contracts s16
dump_skinned)."""

import bpy
import numpy as np

from . import pose as PO


def hips_index(rig):
    return next((b["index"] for b in rig["bones"] if b.get("canonical") == "hips"), None)


def dump(arm, meshes, rig, pose_state, sample):
    """Apply `pose_state` (mpm.pose/1) and return posed bones + skinned positions.

    sample: {mesh_name: [vertex indices]} or "all". Positions are Blender coordinates, metres, taken from
    the evaluated (armature-deformed) mesh; rig.blend has no subdivision.
    """
    PO.apply_pose_state(arm, pose_state.get("deltas", {}), pose_state.get("root_offset", (0, 0, 0)),
                        hips_index=hips_index(rig))
    dg = bpy.context.evaluated_depsgraph_get()
    out = {"meshes": {}, "bones": []}
    for o in meshes:
        ev = o.evaluated_get(dg)
        me = ev.to_mesh()
        co = np.empty(len(me.vertices) * 3, np.float32)
        me.vertices.foreach_get("co", co)
        co = co.reshape(-1, 3).astype(np.float64)
        M = np.array(o.matrix_world)
        co = co @ M[:3, :3].T + M[:3, 3]
        ev.to_mesh_clear()
        idx = list(range(len(co))) if sample == "all" else [int(i) for i in sample.get(o.name, [])]
        out["meshes"][o.name] = {"indices": idx, "positions": [[float(x) for x in co[i]] for i in idx]}
    for i, b in enumerate(arm.data.bones):
        pb = arm.pose.bones[b.name]
        out["bones"].append({"index": i, "head": [float(x) for x in arm.matrix_world @ pb.head],
                             "tail": [float(x) for x in arm.matrix_world @ pb.tail]})
    return out
