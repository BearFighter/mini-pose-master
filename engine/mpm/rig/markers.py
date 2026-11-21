# SPDX-License-Identifier: GPL-3.0-or-later
"""Automatic body markers for A- and T-pose models (docs/briefs/WP4a-body-markers.md)."""
import math

import numpy as np

from .sampling import clusters2d, surface_samples

BODY_MARKERS = ["pelvis", "chest", "neck", "head", "head_top"] + [
    "%s_%s" % (j, s) for j in ("shoulder", "elbow", "wrist", "hip", "knee", "ankle", "toe") for s in "LR"]
N_SAMPLES = 250000
FALLBACK_CONFIDENCE = 0.2

# ground-truth A-pose joint table of docs/briefs/WP2-fixtures.md (L side; R mirrors x), at H = 1.80
_FB_CENTRAL = {"pelvis": (0.0, 0.00, 0.95), "chest": (0.0, 0.01, 1.30), "neck": (0.0, 0.02, 1.52),
               "head": (0.0, 0.02, 1.60), "head_top": (0.0, 0.02, 1.80)}
_FB_SIDED = {"shoulder": (0.19, 0.02, 1.45), "hip": (0.09, 0.00, 0.93), "knee": (0.10, -0.01, 0.50),
             "ankle": (0.11, 0.01, 0.08), "toe": (0.11, -0.17, 0.015)}
_FB_UPPER, _FB_LOWER, _FB_THETA = 0.30, 0.26, 50.0


def select_meshes(objs):
    """Meshes to measure: the decimated proxies (custom property `mpm_proxy_of`) when any exist, else all."""
    meshes = [o for o in objs if o.type == 'MESH']
    proxies = [o for o in meshes if "mpm_proxy_of" in o.keys()]
    return proxies or meshes


def _pieces(sl, gap):
    """Pieces of a slab of 3D points, connected in X-Y, each sorted by x (prototype `_clusters`)."""
    return [sl[i] for i in clusters2d(sl[:, :2], gap)]


def _round(p):
    return [round(float(x), 6) for x in p]


def fallback_markers(H, centre_xy, theta_deg=_FB_THETA):
    """The brief's fallback joints, scaled by H/1.80 and centred on the model's xy centre. The arm joints use the
    arm elevation `theta_deg` (50 degrees is the table's own A-pose)."""
    k = H / 1.80
    cx, cy = centre_xy
    out = {}
    for n, p in _FB_CENTRAL.items():
        out[n] = np.array([cx + p[0] * k, cy + p[1] * k, p[2] * k])
    th = math.radians(theta_deg)
    for s, sign in (("L", 1.0), ("R", -1.0)):
        a = np.array([sign * math.cos(th), 0.0, -math.sin(th)])
        sx, sy, sz = _FB_SIDED["shoulder"]
        sh = np.array([sign * sx, sy, sz])
        el = sh + _FB_UPPER * a
        wr = el + _FB_LOWER * a
        for n, p in (("shoulder", sh), ("elbow", el), ("wrist", wr)):
            out["%s_%s" % (n, s)] = np.array([cx + p[0] * k, cy + p[1] * k, p[2] * k])
        for n in ("hip", "knee", "ankle", "toe"):
            p = _FB_SIDED[n]
            out["%s_%s" % (n, s)] = np.array([cx + sign * p[0] * k, cy + p[1] * k, p[2] * k])
    return out


# --------------------------------------------------------------------------
# legs (port of prototype fit_joints)
# --------------------------------------------------------------------------

def _bvh(objs):
    """BVH of all meshes in world space."""
    from mathutils.bvhtree import BVHTree
    verts, polys = [], []
    for o in objs:
        M = o.matrix_world
        base = len(verts)
        verts += [M @ v.co for v in o.data.vertices]
        polys += [[base + i for i in p.vertices] for p in o.data.polygons]
    return BVHTree.FromPolygons(verts, polys)


