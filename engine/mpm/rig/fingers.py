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
MIN_TRACK_LENGTH = 0.014  # times H
# A finger is at least this many times as long as it is thick (knuckle to tip). Where fingers touch each
# other the track cannot be followed to the knuckle; the knuckle is then set back along the finger.
LENGTH_PER_WIDTH = {"index": 4.0, "middle": 4.2, "ring": 4.0, "pinky": 3.2}
MAX_COAST = 6  # slices a track may stay inside a merged cluster


class _Fail(Exception):
    pass


CURVED = 0.3   # a finger is curved if its middle strays this many finger-widths from the straight line


def _knuckle_points(base, tip, tr, fracs):
    """The two middle joints of a finger along its own centreline (base -> track -> tip), or None when the
    finger is straight enough for the default (points on the straight line). Curved fingers and claws need
    them: a straight bone chain would cut the corner."""
    pts = [np.asarray(base, float)] + [np.asarray(c["c3"], float) for c in tr["items"]] + [np.asarray(tip, float)]
    run = tip - base
    L = float(np.linalg.norm(run))
    if L < 1e-9:
        return None
    d = run / L
    # keep only points that advance along the finger (the first track slices can sit behind the knuckle)
    line = [pts[0]]
    for p in pts[1:-1]:
        if float((p - line[-1]) @ d) > 0 and float((p - base) @ d) < L:
            line.append(p)
    line.append(pts[-1])
    seg = [float(np.linalg.norm(line[i + 1] - line[i])) for i in range(len(line) - 1)]
    total = sum(seg)
    if total < 1e-9:
        return None
    out = []
    for f in fracs:
        want, acc = f * total, 0.0
        for i, s in enumerate(seg):
            if acc + s >= want or i == len(seg) - 1:
                out.append(line[i] + (line[i + 1] - line[i]) * ((want - acc) / max(s, 1e-12)))
                break
            acc += s
    dev = max(float(np.linalg.norm((p - base) - d * float((p - base) @ d))) for p in out)
    return out if dev > CURVED * tr["width"] else None


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
                    "umin": float(u.min()), "umax": float(u.max()), "vmin": float(v.min()), "vmax": float(v.max()),
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


def _tip_tracks(slices, dmax, tol):
    """Follow every piece from where it first appears (a tip, at the far end of the hand) back toward the
    wrist. Fingertips are always separate, so this is robust where the palm side is not: fingers that
    separate one after another, or detached armour beside the wrist.

    A track ends when it joins something: two tracks reach the same piece ("merge"), its piece becomes
    much wider than the track has been ("wide"), or it disappears inside a bigger piece ("merge"). Tracks
    still running at the wrist end with "wrist"; ones that just stop, with "lost".
    Returns tracks with items ordered base -> tip, plus tip / base slice indices, length and width."""
    tracks = []

    def width(c):
        return 2.0 * c["hw"]

    for i in range(len(slices) - 1, -1, -1):
        cl = slices[i]
        claims = {}
        for t in tracks:
            if not t["alive"]:
                continue
            best = None
            for ci, c in enumerate(cl):
                d = math.hypot(c["cu"] - t["last"]["cu"], c["cv"] - t["last"]["cv"])
                if d < dmax and (best is None or d < best[0]):
                    best = (d, ci)
            if best is None:
                lu, lv = t["last"]["cu"], t["last"]["cv"]
                inside = any(c["umin"] - tol <= lu <= c["umax"] + tol and c["vmin"] - tol <= lv <= c["vmax"] + tol
                             for c in cl)
                t["alive"], t["end"] = False, ("merge" if inside else "lost")
                continue
            claims.setdefault(best[1], []).append(t)
        for ci, ts in claims.items():
            c = cl[ci]
            if len(ts) >= 2:
                for t in ts:
                    t["alive"], t["end"] = False, "merge"
                continue
            t = ts[0]
            med = float(np.median([width(x) for x in t["items"]]))
            if len(t["items"]) >= 3 and width(c) > 1.6 * med:
                t["alive"], t["end"] = False, "wide"
            else:
                t["items"].append(c)
                t["last"] = c
        for ci, c in enumerate(cl):
            if ci not in claims:
                tracks.append({"items": [c], "last": c, "alive": True, "tip": i, "end": None})
    for t in tracks:
        if t["alive"]:
            t["alive"], t["end"] = False, "wrist"
        t["length"] = len(t["items"])
        t["base"] = t["tip"] - t["length"] + 1
        t["width"] = float(np.median([width(x) for x in t["items"]]))
        t["items"].reverse()
    return _chain(tracks, dmax)


