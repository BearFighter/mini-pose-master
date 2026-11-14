# SPDX-License-Identifier: GPL-3.0-or-later
"""Skinning (WP4c): visibility-tested distance weights for body bones (port of the prototype skin(),
which worked where Blender's bone heat failed on game meshes), hand split via fingers.py, then the
contracts section 7 parity rules."""

import bmesh
import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree
from mathutils.kdtree import KDTree

from .. import skeleton as SK
from ..protocol import MpmError
from . import fingers

CANDIDATES = 6
SMOOTH_ITERS = 6
KEEP_BODY = 3
MAX_INFLUENCES = 4
PRUNE = 1e-3


def _np_co(me):
    co = np.empty(len(me.vertices) * 3, np.float32)
    me.vertices.foreach_get("co", co)
    return co.reshape(-1, 3).astype(np.float64)


def _world_co(o):
    M = np.array(o.matrix_world)
    return _np_co(o.data) @ M[:3, :3].T + M[:3, 3]


def seg_dist(P, A, B):
    """Distances (N, K) from points P (N,3) to segments A->B (K,3) and the closest points (N,K,3)."""
    AB = B - A
    t = np.einsum("nkd,kd->nk", P[:, None, :] - A[None], AB) / np.maximum((AB * AB).sum(1), 1e-12)
    t = np.clip(t, 0.0, 1.0)
    C = A[None] + t[..., None] * AB[None]
    return np.linalg.norm(P[:, None, :] - C, axis=2), C


def _occluder(meshes, voxel):
    """Sealed voxel proxy of all meshes, as a BVH (so a thigh can't 'see' the other leg)."""
    bm = bmesh.new()
    for o in meshes:
        tmp = o.data.copy()
        tmp.transform(o.matrix_world)
        bm.from_mesh(tmp)
        bpy.data.meshes.remove(tmp)
    me = bpy.data.meshes.new("mpm_occluder")
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new("mpm_occluder", me)
    bpy.context.scene.collection.objects.link(ob)
    mod = ob.modifiers.new("r", 'REMESH')
    mod.mode, mod.voxel_size, mod.adaptivity = 'VOXEL', voxel, 0.0
    dg = bpy.context.evaluated_depsgraph_get()
    ev = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
    bpy.data.objects.remove(ob, do_unlink=True)
    bpy.data.meshes.remove(me)
    pv = _np_co(ev)
    ev.calc_loop_triangles()
    tri = np.empty(len(ev.loop_triangles) * 3, np.int32)
    ev.loop_triangles.foreach_get("vertices", tri)
    tree = BVHTree.FromPolygons([Vector(p) for p in pv], tri.reshape(-1, 3).tolist(), all_triangles=True)
    bpy.data.meshes.remove(ev)
    return tree


def _body_weights(co, edges, names, A, B, side, occluder, H, voxel):
    """(N, K) weights over the body bones `names` (no finger bones)."""
    margin, skip = 0.02 * H, 2.0 * voxel
    D, C = seg_dist(co, A, B)
    wrong = (((side[None, :] > 0) & (co[:, :1] < -margin)) | ((side[None, :] < 0) & (co[:, :1] > margin)))
    D = np.where(wrong, np.inf, D)
    order = np.argsort(D, axis=1)[:, :CANDIDATES]
    W = np.zeros((len(co), len(names)))
    blind = 0
    for i in range(len(co)):
        p = Vector(co[i])
        got = False
        for j in order[i]:
            d = D[i, j]
            if not np.isfinite(d):
                break
            ray = Vector(C[i, j]) - p
            L = ray.length
            if L > skip:
                dirn = ray / L
                if occluder.ray_cast(p + dirn * skip, dirn, L - skip)[0] is not None:
                    continue  # that bone is behind another part of the body
            W[i, j] = 1.0 / max(d, 1e-4) ** 4
            got = True
        if not got:
            W[i, order[i, 0]] = 1.0
            blind += 1
    if W.shape[1] > KEEP_BODY:
        cut = np.sort(W, axis=1)[:, -KEEP_BODY][:, None]
        W = np.where(W >= cut, W, 0.0)
    W /= np.maximum(W.sum(1, keepdims=True), 1e-12)
    for _ in range(SMOOTH_ITERS if len(edges) else 0):
        acc, cnt = W.copy(), np.ones(len(W))
        np.add.at(acc, edges[:, 0], W[edges[:, 1]])
        np.add.at(acc, edges[:, 1], W[edges[:, 0]])
        np.add.at(cnt, edges[:, 0], 1)
        np.add.at(cnt, edges[:, 1], 1)
        W = 0.5 * W + 0.5 * acc / cnt[:, None]
    W /= np.maximum(W.sum(1, keepdims=True), 1e-12)
    return W, blind