def _crotch(P, H, tree, x_mid, y_mid, slab):
    """Crotch height (Revision 2): first hit of an upward ray at the legs' centre; then a narrow-band
    midline scan; then 0.47 H. Returns (z, method_factor, warning|None)."""
    from mathutils import Vector
    if tree is not None:
        hit = tree.ray_cast(Vector((x_mid, y_mid, -1.0)), Vector((0.0, 0.0, 1.0)))
        if hit[0] is not None and hit[0].z >= 0.35 * H:
            return float(hit[0].z), 1.0, None
    for f in np.arange(0.35, 0.70, 0.005):
        sl = slab(f * H)
        ys = np.sort(sl[np.abs(sl[:, 0] - x_mid) < 0.004 * H][:, 1])
        if len(ys) < 3:
            continue
        runs = np.split(ys, np.nonzero(np.diff(ys) > 0.01 * H)[0] + 1)
        if any(len(r) > 2 and r[0] - 0.005 * H <= y_mid <= r[-1] + 0.005 * H for r in runs):
            return f * H, 1.0, None
    return 0.47 * H, 0.3, "crotch not found; assumed at 0.47 H"


def _fit_legs(P, H, J, errors, tree=None, warnings=None):
    gap, half = 0.012 * H, 0.006 * H

    def slab(z):
        return P[np.abs(P[:, 2] - z) < half]

    thighs = slab(0.30 * H)
    legs = [c for c in _pieces(thighs, gap) if 0.03 * H < abs(c[:, 0].mean()) < 0.2 * H]
    if not legs:
        raise RuntimeError("no leg pieces at 0.30 H")
    y_mid = float(np.mean([c[:, 1].mean() for c in legs]))
    x_mid = float(np.mean([c[:, 0].mean() for c in legs]))
    crotch, hip_factor, note = _crotch(P, H, tree, x_mid, y_mid, slab)
    if note and warnings is not None:
        warnings.append("marker hip_L/hip_R/pelvis: " + note)

    for s, sign in (("L", 1.0), ("R", -1.0)):
        def leg_cluster(z):
            cs = [c for c in _pieces(slab(z), gap) if (sign * c[:, 0]).min() > -0.01 * H
                  and 0.035 * H < abs(c[:, 0].mean()) < 0.2 * H]
            return max(cs, key=len) if cs else None

        try:
            c_hip = None
            for dz in np.arange(0.03, 0.16, 0.01):
                c_hip = leg_cluster(crotch - dz * H)
                if c_hip is not None:
                    break
            if c_hip is None:
                raise RuntimeError("couldn't find the top of the %s leg" % s)
            hip = np.array([c_hip[:, 0].mean(), c_hip[:, 1].mean(), crotch + 0.045 * H])
            J["hip_" + s] = (hip, hip_factor)
            c_ank = leg_cluster(0.10 * H)
            if c_ank is None:
                raise RuntimeError("couldn't find the %s ankle" % s)
            ank = np.array([c_ank[:, 0].mean(), c_ank[:, 1].mean(), 0.065 * H])
            J["ankle_" + s] = (ank, 1.0)
            lo, hi = ank[2], hip[2]
            ws = []
            best = None
            for t in np.linspace(0.40, 0.70, 31):
                c = leg_cluster(lo + t * (hi - lo))
                if c is None:
                    ws.append(None)
                    continue
                w = float(np.ptp(c[:, 0]))  # side-to-side only: plates in front skew depth
                ws.append(w)
                if best is None or w < best[0]:
                    best = (w, lo + t * (hi - lo))
            if best is None:
                raise RuntimeError("couldn't measure the %s knee" % s)
            ends = [w for w in (ws[0], ws[-1]) if w is not None]
            weak = any(best[0] > 0.97 * w for w in ends)  # minimum not >= 3 % narrower than both ends
            knee = ank + (hip - ank) * ((best[1] - lo) / (hi - lo))  # on the hip-ankle line
            J["knee_" + s] = (knee, 0.5 if weak else 1.0)
        except Exception as e:  # noqa: BLE001
            for n in ("hip", "ankle", "knee"):
                if "%s_%s" % (n, s) not in J:
                    errors["%s_%s" % (n, s)] = str(e)
        try:
            foot = P[(P[:, 2] < 0.04 * H) & (sign * P[:, 0] > 0)]
            tip = foot[np.argmin(foot[:, 1])]
            J["toe_" + s] = (np.array([tip[0], tip[1], 0.02 * H]), 1.0)
        except Exception as e:  # noqa: BLE001
            errors["toe_" + s] = str(e)


