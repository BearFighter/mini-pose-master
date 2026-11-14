# SPDX-License-Identifier: GPL-3.0-or-later
"""Finger marker suggestion, hand info from markers and hand weight fractions (docs/briefs/WP4b-fingers.md,
Revision 2: slicing across the hand axis with 2D clustering)."""
import math

import numpy as np

from .sampling import clusters2d

FINGERS = ("thumb", "index", "middle", "ring", "pinky")
LONG_FINGERS = ("index", "middle", "ring", "pinky")
SIDES = ("L", "R")
BONE_SUFFIX = ("01", "02", "03")


# --------------------------------------------------------------------------
# small helpers
# --------------------------------------------------------------------------

def _pt(v):
    """Joint value (list / array / {"p": [...]}) -> float64 array of 3."""
    if isinstance(v, dict):
        v = v["p"]
    return np.asarray(v, np.float64).reshape(3)


def _norm(v, fallback=None):
    n = float(np.linalg.norm(v))
    if n < 1e-12:
        return np.array(fallback if fallback is not None else (0.0, 0.0, 1.0), np.float64)
    return np.asarray(v, np.float64) / n


def _lerp(a, b, t):
    return a + t * (b - a)


def _marker(p, conf):
    return {"p": [float(x) for x in p], "confidence": float(conf), "source": "auto"}


def _hand_frame(joints, side, wrist):
    """Hand frame per contracts section 4 from given joints (arrays)."""
    ha = _norm(joints["middle_0"] - wrist)
    lat = _norm(joints["index_0"] - joints["pinky_0"])
    n = np.cross(ha, lat) if side == "L" else np.cross(lat, ha)
    return {"hand_axis": [float(x) for x in ha], "lateral": [float(x) for x in lat],
            "palm_normal": [float(x) for x in _norm(n)],
            "hand_width": float(np.linalg.norm(joints["index_0"] - joints["pinky_0"]))}


def _template(wrist, a, hl, side="L"):
    """Template joints (section 'Template fallback' of the brief). Returns dict of joint arrays."""
    l = np.array([0.0, -1.0, 0.0]) - a * float(np.dot([0.0, -1.0, 0.0], a))
    l = _norm(l, (0.0, -1.0, 0.0))
    n = _norm(np.cross(a, l) if side == "L" else np.cross(l, a))
    j = {}
    j["middle_0"] = wrist + 0.500 * hl * a
    j["index_0"] = wrist + 0.472 * hl * a + 0.139 * hl * l
    j["ring_0"] = wrist + 0.472 * hl * a - 0.111 * hl * l
    j["pinky_0"] = wrist + 0.417 * hl * a - 0.222 * hl * l
    j["index_tip"] = j["index_0"] + 0.444 * hl * a
    j["middle_tip"] = j["middle_0"] + 0.500 * hl * a
    j["ring_tip"] = j["ring_0"] + 0.472 * hl * a
    j["pinky_tip"] = j["pinky_0"] + 0.378 * hl * a
    j["thumb_0"] = wrist + 0.111 * hl * a + 0.167 * hl * l + 0.083 * hl * n
    j["thumb_tip"] = j["thumb_0"] + 0.389 * hl * _norm(0.55 * a + 0.75 * l + 0.35 * n)
    return j



# --------------------------------------------------------------------------
# slicing analysis (Revision 2)
# --------------------------------------------------------------------------

N_SAMPLES = 80000
MIN_CLUSTER_POINTS = 15
MIN_TRACK_LENGTH = 0.02  # times H
MAX_COAST = 6  # slices a track may stay inside a merged cluster


class _Fail(Exception):
    pass


def _hand_samples(objs, wrist, H, n, seed=0):
    """`n` area-weighted random points on the world-space surface of triangles near the hand.

    Only triangles with a vertex within 0.17 H of the wrist are sampled, so the whole sample budget lands
    on the hand (sampling the full body would leave only ~2 % of `n` in the hand)."""
    rng = np.random.default_rng(seed)
    tris = []
    for o in objs:
        if o.type != 'MESH':
            continue
        me = o.data
        me.calc_loop_triangles()
        if len(me.loop_triangles) == 0:
            continue
        vi = np.empty(len(me.loop_triangles) * 3, np.int32)
        me.loop_triangles.foreach_get("vertices", vi)
        co = np.empty(len(me.vertices) * 3, np.float32)
        me.vertices.foreach_get("co", co)
        co = co.reshape(-1, 3).astype(np.float64)
        M = np.array(o.matrix_world)
        co = co @ M[:3, :3].T + M[:3, 3]
        t = co[vi].reshape(-1, 3, 3)
        near = (np.linalg.norm(t - wrist, axis=2) < 0.17 * H).any(axis=1)
        if near.any():
            tris.append(t[near])
    if not tris:
        raise _Fail("no triangles near the hand")
    t = np.concatenate(tris)
    ar = 0.5 * np.linalg.norm(np.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0]), axis=1)
    if ar.sum() <= 0:
        raise _Fail("zero area near the hand")
    k = rng.choice(len(t), n, p=ar / ar.sum())
    r1, r2 = rng.random(n), rng.random(n)
    q = np.sqrt(r1)
    return (t[k, 0] * (1 - q)[:, None] + t[k, 1] * (q * (1 - r2))[:, None] + t[k, 2] * (q * r2)[:, None])