def _chain(tracks, dmax):
    """Stitch a finger back together. On a relaxed hand neighbouring fingers touch part of the way down,
    so a finger's track ends there and a new piece starts a slice or two further in. A piece continues a
    track when it starts within 3 slices of where the track ended, close to it sideways, and is not much
    wider (so the palm is never swallowed)."""
    order = sorted(tracks, key=lambda t: -t["tip"])
    used, out = set(), []
    for a in order:
        if id(a) in used:
            continue
        used.add(id(a))
        cur = a
        while cur["end"] in ("merge", "wide", "lost"):
            first = cur["items"][0]
            best = None
            for b in order:
                if id(b) in used:
                    continue
                gap = cur["base"] - b["tip"]
                if not 1 <= gap <= 3:
                    continue
                last = b["items"][-1]
                d = math.hypot(last["cu"] - first["cu"], last["cv"] - first["cv"])
                if d < 1.5 * dmax and b["width"] <= 1.6 * a["width"] and (best is None or d < best[0]):
                    best = (d, b)
            if best is None:
                break
            b = best[1]
            used.add(id(b))
            items = b["items"] + cur["items"]
            cur = {"items": items, "last": items[0], "alive": False, "tip": cur["tip"], "base": b["base"],
                   "end": b["end"], "length": cur["tip"] - b["base"] + 1,
                   "width": float(np.median([2.0 * c["hw"] for c in items]))}
        out.append(cur)
    return out


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
    step = 0.002 * H
    tracks = _tip_tracks(slices, dmax, tol)
    # Long fingers: tracks that run from a tip back into something wider (the palm or a neighbour), long
    # enough, with their bases on the knuckle line (within a fifth of the hand length of the farthest base).
    joined = [t for t in tracks if t["end"] in ("merge", "wide") and t["length"] * step > MIN_TRACK_LENGTH * H]
    if not joined:
        raise _Fail("no finger runs back into the palm")
    top = max(t["base"] for t in joined)
    band = [t for t in joined if t["base"] * step >= top * step - 0.2 * smax]
    band.sort(key=lambda t: -t["tip"])
    long_f = band[:4]
    # Thumb: another track that ends at the palm or the wrist, based below the knuckle line, and not as wide
    # as the palm. Detached armour beside the wrist looks the same in a slice, so prefer the front side
    # (+u: with the figure facing -Y the thumb is in front of the fingers in T- and A-poses).
    fw = float(np.median([t["width"] for t in long_f]))
    fu = float(np.mean([t["items"][0]["cu"] for t in long_f]))
    low = min(t["base"] for t in long_f)
    cands = [t for t in tracks if not any(t is f for f in long_f) and len(t["items"]) >= 5
             and t["end"] in ("merge", "wide", "wrist") and t["base"] <= low and t["width"] <= 1.8 * fw]
    front = [t for t in cands if np.mean([c["cu"] for c in t["items"]]) > fu]
    pool = front or cands
    thumb = max(pool, key=lambda t: sum(c["count"] for c in t["items"])) if pool else None
    thumb_ok = thumb is not None
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
        c = 1.0
        want = LENGTH_PER_WIDTH[f] * tr["width"]
        run = knuckle - tip
        if float(np.linalg.norm(run)) < 0.8 * want:
            knuckle = tip + _norm(run, -a_h) * want
            c = 0.7
            warnings.append("hand %s: %s finger followed only part of the way (fingers touching); knuckle estimated"
                            % (side, f))
        joints[f + "_0"], joints[f + "_tip"] = knuckle, tip
        if float(np.dot(tip - knuckle, a_h)) < 0.02 * H:
            c *= 0.6
        conf[f + "_0"] = conf[f + "_tip"] = c
        mid = _knuckle_points(knuckle, tip, tr, (0.45, 0.75))
        if mid is not None:
            joints[f + "_1"], joints[f + "_2"] = mid
            conf[f + "_1"] = conf[f + "_2"] = min(c, 0.9)
    for f in names[len(long_f):]:
        joints[f + "_0"], joints[f + "_tip"] = tj[f + "_0"], tj[f + "_tip"]
        conf[f + "_0"] = conf[f + "_tip"] = 0.4
        warnings.append("hand %s: %s finger missing, template used" % (side, f))
    if thumb_ok:
        pts = _track_points(P, thumb)
        joints["thumb_tip"] = pts[int(np.argmax(np.linalg.norm(pts - wrist, axis=1)))]
        joints["thumb_0"] = _lerp(thumb["items"][0]["c3"], wrist, 0.35)
        conf["thumb_0"] = conf["thumb_tip"] = 1.0
        mid = _knuckle_points(joints["thumb_0"], joints["thumb_tip"], thumb, (0.40, 0.73))
        if mid is not None:
            joints["thumb_1"], joints["thumb_2"] = mid
            conf["thumb_1"] = conf["thumb_2"] = 0.9
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