# --------------------------------------------------------------------------
# arms
# --------------------------------------------------------------------------

def _hand_and_axis(P, H, sign):
    band = P[(P[:, 2] > 0.35 * H) & (P[:, 2] < 0.95 * H) & (sign * P[:, 0] > 0)]
    if len(band) == 0:
        raise RuntimeError("no samples for the hand")
    hand = band[np.argmax(sign * band[:, 0])]
    S0 = np.array([sign * 0.11 * H, P[:, 1].mean(), 0.82 * H])
    A = hand - S0
    L0 = float(np.linalg.norm(A))
    A = A / L0
    theta = math.degrees(math.asin(max(-1.0, min(1.0, -A[2]))))
    return hand, S0, A, L0, theta


def _arm_basis(A):
    u = np.cross(A, (0.0, 0.0, 1.0))
    if np.linalg.norm(u) < 1e-3:
        u = np.array([0.0, 1.0, 0.0])
        u = u - A * u.dot(A)
    u = u / np.linalg.norm(u)
    v = np.cross(A, u)
    return u, v


HAND_ZONE = 0.12  # fraction of height from the fingertip inward that counts as the hand


def _trace_arm(P, H, sign, hand, S0, A, L0):
    gap, half = 0.012 * H, 0.006 * H
    u, v = _arm_basis(A)
    d_all = (P - S0) @ A
    band = P[(P[:, 2] > 0.35 * H) & (P[:, 2] < 0.95 * H) & (sign * P[:, 0] > 0)]  # same set as the hand: no feet
    fingertip = band[np.argmax((band - S0) @ A)]
    ft_t = float((fingertip - S0) @ A)

    traced = []  # (t, centroid3d, width)
    extents = []
    prev = None
    t = L0
    step = 0.005 * H
    while t > 0:
        t_now = t
        t -= step
        idx = np.nonzero(np.abs(d_all - t_now) < half)[0]
        cl = []
        if len(idx):
            pts = P[idx]
            rel = pts - (S0 + t_now * A)
            uv = np.stack([rel @ u, rel @ v], axis=1)
            cl = clusters2d(uv, gap)
        if not cl:
            if traced:
                break
            continue
        cents = [uv[c].mean(0) for c in cl]
        if prev is not None:
            ref = prev
        else:
            r = hand - S0 - t_now * A
            ref = np.array([r @ u, r @ v])
        k = int(np.argmin([np.linalg.norm(c - ref) for c in cents]))
        c = cl[k]
        ext = float(max(np.ptp(uv[c, 0]), np.ptp(uv[c, 1])))
        # Inside the hand (fingertips taper, the palm is wide) widths say nothing about the torso: judge the
        # merge only past the hand, against arm slices. Real models tripped this at the palm.
        in_hand = t_now > ft_t - HAND_ZONE * H
        if not in_hand and len(extents) >= 4 and ext > 2.5 * float(np.median(extents)):
            break  # merged into the torso
        if np.any(np.abs(pts[c, 0]) < 0.05 * H):
            break
        if not in_hand:
            extents.append(ext)
        prev = cents[k]
        q = uv[c] - uv[c].mean(0)
        ev = np.sqrt(np.maximum(np.linalg.eigvalsh(q.T @ q / max(len(q), 1)), 1e-12))
        traced.append((t_now, pts[c].mean(0), ext, float(ev[1] / ev[0])))  # last: flatness (1 = round)
    if len(traced) < 8:
        raise RuntimeError("couldn't trace the arm (%d steps)" % len(traced))
    return {"traced": traced, "ft_t": ft_t, "t_sep": traced[-1][0], "A": A}


ELBOW_FRACTION = 0.55


WRIST_ROUND = 1.5        # a cross-section this round or rounder is no longer the hand
WRIST_FLAT = 2.0         # the palm is at least this flat
WRIST_BEFORE = 0.015     # the landmark may lie this fraction of the height nearer the fingers than the estimate
WRIST_AFTER = 0.025      # ...or this much nearer the elbow