def parity(W, co):
    """Contracts section 7.4: top-4, prune < 1e-3, renormalise, no zero-weight vertex."""
    if W.shape[1] > MAX_INFLUENCES:
        cut = np.sort(W, axis=1)[:, -MAX_INFLUENCES][:, None]
        W = np.where(W >= cut, W, 0.0)
    W = np.where(W < PRUNE, 0.0, W)
    s = W.sum(1)
    empty = s < 1e-9
    if empty.any():
        full = np.nonzero(~empty)[0]
        if len(full) == 0:
            raise MpmError("E_WEIGHTS_EMPTY", "no vertex received any weight")
        kd = KDTree(len(full))
        for n, i in enumerate(full):
            kd.insert(co[i], n)
        kd.balance()
        for i in np.nonzero(empty)[0]:
            W[i] = W[full[kd.find(co[i])[1]]]
        s = W.sum(1)
    W = W / s[:, None]
    # ties at the top-4 cut can leave 5+; enforce strictly
    over = (W > 0).sum(1) > MAX_INFLUENCES
    for i in np.nonzero(over)[0]:
        keep = np.argsort(W[i])[-MAX_INFLUENCES:]
        row = np.zeros_like(W[i])
        row[keep] = W[i, keep]
        W[i] = row / row.sum()
    return W


def _write_groups(o, W, names, deform):
    for g in list(o.vertex_groups):
        o.vertex_groups.remove(g)
    for j, n in enumerate(names):
        if not deform[j]:
            continue
        idx = np.nonzero(W[:, j] > 0)[0]
        if not len(idx):
            continue
        g = o.vertex_groups.new(name=n)
        for i in idx:
            g.add([int(i)], float(W[i, j]), 'REPLACE')


def setup_modifier(o, arm):
    """Exactly one Armature modifier, first, with parity settings (contracts section 7.1)."""
    for m in list(o.modifiers):
        if m.type == 'ARMATURE':
            o.modifiers.remove(m)
    m = o.modifiers.new("Armature", 'ARMATURE')
    m.object = arm
    m.use_deform_preserve_volume = False
    m.use_bone_envelopes = False
    m.use_vertex_groups = True
    idx = o.modifiers.find(m.name)
    if idx > 0:
        o.modifiers.move(idx, 0)
    return m


def add_orig_index(o):
    me = o.data
    a = me.attributes.get("_ORIG_INDEX")
    if a is not None:
        me.attributes.remove(a)
    a = me.attributes.new("_ORIG_INDEX", 'INT', 'POINT')
    a.data.foreach_set("value", np.arange(len(me.vertices), dtype=np.int32))


def skin(meshes, arm, joints, H):
    """Weight every mesh to the canonical armature. Returns a report dict."""
    names = [b["name"] for b in SK.BONES]
    deform = np.array([bool(b["deform"]) for b in SK.BONES])
    body = [j for j, n in enumerate(names) if deform[j] and not SK.is_finger_bone(n)]
    bones = arm.data.bones
    A = np.array([list(bones[names[j]].head_local) for j in body])
    B = np.array([list(bones[names[j]].tail_local) for j in body])
    side = np.array([1 if SK.side_of(names[j]) == "L" else -1 if SK.side_of(names[j]) == "R" else 0 for j in body])
    voxel = H / 120.0
    occluder = _occluder(meshes, voxel)
    jl = {k: [float(x) for x in v] for k, v in joints.items()}
    info = fingers.hand_info_from_markers(meshes, jl, H)
    report = {"blind": 0, "hand_vertices": 0, "meshes": []}
    for o in meshes:
        co = _world_co(o)
        edges = np.array([e.vertices[:] for e in o.data.edges], dtype=np.int64).reshape(-1, 2)
        Wb, blind = _body_weights(co, edges, [names[j] for j in body], A, B, side, occluder, H, voxel)
        W = np.zeros((len(co), len(names)))
        W[:, body] = Wb
        for s in ("L", "R"):
            h = names.index("hand." + s)
            fr = fingers.hand_weight_fractions(o, jl, s, info)
            for vi, fracs in fr.items():
                wh = W[vi, h]
                if wh <= 0:
                    continue
                W[vi, h] = 0.0
                for bname, f in fracs.items():
                    W[vi, names.index(bname)] += wh * f
            report["hand_vertices"] += len(fr)
        W = parity(W, co)
        _write_groups(o, W, names, deform)
        setup_modifier(o, arm)
        add_orig_index(o)
        report["blind"] += blind
        report["meshes"].append({"name": o.name, "vertices": len(co)})
    return report
