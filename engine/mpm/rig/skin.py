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


def _body_weights(co, edges, names, A, B, side, occluder, H, voxel, blocked=None):
    """(N, K) weights over the body bones `names` (no finger bones). `blocked` (N, K) rules bones out."""
    margin, skip = 0.02 * H, 2.0 * voxel
    D, C = seg_dist(co, A, B)
    wrong = (((side[None, :] > 0) & (co[:, :1] < -margin)) | ((side[None, :] < 0) & (co[:, :1] > margin)))
    if blocked is not None:
        wrong = wrong | blocked
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


ARM_DETOUR = 1.8      # surface path to the fingertips may be this many times the straight distance...
ARM_SLACK = 0.10      # ...plus this fraction of the height, before a vertex is "not on that arm"
WRAP_GAP_DEG = 200.0  # a piece wraps a bone if its vertices leave no bigger angular gap around it
WRAP_REACH = 0.035    # of the height: vertices this near the bone take part in the wrap test


def _surface_distance(n, edges, lengths, seeds):
    """Shortest path along the mesh edges from any seed vertex (Dijkstra). inf where unreachable."""
    import heapq
    order = np.argsort(np.concatenate([edges[:, 0], edges[:, 1]]), kind="stable")
    src = np.concatenate([edges[:, 0], edges[:, 1]])[order]
    dst = np.concatenate([edges[:, 1], edges[:, 0]])[order]
    wgt = np.concatenate([lengths, lengths])[order]
    start = np.searchsorted(src, np.arange(n + 1))
    dist = np.full(n, np.inf)
    heap = []
    for v in seeds:
        dist[v] = 0.0
        heap.append((0.0, int(v)))
    heapq.heapify(heap)
    dst_l, wgt_l, start_l = dst.tolist(), wgt.tolist(), start.tolist()
    dl = dist.tolist()
    while heap:
        d, v = heapq.heappop(heap)
        if d > dl[v]:
            continue
        for k in range(start_l[v], start_l[v + 1]):
            u = dst_l[k]
            nd = d + wgt_l[k]
            if nd < dl[u]:
                dl[u] = nd
                heapq.heappush(heap, (nd, u))
    return np.array(dl)


def _wraps(co, a, b, reach):
    """Do these vertices surround the segment a-b (a finger's own skin does; a part lying beside it
    does not)? True when the vertices near the segment leave no angular gap over WRAP_GAP_DEG around it."""
    ab = b - a
    L = float(np.linalg.norm(ab))
    if L < 1e-9 or len(co) < 3:
        return False
    d = ab / L
    rel = co - a
    t = rel @ d
    perp = rel - np.outer(t, d)
    r = np.linalg.norm(perp, axis=1)
    k = (t > 0.1 * L) & (t < 0.9 * L) & (r < reach) & (r > 1e-9)
    if np.count_nonzero(k) < 3:
        return False
    u = np.cross(d, (0.0, 0.0, 1.0))
    if np.linalg.norm(u) < 1e-3:
        u = np.cross(d, (0.0, 1.0, 0.0))
    u = u / np.linalg.norm(u)
    v = np.cross(d, u)
    ang = np.sort(np.arctan2(perp[k] @ v, perp[k] @ u))
    gaps = np.diff(np.concatenate([ang, ang[:1] + 2 * np.pi]))
    return float(np.degrees(gaps.max())) <= WRAP_GAP_DEG


def arm_blocks(meshes, cos, edge_lists, joints, names, H):
    """Per mesh, an (N, K) mask ruling the hand and forearm bones out for vertices that are merely near a
    hanging hand (thigh armour, a hip pouch, a skirt) rather than attached to that arm.

    A connected piece that contains the fingertips is the arm's own skin: a vertex on it belongs to the arm
    only if the path along the surface to the fingertips is not a long detour compared with the straight
    line (a thigh vertex beside the hand is centimetres away in space but a whole body away on the
    surface). A piece without fingertips (a separate part) may follow the hand only if it wraps the palm or
    a finger, as a glove or ring does."""
    out = [np.zeros((len(co), len(names)), bool) for co in cos]
    for s in ("L", "R"):
        if "hand." + s not in names:
            continue
        hand_j = names.index("hand." + s)
        fore_j = names.index("forearm." + s) if "forearm." + s in names else None
        try:
            tips = np.array([joints["%s_tip_%s" % (f, s)] for f in fingers.FINGERS], float)
            wrist = np.array(joints["wrist_" + s], float)
            chains = [[np.array(joints["%s_%s_%s" % (f, k, s)], float) for k in ("0", "1", "2", "tip")]
                      for f in fingers.FINGERS]
            palm_end = np.array(joints["middle_0_" + s], float)
        except KeyError:
            continue
        # each fingertip's nearest vertex over all meshes seeds the arm's surface
        seeds = [[] for _ in cos]
        for tip in tips:
            best = None
            for m, co in enumerate(cos):
                if not len(co):
                    continue
                d = np.linalg.norm(co - tip, axis=1)
                i = int(np.argmin(d))
                if best is None or d[i] < best[0]:
                    best = (float(d[i]), m, i)
            if best is not None and best[0] < 0.02 * H:
                seeds[best[1]].append(best[2])
        segs = [(wrist, palm_end)] + [(c[i], c[i + 1]) for c in chains for i in range(3)]
        for m, co in enumerate(cos):
            if not len(co):
                continue
            edges = edge_lists[m]
            lab = _islands(len(co), edges)
            seeded = set(lab[seeds[m]].tolist()) if seeds[m] else set()
            if seeds[m] and len(edges):
                lengths = np.linalg.norm(co[edges[:, 0]] - co[edges[:, 1]], axis=1)
                G = _surface_distance(len(co), edges, lengths, seeds[m])
                E = np.min(np.linalg.norm(co[:, None, :] - tips[None], axis=2), axis=1)
                far = np.isin(lab, list(seeded)) & (G > ARM_DETOUR * E + ARM_SLACK * H)
                out[m][far, hand_j] = True
                if fore_j is not None:
                    out[m][far, fore_j] = True
            near = np.linalg.norm(co - wrist, axis=1) < 0.25 * H
            for isl in np.unique(lab[near]):
                if isl in seeded:
                    continue
                idx = np.nonzero(lab == isl)[0]
                if not any(_wraps(co[idx], a, b, WRAP_REACH * H) for a, b in segs):
                    out[m][idx, hand_j] = True
    return out


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