def wrist_from_estimate(tr, t_est, H):
    """The traced slice to use as the wrist, given where the fingers say it should be (t along the arm
    axis). Going from the fingers toward the elbow, the hand is flat and the wrist is the first round
    cross-section after the palm. If that landmark lies near the estimate it is the wrist; otherwise the
    estimate itself (gauntlets and bracers hide or fake the landmark)."""
    traced = tr["traced"]   # from the hand toward the shoulder (t decreasing)
    palm, land = 0, None
    for p in traced:
        if p[3] >= WRIST_FLAT:
            palm += 1
        elif palm >= 3 and p[3] <= WRIST_ROUND:
            land = p
            break
    if land is not None and -WRIST_BEFORE * H <= t_est - land[0] <= WRIST_AFTER * H:
        return land
    return min(traced, key=lambda p: abs(p[0] - t_est))


def _arm_joints(tr, H, P, sign, t_wrist=None, snap=True):
    traced, t_sep, ft_t = tr["traced"], tr["t_sep"], tr["ft_t"]
    if t_wrist is not None:
        w = wrist_from_estimate(tr, t_wrist, H) if snap else min(traced, key=lambda p: abs(p[0] - t_wrist))
    else:
        # First pass, before the fingers are known: the narrowest place near the hand. On gauntleted or
        # gloved characters that is often the palm, so the job refines it from the fingers afterwards.
        cand = [p for p in traced if 0.05 * H <= ft_t - p[0] <= 0.15 * H]
        if not cand:
            raise RuntimeError("no wrist candidates")
        w = min(cand, key=lambda p: p[2])
    wrist, t_w = w[1], w[0]
    near = [p for p in traced if p[0] <= t_sep + 0.10 * H]
    if len(near) < 2:
        raise RuntimeError("too few points for the shoulder line")
    ts = np.array([p[0] for p in near])
    C = np.array([p[1] for p in near])
    M = np.c_[ts, np.ones(len(ts))]
    coef = [np.linalg.lstsq(M, C[:, k], rcond=None)[0] for k in range(3)]

    def at(t):
        return np.array([c @ np.array([t, 1.0]) for c in coef])

    armpit = traced[-1][1]
    method = 1.0
    shoulder = None
    if abs(tr["A"][0]) >= 0.2 and abs(coef[0][0]) > 1e-6:
        # Revision 2: measure the rib cage clear of the arms (A- and T-pose): start 0.06 H below the
        # armpit and step down while the midline piece still spans arm to arm.
        torso_half = None
        z = armpit[2] - 0.06 * H
        while z >= armpit[2] - 0.15 * H:
            sl = P[np.abs(P[:, 2] - z) < 0.006 * H]
            cs = [c for c in _pieces(sl, 0.012 * H) if c[0, 0] <= 0.0 <= c[-1, 0]]
            if cs:
                c = max(cs, key=len)
                if np.ptp(c[:, 0]) <= 0.35 * H:
                    torso_half = float(np.abs(c[:, 0]).max())
                    break
            z -= 0.01 * H
        if torso_half is not None:
            r_arm = float(np.median([p[2] / 2 for p in near]))
            x_sh = sign * (torso_half + 0.6 * r_arm)
            t_x = (x_sh - coef[0][1]) / coef[0][0]
            cand = at(t_x)
            if np.linalg.norm(cand - armpit) <= 0.15 * H:
                shoulder, ts_sh = cand, t_x
    if shoulder is None:
        ts_sh = t_sep - 0.045 * H
        shoulder = at(ts_sh)
        method = 0.5
    line = [shoulder] + [p[1] for p in sorted(traced, key=lambda p: p[0]) if ts_sh < p[0] < t_w] + [wrist]
    seg = [float(np.linalg.norm(line[i + 1] - line[i])) for i in range(len(line) - 1)]
    # elbow at 55 % of shoulder->wrist arc length: upper arm ~0.186 H vs forearm ~0.146 H
    half_len, acc = sum(seg) * ELBOW_FRACTION, 0.0
    for i, d in enumerate(seg):
        if acc + d >= half_len:
            return shoulder, line[i] + (line[i + 1] - line[i]) * ((half_len - acc) / max(d, 1e-9)), wrist, method
        acc += d
    raise RuntimeError("couldn't place the elbow")