MIRRORED_CONFIDENCE = 0.6  # a hand copied from the other side: "check" in the UI


def _rot_between(a, b):
    """Smallest rotation matrix taking unit vector a to unit vector b."""
    v = np.cross(a, b)
    c = float(np.dot(a, b))
    if np.linalg.norm(v) < 1e-9:
        if c > 0:
            return np.eye(3)
        p = np.array([1.0, 0.0, 0.0]) if abs(a[0]) < 0.9 else np.array([0.0, 1.0, 0.0])
        p = _norm(p - a * float(np.dot(p, a)))
        return 2.0 * np.outer(p, p) - np.eye(3)
    vx = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + vx + vx @ vx * (1.0 / (1.0 + c))


def mirror_hand(joints_src, wrist_src, a_src, wrist_dst, a_dst):
    """The other hand's finger joints mirrored across x = 0 (the import centres the model), then turned so
    the mirrored forearm axis lies on this side's forearm axis and moved onto this wrist."""
    S = np.diag([-1.0, 1.0, 1.0])
    R = _rot_between(_norm(S @ a_src), _norm(a_dst))
    return {k: wrist_dst + R @ (S @ (v - wrist_src)) for k, v in joints_src.items()}


def suggest_finger_markers(objs, body_markers, H):
    """-> (markers, warnings, hand_info). Never raises.

    A hand whose fingers can't be found (pressed together, mitten) takes the other hand's layout, mirrored,
    when that one was found; the template is the last resort."""
    markers = {}
    warnings = []
    hand_info = {}
    H = float(H)
    found, failed = {}, {}
    for side in SIDES:
        try:
            wrist = _pt(body_markers["wrist_" + side])
            elbow = _pt(body_markers["elbow_" + side])
        except Exception as e:  # noqa: BLE001
            warnings.append("hand %s: wrist/elbow marker missing (%s)" % (side, e))
            continue
        a = _norm(wrist - elbow)
        try:
            joints, conf, w, _hl = _analyse_hand(objs, wrist, elbow, side, H)
            warnings += w
            found[side] = (joints, conf, wrist, a)
        except Exception as e:  # noqa: BLE001
            failed[side] = (wrist, a, str(e))
    for side in SIDES:
        if side in found:
            joints, conf, wrist, a = found[side]
            fallback = False
        elif side in failed:
            wrist, a, why = failed[side]
            fallback = True
            other = "R" if side == "L" else "L"
            if other in found:
                joints_o, conf_o, wrist_o, a_o = found[other]
                joints = mirror_hand(joints_o, wrist_o, a_o, wrist, a)
                conf = {k: min(MIRRORED_CONFIDENCE, conf_o.get(k, 1.0)) for k in joints}
                warnings.append("hand %s: fingers not found (%s); mirrored from the %s hand - check them"
                                % (side, why, "left" if other == "L" else "right"))
            else:
                warnings.append("hand %s: fingers not found (%s); using template fingers" % (side, why))
                # Lay the template along the hand as measured (wrist to the far end of the hand), not along
                # the forearm: real hands hang at an angle to the forearm.
                hl, ah = 0.10 * H, a
                try:
                    P = _hand_samples(objs, wrist, H, N_SAMPLES)
                    d = P - wrist
                    k = ((d @ a) > -0.01 * H) & (np.linalg.norm(d, axis=1) < 0.16 * H)
                    if k.any():
                        d = d[k]
                        sa = d @ a
                        ah = _norm(d[sa >= np.quantile(sa, 0.98)].mean(0), a)
                        hl = float(max((d @ ah).max(), 1e-3))
                except Exception:  # noqa: BLE001
                    pass
                joints = _template(wrist, ah, hl, side)
                conf = {k: 0.2 for k in joints}
        else:
            continue
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