def _slice_clusters(P, S, U, V, s0, H):
    """Clusters of the slab around s0: list of dicts (idx, cu, cv, count, umin, umax, hw, c3)."""
    half = 0.0015 * H
    lo = np.searchsorted(S, s0 - half, side="left")
    hi = np.searchsorted(S, s0 + half, side="right")
    if hi - lo < MIN_CLUSTER_POINTS:
        return []
    idx_all = np.arange(lo, hi)
    uv = np.stack([U[lo:hi], V[lo:hi]], axis=1)
    out = []
    for loc in clusters2d(uv, 0.0015 * H):
        if len(loc) < MIN_CLUSTER_POINTS:
            continue
        gi = idx_all[loc]
        u, v = U[gi], V[gi]
        out.append({"idx": gi, "cu": float(u.mean()), "cv": float(v.mean()), "count": int(len(gi)),
                    "umin": float(u.min()), "umax": float(u.max()),
                    "hw": 0.5 * float(max(u.max() - u.min(), v.max() - v.min())), "c3": P[gi].mean(0)})
    return out


def _extend_tracks(tracks, clusters, dmax, palm=None):
    """Nearest-centroid tracking of live tracks over the next slice. Returns the unclaimed clusters.

    Each live track looks at the nearest cluster within dmax. A track alone on its cluster follows it. When
    several tracks claim the same cluster (touching fingers) they keep their last centroid for up to
    MAX_COAST slices instead of jumping to the merged centroid. A track with no cluster in reach ends.
    If `palm` is given and a track's nearest cluster is the palm cluster, that track ends (merged)."""
    claims = {}
    for ti, t in enumerate(tracks):
        if not t["alive"]:
            continue
        best = None
        for ci, c in enumerate(clusters):
            d = math.hypot(c["cu"] - t["last"]["cu"], c["cv"] - t["last"]["cv"])
            if d < dmax and (best is None or d < best[0]):
                best = (d, ci)
        if best is None:
            t["alive"] = False
            continue
        claims.setdefault(best[1], []).append(ti)
    for ci, tis in claims.items():
        c = clusters[ci]
        for ti in tis:
            t = tracks[ti]
            if palm is not None and c is palm:
                t["alive"] = False
            elif len(tis) == 1:
                t["items"].append(c)
                t["last"] = c
                t["coast"] = 0
            else:
                t["coast"] = t.get("coast", 0) + 1
                if t["coast"] > MAX_COAST:
                    t["alive"] = False
    return [c for ci, c in enumerate(clusters) if ci not in claims and c is not palm]


def _new_track(c, i):
    return {"items": [c], "last": c, "alive": True, "start": i}


def _track_points(P, tr):
    return P[np.concatenate([c["idx"] for c in tr["items"]])]