# --------------------------------------------------------------------------
# spine and head
# --------------------------------------------------------------------------

def _torso_centre(P, H, z):
    gap, half = 0.012 * H, 0.006 * H
    sl = P[np.abs(P[:, 2] - z) < half]
    cs = [c for c in _pieces(sl, gap) if c[0, 0] <= 0.0 <= c[-1, 0]]
    if cs:
        c = max(cs, key=len)
    elif len(sl):
        c = sl
    else:
        raise RuntimeError("no samples at z=%.3f" % z)
    return np.array([0.0, c[:, 1].mean(), z])


def _head(P, H, sh_z):
    gap, half = 0.012 * H, 0.006 * H

    def mid(z):
        sl = P[np.abs(P[:, 2] - z) < half]
        cs = [c for c in _pieces(sl, gap) if c[0, 0] <= 0.0 <= c[-1, 0]]
        return max(cs, key=len) if cs else None

    best = None
    for z in np.arange(sh_z + 0.04 * H, 0.95 * H + 1e-9, 0.005 * H):
        c = mid(z)
        if c is None:
            continue
        w = float(np.ptp(c[:, 0]))
        if best is None or w < best[0]:
            best = (w, z)
    if best is None:
        raise RuntimeError("no midline cluster in the head range")
    z_h = best[1] + 0.18 * (H - best[1])
    c = mid(z_h)
    if c is None:
        raise RuntimeError("no midline cluster at the head")
    return np.array([0.0, c[:, 1].mean(), z_h])


# --------------------------------------------------------------------------
# inside check (port)
# --------------------------------------------------------------------------

def inside_scores(objs, points):
    """Fraction of 6 axis rays from each point that hit the mesh (a point inside a closed shell scores 1.0)."""
    from mathutils import Vector
    from mathutils.bvhtree import BVHTree
    verts, polys = [], []
    for o in objs:
        M = o.matrix_world
        base = len(verts)
        verts += [M @ v.co for v in o.data.vertices]
        polys += [[base + i for i in p.vertices] for p in o.data.polygons]
    tree = BVHTree.FromPolygons(verts, polys)
    dirs = [Vector(d) for d in ((1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1))]
    return {k: sum(tree.ray_cast(Vector([float(x) for x in p]), d)[0] is not None for d in dirs) / 6
            for k, p in points.items()}


# --------------------------------------------------------------------------
# main entry points
# --------------------------------------------------------------------------

def _all_fallback(H, centre, warnings, why):
    fb = fallback_markers(H, centre)
    m = {n: {"p": _round(fb[n]), "confidence": FALLBACK_CONFIDENCE, "source": "auto"} for n in BODY_MARKERS}
    for n in BODY_MARKERS:
        warnings.append("marker %s: fallback used (%s)" % (n, why))
    return m