RIGID_MAX_SIZE = 0.30    # of the height: bigger connected pieces are body or cloth and keep their blend
RIGID_OBJECT_SIZE = 0.45  # a whole accessory object (a helmet with its tendrils) may be this big
RIGID_MIN_SHARE = 0.50    # a piece goes to the bone that carries the majority of its weight
RIGID_OBJECT_SHARE = 0.60
GLOVE_FINGER_SHARE = 0.25  # a piece with this much finger weight is a hand or glove: it must keep bending


def _islands(n, edges):
    """Connected-component label per vertex (union-find over the edges)."""
    lab = np.arange(n)
    if not len(edges):
        return lab
    a, b = edges[:, 0], edges[:, 1]
    while True:
        la, lb = lab[a], lab[b]
        if np.array_equal(la, lb):
            return lab
        mn = np.minimum(la, lb)
        np.minimum.at(lab, la, mn)
        np.minimum.at(lab, lb, mn)
        while True:
            nl = lab[lab]
            if np.array_equal(nl, lab):
                break
            lab = nl


def _main_bone(W, idx, names, share):
    """The bone a piece should follow rigidly, or None. Hand and finger weights of one side count together
    (a plate beside the hand is "on the hand"); a piece with real finger weight is a glove and stays soft."""
    w = W[idx].sum(0)
    tot = float(w.sum())
    if tot <= 0:
        return None
    grouped = w.copy()
    for s in ("L", "R"):
        if "hand." + s not in names:
            continue
        h = names.index("hand." + s)
        fing = [j for j, n in enumerate(names) if SK.is_finger_bone(n) and n.endswith("." + s)]
        fsum = float(w[fing].sum())
        if fsum > GLOVE_FINGER_SHARE * tot:
            return None
        grouped[h] += fsum
        grouped[fing] = 0.0
    order = np.argsort(grouped)
    j, second = int(order[-1]), float(grouped[order[-2]]) if len(order) > 1 else 0.0
    # a clear lead is enough: a forearm fin that also brushes the hand and the upper arm is a forearm fin
    lead = grouped[j] >= 0.8 * share * tot and grouped[j] >= 1.4 * second
    return j if (grouped[j] >= share * tot or lead) else None


def rigid_parts(W, co, edges, names, H, accessory=False):
    """Armour does not bend. Small separate pieces of a mesh (plates, clips, buckles, a holster) follow one
    bone rigidly: a connected piece under RIGID_MAX_SIZE of the height goes entirely to the bone that
    carries the majority of its weight. With `accessory` (an object that is not the body: a helmet, a
    belt), the whole object is tried first, up to RIGID_OBJECT_SIZE and with a clearer majority, so a
    helmet's hanging parts turn with the head. The body, gloves and long cloth keep their blended weights.
    Edits W in place; returns the number of pieces made rigid."""
    if not len(co):
        return 0

    def size(idx):
        c = co[idx]
        return float(np.linalg.norm(c.max(0) - c.min(0)))

    def make(idx, j):
        if np.count_nonzero(W[idx, j] < 0.999):
            W[idx] = 0.0
            W[idx, j] = 1.0
            return 1
        return 0

    everything = np.arange(len(co))
    if accessory and size(everything) <= RIGID_OBJECT_SIZE * H:
        j = _main_bone(W, everything, names, RIGID_OBJECT_SHARE)
        if j is not None:
            return make(everything, j)
    lab = _islands(len(co), edges)
    ids, inv, counts = np.unique(lab, return_inverse=True, return_counts=True)
    if len(ids) <= 1 and not accessory:
        return 0   # one connected mesh: the body
    made = 0
    for k in range(len(ids)):
        if counts[k] < 3:
            continue
        idx = np.nonzero(inv == k)[0]
        if size(idx) > RIGID_MAX_SIZE * H:
            continue
        j = _main_bone(W, idx, names, RIGID_MIN_SHARE)
        if j is not None:
            made += make(idx, j)
    return made


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
    report = {"blind": 0, "hand_vertices": 0, "rigid_parts": 0, "meshes": []}
    main = max(meshes, key=lambda o: len(o.data.vertices)) if meshes else None   # the body
    cos = [_world_co(o) for o in meshes]
    edge_lists = [np.array([e.vertices[:] for e in o.data.edges], dtype=np.int64).reshape(-1, 2) for o in meshes]
    body_names = [names[j] for j in body]
    blocks = arm_blocks(meshes, cos, edge_lists, jl, body_names, H)
    report["arm_blocked"] = int(sum(int(b.any(1).sum()) for b in blocks))
    for m, o in enumerate(meshes):
        co, edges = cos[m], edge_lists[m]
        Wb, blind = _body_weights(co, edges, body_names, A, B, side, occluder, H, voxel, blocks[m])
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
        report["rigid_parts"] += rigid_parts(W, co, edges, names, H, accessory=o is not main)
        W = parity(W, co)
        _write_groups(o, W, names, deform)
        setup_modifier(o, arm)
        add_orig_index(o)
        report["blind"] += blind
        report["meshes"].append({"name": o.name, "vertices": len(co)})
    return report