def _analyse_hand(objs, wrist, elbow, side, H):
    """Returns (joints dict of arrays without side suffix, confidence dict, warnings list). Raises _Fail."""
    a = _norm(wrist - elbow)
    P = _hand_samples(objs, wrist, H, N_SAMPLES)
    d = P - wrist
    keep = ((d @ a) > -0.01 * H) & (np.linalg.norm(d, axis=1) < 0.16 * H)
    P = P[keep]
    if len(P) < 200:
        raise _Fail("too few hand samples")
    sa = (P - wrist) @ a
    top = P[sa >= np.quantile(sa, 0.98)]
    a_h = _norm(top.mean(0) - wrist)
    l0 = np.array([0.0, -1.0, 0.0])
    l0 = _norm(l0 - a_h * float(np.dot(l0, a_h)), (0.0, -1.0, 0.0))
    m = np.cross(a_h, l0)
    d = P - wrist
    S, U, V = d @ a_h, d @ l0, d @ m
    order = np.argsort(S, kind="stable")
    P, S, U, V = P[order], S[order], U[order], V[order]
    smax = float(S.max())
    nsl = int(smax / (0.002 * H)) + 1
    slices = [_slice_clusters(P, S, U, V, i * 0.002 * H, H) for i in range(nsl)]
    if not slices[0]:
        raise _Fail("no geometry at the wrist")
    dmax = 0.008 * H
    tol = 0.0015 * H
    # knuckle slice
    prev = max(slices[0], key=lambda c: c["count"])
    ik = None
    for i in range(1, nsl):
        cl = slices[i]
        if not cl:
            break
        tot = sum(c["count"] for c in cl)
        inside = [c for c in cl if c["umin"] >= prev["umin"] - tol and c["umax"] <= prev["umax"] + tol
                  and c["count"] >= 0.08 * tot]
        if len(inside) >= 3:
            ik = i
            break
        prev = max(cl, key=lambda c: c["count"])
    if ik is None:
        raise _Fail("palm never splits into fingers")
    # thumb candidates: separate clusters before the knuckle slice
    cand = []
    for i in range(0, ik):
        cl = slices[i]
        if not cl:
            continue
        palm = max(cl, key=lambda c: c["count"])
        rest = _extend_tracks(cand, cl, dmax, palm)
        for c in rest:
            if i > 0 or c is not palm:
                cand.append(_new_track(c, i))
    thumb = None
    best = 0
    for t in cand:
        tot = sum(c["count"] for c in t["items"])
        if len(t["items"]) >= 5 and tot > best:
            best, thumb = tot, t
    cl = slices[ik]
    tracks = []
    if thumb is not None and thumb["alive"]:
        tracks.append(thumb)
        rest = _extend_tracks(tracks, cl, dmax)
    else:
        rest = list(cl)
    if thumb is None:
        mv = np.mean([c["cv"] for c in cl])
        tc = max(cl, key=lambda c: abs(c["cv"] - mv))
        thumb = _new_track(tc, ik)
        tracks = [thumb]
        rest = [c for c in cl if c is not tc]
    elif not thumb["alive"] and thumb not in tracks:
        tracks = []
    fing = [_new_track(c, ik) for c in rest]
    tracks = tracks + fing
    for i in range(ik + 1, nsl):
        cl = slices[i]
        _extend_tracks(tracks, cl, dmax)
        if not any(t["alive"] for t in tracks):
            break
    long_f = [t for t in fing if len(t["items"]) * 0.002 * H > MIN_TRACK_LENGTH * H]
    long_f.sort(key=lambda t: -sum(c["count"] for c in t["items"]))
    long_f = long_f[:4]
    thumb_ok = len(thumb["items"]) >= 5
    if len(long_f) + (1 if thumb_ok else 0) < 4:
        raise _Fail("only %d finger tracks" % (len(long_f) + (1 if thumb_ok else 0)))
    warnings = []
    # order the fingers by u, index nearest the thumb
    tu = thumb["items"][0]["cu"] if thumb_ok else None
    long_f.sort(key=lambda t: t["items"][0]["cu"])
    if tu is None:
        long_f.reverse()  # default: index at the largest u (template lateral)
    elif abs(long_f[0]["items"][0]["cu"] - tu) < abs(long_f[-1]["items"][0]["cu"] - tu):
        pass
    else:
        long_f.reverse()
    hl = float(((P - wrist) @ a).max())
    tj = _template(wrist, a, hl, side)
    joints, conf = {}, {}
    names = list(LONG_FINGERS)
    for f, tr in zip(names, long_f):
        first, last = tr["items"][0], tr["items"][-1]
        pts = _track_points(P, tr)
        far = pts[int(np.argmax((pts - wrist) @ a_h))]
        toward = last["c3"] - far
        nt = float(np.linalg.norm(toward))
        tip = far + (toward / nt) * 0.4 * last["hw"] if nt > 1e-9 else far
        knuckle = first["c3"] - a_h * 0.5 * first["hw"]
        joints[f + "_0"], joints[f + "_tip"] = knuckle, tip
        c = 1.0
        if float(np.dot(tip - knuckle, a_h)) < 0.02 * H:
            c *= 0.6
        conf[f + "_0"] = conf[f + "_tip"] = c
    for f in names[len(long_f):]:
        joints[f + "_0"], joints[f + "_tip"] = tj[f + "_0"], tj[f + "_tip"]
        conf[f + "_0"] = conf[f + "_tip"] = 0.4
        warnings.append("hand %s: %s finger missing, template used" % (side, f))
    if thumb_ok:
        pts = _track_points(P, thumb)
        joints["thumb_tip"] = pts[int(np.argmax(np.linalg.norm(pts - wrist, axis=1)))]
        joints["thumb_0"] = _lerp(thumb["items"][0]["c3"], wrist, 0.35)
        conf["thumb_0"] = conf["thumb_tip"] = 1.0
    else:
        joints["thumb_0"], joints["thumb_tip"] = tj["thumb_0"], tj["thumb_tip"]
        conf["thumb_0"] = conf["thumb_tip"] = 0.4
        warnings.append("hand %s: thumb missing, template used" % side)
    return joints, conf, warnings, hl