def analyse_body_markers(objs, wrist_at=None, snap=True):
    """Like suggest_body_markers but returns {"markers", "warnings", "H", "theta": {"L", "R"}}; theta is the arm
    elevation below horizontal in degrees (None when it could not be measured). Never raises.

    wrist_at: optional {"L": point, "R": point}, where the wrist should be according to the fingers (see
    suggest_markers); the wrist is then taken there instead of at the narrowest place near the hand."""
    warnings = []
    theta = {"L": None, "R": None}
    try:
        objs = select_meshes(objs)
        P = surface_samples(objs, N_SAMPLES)
        H = float(P[:, 2].max())
        centre = ((P[:, 0].min() + P[:, 0].max()) / 2, (P[:, 1].min() + P[:, 1].max()) / 2)
        if not H > 0:
            raise ValueError("model has no height")
    except Exception as e:  # noqa: BLE001
        return {"markers": _all_fallback(1.8, (0.0, 0.0), warnings, "could not sample the meshes: %s" % e),
                "warnings": warnings, "H": 1.8, "theta": theta}

    J = {}  # marker name -> (point, method factor)
    errors = {}  # marker name -> why it failed
    try:
        tree = _bvh(objs)
    except Exception:  # noqa: BLE001
        tree = None
    try:
        _fit_legs(P, H, J, errors, tree, warnings)
    except Exception as e:  # noqa: BLE001
        for n in BODY_MARKERS:
            if n[:3] in ("hip", "kne", "ank", "toe"):
                errors[n] = str(e)

    for s, sign in (("L", 1.0), ("R", -1.0)):
        try:
            hand, S0, A, L0, theta[s] = _hand_and_axis(P, H, sign)
            tr = _trace_arm(P, H, sign, hand, S0, A, L0)
            t_w = None
            if wrist_at and wrist_at.get(s) is not None:
                t_w = float((np.asarray(wrist_at[s], float) - S0) @ A)
            sh, el, wr, meth = _arm_joints(tr, H, P, sign, t_w, snap)
            J["shoulder_" + s], J["elbow_" + s], J["wrist_" + s] = (sh, meth), (el, 1.0), (wr, 1.0)
        except Exception as e:  # noqa: BLE001
            for n in ("shoulder", "elbow", "wrist"):
                errors["%s_%s" % (n, s)] = str(e)

    ths = [t for t in theta.values() if t is not None]
    fb = fallback_markers(H, centre, float(np.mean(ths)) if ths else _FB_THETA)

    hips = [J[k][0] for k in ("hip_L", "hip_R") if k in J]
    if hips:
        hip_z = float(np.mean([h[2] for h in hips]))
        J["pelvis"] = (np.array([0.0, float(np.mean([h[1] for h in hips])), hip_z]), 1.0)
    else:
        hip_z = float(fb["pelvis"][2])
        errors["pelvis"] = "no hips measured"
    shs = [J[k][0][2] for k in ("shoulder_L", "shoulder_R") if k in J]
    sh_z = float(np.mean(shs)) if shs else float((fb["shoulder_L"][2] + fb["shoulder_R"][2]) / 2)
    for name, fn in (("chest", lambda: _torso_centre(P, H, hip_z + 0.70 * (sh_z - hip_z))),
                     ("neck", lambda: _torso_centre(P, H, sh_z + 0.04 * H)),
                     ("head", lambda: _head(P, H, sh_z))):
        try:
            J[name] = (fn(), 1.0)
        except Exception as e:  # noqa: BLE001
            errors[name] = str(e)
    if "head" in J:
        J["head_top"] = (np.array([0.0, J["head"][0][1], H]), 1.0)
    else:
        errors["head_top"] = "no head measured"

    try:
        inside = inside_scores(objs, {k: v[0] for k, v in J.items()})
    except Exception as e:  # noqa: BLE001
        inside = {}
        warnings.append("inside check unavailable: %s" % e)

    markers = {}
    for n in BODY_MARKERS:
        if n not in J:
            warnings.append("marker %s: fallback used (%s)" % (n, errors.get(n, "not measured")))
            markers[n] = {"p": _round(fb[n]), "confidence": FALLBACK_CONFIDENCE, "source": "auto"}
            continue
        p, method = J[n]
        surface = n == "head_top" or n.startswith("toe_")  # defined on the surface: the inside check does not apply
        c = (1.0 if surface or inside.get(n, 1.0) >= 0.5 else 0.4) * method
        if n[-2:] in ("_L", "_R"):
            other = J.get(n[:-1] + ("R" if n[-1] == "L" else "L"))
            if other is not None:
                c *= 1.0 - min(1.0, abs(p[0] + other[0][0]) / (0.03 * H)) * 0.5
        markers[n] = {"p": _round(p), "confidence": round(float(c), 2), "source": "auto"}
    return {"markers": markers, "warnings": warnings, "H": H, "theta": theta}


def suggest_body_markers(objs):
    """(markers: dict, warnings: list[str]) for the editable body joints. Never raises."""
    try:
        r = analyse_body_markers(objs)
        return r["markers"], r["warnings"]
    except Exception as e:  # noqa: BLE001
        warnings = []
        return _all_fallback(1.8, (0.0, 0.0), warnings, "unexpected failure: %s" % e), warnings


PALM_PER_FINGER = 1.1   # wrist to knuckle, in middle-finger lengths (knuckle taken where the fingers part)


