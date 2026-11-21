# SPDX-License-Identifier: GPL-3.0-or-later
"""Pose application (contracts section 5) and the follow check (section 14 gates)."""

import bpy
import numpy as np
from mathutils import Matrix, Quaternion, Vector

MOVED_MIN = 0.05      # fraction of vertices that must move when any delta is non-identity
DRIFT_MAX = 0.01      # worst drift of a firmly weighted vertex from its bone, fraction of height
GROW_MAX = 2.0        # posed bbox max extent / rest bbox max extent


def topo_order(arm):
    """Bone indices (positions in arm.data.bones) with parents before children."""
    bones = list(arm.data.bones)
    index = {b.name: i for i, b in enumerate(bones)}
    out, seen = [], set()

    def visit(b):
        if b.name in seen:
            return
        if b.parent is not None:
            visit(b.parent)
        seen.add(b.name)
        out.append(index[b.name])

    for b in bones:
        visit(b)
    return out


def quat(q):
    """[w, x, y, z] -> mathutils.Quaternion (normalised)."""
    return Quaternion((float(q[0]), float(q[1]), float(q[2]), float(q[3]))).normalized()


def apply_pose_state(arm, deltas, root_offset=(0.0, 0.0, 0.0), hips_index=None):
    """Pose `arm` per contracts section 5.

    deltas: {bone index (int or str): [w, x, y, z]} armature-space deltas D_b. Missing -> D_parent.
    hips_index: index of the bone whose canonical name is `hips` (receives root_offset); if None the
    bone named "hips" is used when present.
    Returns {index: (D_b as Matrix3x3, posed head Vector)}.
    """
    bones = list(arm.data.bones)
    if hips_index is None:
        hips_index = next((i for i, b in enumerate(bones) if b.name == "hips"), None)
    D = {int(k): quat(v).to_matrix() for k, v in (deltas or {}).items()}
    off = Vector(root_offset)
    pb = arm.pose.bones
    for b in pb:
        b.rotation_mode = 'QUATERNION'
        b.matrix_basis = Matrix.Identity(4)
    bpy.context.view_layer.update()
    posed = {}
    index = {b.name: i for i, b in enumerate(bones)}
    for i in topo_order(arm):
        b = bones[i]
        R_rest = b.matrix_local.to_3x3()
        if b.parent is not None:
            p = index[b.parent.name]
            Dp, hp = posed[p]
            h = hp + Dp @ (b.head_local - b.parent.head_local)
            Db = D.get(i, Dp)
        else:
            h = b.head_local.copy()
            Db = D.get(i, Matrix.Identity(3))
        if i == hips_index:
            h = h + off
        M = (Db @ R_rest).to_4x4()
        M.translation = h
        pb[b.name].matrix = M
        bpy.context.view_layer.update()
        posed[i] = (Db, h)
    return posed


def rest_pose(arm):
    for b in arm.pose.bones:
        b.rotation_mode = 'QUATERNION'
        b.matrix_basis = Matrix.Identity(4)
    bpy.context.view_layer.update()


def _seg_dist1(p, a, b):
    ab = b - a
    t = float(np.clip(np.dot(p - a, ab) / max(float(np.dot(ab, ab)), 1e-12), 0.0, 1.0))
    return float(np.linalg.norm(p - (a + t * ab)))


def follow_check(arm, meshes, H):
    """Did the posed mesh follow the skeleton? Returns {moved_fraction, worst_drift, grow}."""
    dg = bpy.context.evaluated_depsgraph_get()
    bones = arm.data.bones
    pbs = arm.pose.bones
    moved, total, worst = 0, 0, 0.0
    rest_all, pose_all = [], []
    for o in meshes:
        ev = o.evaluated_get(dg)
        me = ev.to_mesh()
        r = np.array([v.co[:] for v in o.data.vertices])
        p = np.array([v.co[:] for v in me.vertices])
        ev.to_mesh_clear()
        if len(r) != len(p):
            continue
        rest_all.append(r)
        pose_all.append(p)
        moved += int((np.linalg.norm(p - r, axis=1) > 0.02 * H).sum())
        total += len(r)
        gi = {g.index: g.name for g in o.vertex_groups}
        for v in o.data.vertices:
            for g in v.groups:
                n = gi.get(g.group)
                if g.weight > 0.99 and n in bones:  # rigid to one bone: its distance to that bone must hold
                    b, pb_ = bones[n], pbs[n]
                    d0 = _seg_dist1(r[v.index], np.array(b.head_local), np.array(b.tail_local))
                    d1 = _seg_dist1(p[v.index], np.array(pb_.head), np.array(pb_.tail))
                    worst = max(worst, abs(d1 - d0) / H)
    R, P = np.vstack(rest_all), np.vstack(pose_all)
    grow = float(np.ptp(P, axis=0).max() / max(float(np.ptp(R, axis=0).max()), 1e-12))
    return {"moved_fraction": moved / max(total, 1), "worst_drift": worst, "grow": grow}


def gate(check, posed_any=True):
    """Raise MpmError E_FOLLOW_CHECK unless the section 14 thresholds hold."""
    from .protocol import MpmError
    if posed_any and check["moved_fraction"] < MOVED_MIN:
        raise MpmError("E_FOLLOW_CHECK", "the mesh did not follow the skeleton", check)
    if check["worst_drift"] >= DRIFT_MAX or check["grow"] >= GROW_MAX:
        raise MpmError("E_FOLLOW_CHECK", "the posed mesh is distorted", check)