def _info(wrist, a, H, joints, side, fallback):
    info = {"fallback": bool(fallback), "wrist": [float(x) for x in wrist],
            "forearm_axis": [float(x) for x in a], "H": float(H),
            "joints": {k: [float(x) for x in v] for k, v in joints.items()}}
    info.update(_hand_frame(joints, side, wrist))
    return info


# --------------------------------------------------------------------------
# public API
# --------------------------------------------------------------------------

def suggest_finger_markers(objs, body_markers, H):
    """-> (markers, warnings, hand_info). Never raises."""
    markers = {}
    warnings = []
    hand_info = {}
    H = float(H)
    for side in SIDES:
        try:
            wrist = _pt(body_markers["wrist_" + side])
            elbow = _pt(body_markers["elbow_" + side])
        except Exception as e:  # noqa: BLE001
            warnings.append("hand %s: wrist/elbow marker missing (%s)" % (side, e))
            continue
        a = _norm(wrist - elbow)
        fallback = False
        try:
            joints, conf, w, _hl = _analyse_hand(objs, wrist, elbow, side, H)
            warnings += w
        except Exception as e:  # noqa: BLE001
            fallback = True
            warnings.append("hand %s: fingers not found (%s); using template fingers" % (side, e))
            hl = 0.10 * H
            try:
                P = _hand_samples(objs, wrist, H, N_SAMPLES)
                d = P - wrist
                k = ((d @ a) > -0.01 * H) & (np.linalg.norm(d, axis=1) < 0.16 * H)
                if k.any():
                    hl = float(max((d[k] @ a).max(), 1e-3))
            except Exception:  # noqa: BLE001
                pass
            joints = _template(wrist, a, hl, side)
            conf = {k: 0.2 for k in joints}
        info = _info(wrist, a, H, joints, side, fallback)
        if not fallback:
            pn = np.array(info["palm_normal"])
            kn = np.array([joints[f + "_0"] for f in LONG_FINGERS])
            off = (kn - kn.mean(0)) @ pn
            if float(off.max() - off.min()) > 0.25 * info["hand_width"]:
                conf = {k: v * 0.8 for k, v in conf.items()}
                warnings.append("hand %s: knuckles not in a row" % side)
        for k, v in joints.items():
            markers["%s_%s" % (k, side)] = _marker(v, conf.get(k, 0.2))
        hand_info[side] = info
    return markers, warnings, hand_info


def hand_info_from_markers(objs, joints, H):
    """Build hand_info for both sides from given joints (markers or plain points). fallback = False."""
    out = {}
    for side in SIDES:
        try:
            wrist = _pt(joints["wrist_" + side])
            elbow = _pt(joints["elbow_" + side])
            fj = {}
            for f in FINGERS:
                fj[f + "_0"] = _pt(joints["%s_0_%s" % (f, side)])
                fj[f + "_tip"] = _pt(joints["%s_tip_%s" % (f, side)])
        except Exception:  # noqa: BLE001
            continue
        out[side] = _info(wrist, _norm(wrist - elbow), float(H), fj, side, False)
    return out


# --------------------------------------------------------------------------
# weights
# --------------------------------------------------------------------------

def _world_verts(obj):
    me = obj.data
    co = np.empty(len(me.vertices) * 3, np.float32)
    me.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3).astype(np.float64)
    M = np.array(obj.matrix_world, np.float64)
    return co @ M[:3, :3].T + M[:3, 3]


def _finger_joints(joints, side, f):
    """Joint polyline knuckle -> _1 -> _2 -> tip from the joints dict (derived joints computed if missing)."""
    j0 = _pt(joints["%s_0_%s" % (f, side)])
    jt = _pt(joints["%s_tip_%s" % (f, side)])
    t1, t2 = (0.40, 0.73) if f == "thumb" else (0.45, 0.75)
    n1, n2 = "%s_1_%s" % (f, side), "%s_2_%s" % (f, side)
    j1 = _pt(joints[n1]) if n1 in joints else _lerp(j0, jt, t1)
    j2 = _pt(joints[n2]) if n2 in joints else _lerp(j0, jt, t2)
    return [j0, j1, j2, jt]