def wrist_estimates(markers, finger_markers, hand_info):
    """Where each wrist should be according to that hand's fingers: one palm length behind the middle
    knuckle, toward the current wrist. Only for hands whose fingers were really found."""
    out = {}
    for s in ("L", "R"):
        info = (hand_info or {}).get(s)
        if not info or info.get("fallback"):
            continue
        try:
            k0 = np.array(finger_markers["middle_0_" + s]["p"], float)
            lens = [float(np.linalg.norm(np.array(finger_markers["%s_tip_%s" % (f, s)]["p"], float)
                                         - np.array(finger_markers["%s_0_%s" % (f, s)]["p"], float)))
                    for f in ("index", "middle", "ring")
                    if finger_markers["%s_tip_%s" % (f, s)]["confidence"] >= 0.7]
            wr = np.array(markers["wrist_" + s]["p"], float)
            el = np.array(markers["elbow_" + s]["p"], float)
        except (KeyError, TypeError):
            continue
        if not lens:
            continue
        back = wr - k0
        if np.linalg.norm(back) < 1e-6 or float(back @ (el - k0)) <= 0:
            back = el - k0
        out[s] = k0 + back / np.linalg.norm(back) * PALM_PER_FINGER * max(lens)
    return out


def suggest_all(objs):
    """Body and finger markers together: {"markers", "warnings", "H"}. Never raises.

    Two passes. The wrist cannot be found from the arm alone on gloved or armoured characters (the
    narrowest place near the hand is often the palm), but the fingers can; they then say where the wrist is
    (a hand is about twice as long as its middle finger), and arm and fingers are measured again from it."""
    from . import fingers
    res = analyse_body_markers(objs)
    H = res["H"]
    fm, fw, info = fingers.suggest_finger_markers(objs, res["markers"], H)
    est = wrist_estimates(res["markers"], fm, info)
    if len(est) == 1:
        # One hand read, the other not: on a symmetric body the other wrist is the mirror image.
        (s, p), = est.items()
        o = "R" if s == "L" else "L"
        try:
            a = np.array(res["markers"]["shoulder_" + s]["p"], float) * np.array([-1.0, 1.0, 1.0])
            b = np.array(res["markers"]["shoulder_" + o]["p"], float)
            if np.linalg.norm(a - b) < 0.02 * H:
                est[o] = np.asarray(p, float) * np.array([-1.0, 1.0, 1.0])
        except (KeyError, TypeError):
            pass
    if est:
        res2 = analyse_body_markers(objs, wrist_at=est)
        if len(est) == 2:
            # Mirror-image hands must get mirror-image wrists. If snapping to a round cross-section
            # disagrees between the sides (a bracer or pouch on one arm), use the plain estimates.
            l = np.array(res2["markers"]["wrist_L"]["p"], float)
            r = np.array(res2["markers"]["wrist_R"]["p"], float) * np.array([-1.0, 1.0, 1.0])
            el = np.array(est["L"], float)
            er = np.array(est["R"], float) * np.array([-1.0, 1.0, 1.0])
            if np.linalg.norm(el - er) < 0.015 * H and np.linalg.norm(l - r) > 0.02 * H:
                res2 = analyse_body_markers(objs, wrist_at=est, snap=False)
        fm2, fw2, info2 = fingers.suggest_finger_markers(objs, res2["markers"], H)
        for s in est:
            if (info2.get(s) or {}).get("fallback", True):
                # The fingers were read from the first wrist but not from the refined one: they are where
                # they are either way, so keep the first reading rather than a mirrored or template hand.
                for k in [k for k in fm2 if k.endswith("_" + s)]:
                    del fm2[k]
                fm2.update({k: v for k, v in fm.items() if k.endswith("_" + s)})
                tag = "hand %s:" % s
                fw2 = [w for w in fw2 if not w.startswith(tag)] + [w for w in fw if w.startswith(tag)]
        res, fm, fw = res2, fm2, fw2
    markers = dict(res["markers"])
    markers.update(fm)
    return {"markers": markers, "warnings": list(res["warnings"]) + list(fw), "H": H}