def _bone_fractions(s, seg_len, w_knuckle_len):
    """Fractions over [hand, 01, 02, 03] for polyline parameter s (arc length from the knuckle)."""
    l1, l2, l3 = seg_len
    b1, b2 = l1, l1 + l2
    out = np.zeros(4)
    w0 = 0.15 * l1
    w1 = 0.15 * min(l1, l2)
    w2 = 0.15 * min(l2, l3)
    # base bone index
    if s < b1:
        base = 1
    elif s < b2:
        base = 2
    else:
        base = 3
    out[base] = 1.0
    if s < w0:  # knuckle blend, hand <-> 01
        if s > -w0:
            t = (s + w0) / (2 * w0)
            out[:] = 0
            out[0] = 1 - t
            out[1] = t
        else:
            out[:] = 0
            out[0] = 1.0
        return out
    if abs(s - b1) < w1:
        t = (s - (b1 - w1)) / (2 * w1)
        out[:] = 0
        out[1] = 1 - t
        out[2] = t
        return out
    if abs(s - b2) < w2:
        t = (s - (b2 - w2)) / (2 * w2)
        out[:] = 0
        out[2] = 1 - t
        out[3] = t
        return out
    return out


def _seg_dist(P, a, b):
    ab = b - a
    L2 = float(np.dot(ab, ab))
    if L2 < 1e-18:
        return np.linalg.norm(P - a, axis=1)
    t = np.clip(((P - a) @ ab) / L2, 0.0, 1.0)
    return np.linalg.norm(P - (a + t[:, None] * ab), axis=1)


def hand_weight_fractions(mesh_obj, joints, side, hand_info):
    """{mesh_vertex_index: {bone_name: fraction}} for mesh vertices of the hand (nearest-chain method)."""
    info = hand_info[side] if side in hand_info else hand_info
    wrist = np.asarray(info["wrist"], np.float64)
    a = np.asarray(info["forearm_axis"], np.float64)
    H = float(info["H"])
    S = side
    hand_bone = "hand." + S
    bones = {f: ["%s.%s.%s" % (f, sfx, S) for sfx in BONE_SUFFIX] for f in FINGERS}
    wv = _world_verts(mesh_obj)
    region = np.nonzero(((wv - wrist) @ a > 0.0) & (np.linalg.norm(wv - wrist, axis=1) < 0.16 * H))[0]
    result = {}
    if len(region) == 0:
        return result
    X = wv[region]
    polys = {f: _finger_joints(joints, S, f) for f in FINGERS}
    dfing = np.stack([np.minimum.reduce([_seg_dist(X, polys[f][i], polys[f][i + 1]) for i in range(3)])
                      for f in FINGERS])  # (5, n)
    palm_end = _pt(joints["middle_0_" + S])
    dpalm = _seg_dist(X, wrist, palm_end)
    best = np.argmin(dfing, axis=0)
    dbest = dfing[best, np.arange(len(X))]
    cutoff = 0.03 * H
    for n, vi in enumerate(region.tolist()):
        if min(dbest[n], dpalm[n]) > cutoff:
            continue
        if dpalm[n] < 0.9 * dbest[n]:
            result[vi] = {hand_bone: 1.0}
            continue
        f = FINGERS[int(best[n])]
        pj = polys[f]
        p = X[n]
        seg_len = [float(np.linalg.norm(pj[i + 1] - pj[i])) for i in range(3)]
        bst = None
        acc = 0.0
        for i in range(3):
            dd = pj[i + 1] - pj[i]
            L = seg_len[i]
            if L < 1e-12:
                continue
            u = float(np.dot(p - pj[i], dd)) / (L * L)
            uc = min(max(u, 0.0), 1.0)
            q = pj[i] + uc * dd
            dist = float(np.linalg.norm(p - q))
            sp = acc + (u if (i == 0 and u < 0.0) or (i == 2 and u > 1.0) else uc) * L
            if bst is None or dist < bst[0]:
                bst = (dist, sp)
            acc += L
        if bst is None:
            result[vi] = {hand_bone: 1.0}
            continue
        fr = _bone_fractions(bst[1], seg_len, 0.0)
        names = [hand_bone] + bones[f]
        result[vi] = {nm: float(x) for nm, x in zip(names, fr) if x > 0.0}
    return result
