# SPDX-License-Identifier: GPL-3.0-or-later
"""Finger finding and hand weights on real character kits (tests/engine/kits.py). Real hands are the hard
part: fingers that separate one after another, fingers touching part of the way down, armour beside the
wrist, hands that are not mirror images. What must hold: every finger found, tips on the surface, sensible
lengths and order, and honest flags where something was estimated."""
import os
import sys
import time

import numpy as np

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(REPO, "engine"))
import kits  # noqa: E402
from mpm import importer  # noqa: E402
from mpm.rig import fingers  # noqa: E402
from mpm.rig import markers as mk  # noqa: E402

FING = fingers.FINGERS
LONG = fingers.LONG_FINGERS


def _scene(name):
    """(meshes, H, body markers) of a kit, opened in this process."""
    meshes = [o for o in kits.open_scene(name) if "mpm_proxy_of" not in o]
    res = kits.project(name, "markers").result("markers")
    H = kits.project(name, "import").result("import")["height_m"]
    body = {k: v for k, v in res["markers"].items() if k in mk.BODY_MARKERS}
    return meshes, H, body


def _tree(meshes):
    from mathutils.bvhtree import BVHTree
    verts, polys = [], []
    for o in meshes:
        base = len(verts)
        verts += [o.matrix_world @ v.co for v in o.data.vertices]
        polys += [[base + i for i in p.vertices] for p in o.data.polygons]
    return BVHTree.FromPolygons(verts, polys)


def _p(m, n):
    return np.asarray(m[n]["p"], float)


def _unit(v):
    return v / np.linalg.norm(v)


def test_all_fingers_found_on_the_surface():
    for name in kits.need(hard=False):
        meshes, H, body = _scene(name)
        t0 = time.perf_counter()
        m, warnings, info = fingers.suggest_finger_markers(meshes, body, H)
        dt = time.perf_counter() - t0
        tree = _tree(meshes)
        worst_tip = 0.0
        for s in ("L", "R"):
            assert info[s]["fallback"] is False, "%s: hand %s not found: %s" % (name, s, warnings)
            for f in FING:
                tip, k0 = m["%s_tip_%s" % (f, s)], m["%s_0_%s" % (f, s)]
                assert tip["confidence"] >= 0.7 and k0["confidence"] >= 0.7, (name, s, f, tip["confidence"])
                d = tree.find_nearest(tip["p"])[3]
                worst_tip = max(worst_tip, d)
                assert d < 0.005, "%s: %s %s tip is %.1f mm off the surface" % (name, s, f, d * 1000)
                assert tree.find_nearest(k0["p"])[3] < 0.02, (name, s, f, "knuckle far from the hand")
                length = float(np.linalg.norm(_p(m, "%s_tip_%s" % (f, s)) - _p(m, "%s_0_%s" % (f, s))))
                assert 0.018 * H < length < 0.075 * H, "%s: %s %s is %.0f mm long" % (name, s, f, length * 1000)
        assert dt < 20.0, dt
        print("  %s: 10 fingers found, worst tip %.1f mm off the surface, %.1f s" % (name, worst_tip * 1000, dt))


def test_finger_order_and_thumb_side():
    for name in kits.need(hard=False):
        meshes, H, body = _scene(name)
        m, _w, info = fingers.suggest_finger_markers(meshes, body, H)
        for s in ("L", "R"):
            wrist = _p(body, "wrist_" + s)
            lat = _unit(_p(m, "index_0_" + s) - _p(m, "pinky_0_" + s))
            proj = [float(np.dot(_p(m, "%s_0_%s" % (f, s)) - wrist, lat)) for f in LONG]
            assert proj == sorted(proj, reverse=True), "%s %s: finger order %s" % (name, s, proj)
            # the thumb is on the index side, and based nearer the wrist than any knuckle
            assert np.dot(_p(m, "thumb_tip_" + s) - _p(m, "middle_0_" + s), lat) > 0, (name, s, "thumb side")
            ah = _unit(_p(m, "middle_0_" + s) - wrist)
            assert np.dot(_p(m, "thumb_0_" + s) - wrist, ah) < min(
                np.dot(_p(m, "%s_0_%s" % (f, s)) - wrist, ah) for f in LONG), (name, s, "thumb base")
            # hand frame: unit, orthogonal, the two palms face mirrored ways
            pn, la, ha = (np.asarray(info[s][k]) for k in ("palm_normal", "lateral", "hand_axis"))
            assert abs(np.linalg.norm(pn) - 1) < 1e-6 and abs(np.dot(pn, ha)) < 1e-6, (name, s)
            assert info[s]["hand_width"] > 0.02 * H, (name, s, info[s]["hand_width"])
        pl, prr = np.asarray(info["L"]["palm_normal"]), np.asarray(info["R"]["palm_normal"])
        assert np.dot(pl * np.array([-1.0, 1.0, 1.0]), prr) > 0.7, "%s: palms do not mirror %s %s" % (name, pl, prr)


def test_one_hand_failing_takes_the_other_mirrored():
    """When one hand cannot be read it takes the other hand's layout, mirrored, flagged for checking.
    On a symmetric kit the mirrored fingers must land close to where that hand's own fingers are."""
    for name in kits.need(hard=False)[:3]:
        meshes, H, body = _scene(name)
        direct, _w, _i = fingers.suggest_finger_markers(meshes, body, H)
        real = fingers._analyse_hand

        def fail_right(objs, wrist, elbow, side, H_):
            if side == "R":
                raise fingers._Fail("forced by the test")
            return real(objs, wrist, elbow, side, H_)

        fingers._analyse_hand = fail_right
        try:
            m, warnings, info = fingers.suggest_finger_markers(meshes, body, H)
        finally:
            fingers._analyse_hand = real
        assert any("mirrored from the left hand" in w for w in warnings), warnings
        assert info["R"]["fallback"] is True and info["L"]["fallback"] is False
        tree = _tree(meshes)
        errs, off = [], []
        for f in FING:
            for k in ("0", "tip"):
                n = "%s_%s_R" % (f, k)
                assert m[n]["confidence"] <= fingers.MIRRORED_CONFIDENCE, m[n]
                errs.append(float(np.linalg.norm(_p(m, n) - _p(direct, n))))
            off.append(tree.find_nearest(m["%s_tip_R" % f]["p"])[3])
        print("  %s: mirrored right hand, worst %.1f mm from its own fingers, worst tip %.1f mm off the surface"
              % (name, max(errs) * 1000, max(off) * 1000))
        assert max(off) < 0.025, "%s: a mirrored fingertip is %.0f mm off the hand" % (name, max(off) * 1000)


def test_template_is_the_last_resort():
    name = kits.need(hard=False)[0]
    meshes, H, body = _scene(name)
    real = fingers._analyse_hand

    def fail(*_a):
        raise fingers._Fail("forced by the test")

    fingers._analyse_hand = fail
    try:
        m, warnings, info = fingers.suggest_finger_markers(meshes, body, H)
    finally:
        fingers._analyse_hand = real
    tree = _tree(meshes)
    for s in ("L", "R"):
        assert info[s]["fallback"] is True
        assert any("hand %s" % s in w and "template" in w for w in warnings), warnings
        for f in FING:
            for k in ("0", "tip"):
                assert m["%s_%s_%s" % (f, k, s)]["confidence"] <= 0.3
        # laid along the measured hand, the template's long fingers stay near it
        far = max(tree.find_nearest(m["%s_tip_%s" % (f, s)]["p"])[3] for f in LONG)
        assert far < 0.03 * H, "%s %s: a template fingertip is %.0f mm from the hand" % (name, s, far * 1000)


def test_never_raises():
    name = kits.need()[0]
    meshes, H, body = _scene(name)
    m, warnings, info = fingers.suggest_finger_markers([], body, H)
    for s in ("L", "R"):
        assert info[s]["fallback"] is True and m["index_tip_" + s]["confidence"] <= 0.3
    m, warnings, info = fingers.suggest_finger_markers(meshes, {}, H)
    assert warnings


def test_hard_kits_flag_what_they_estimate():
    for name in kits.need(hard=True):
        meshes, H, body = _scene(name)
        m, warnings, info = fingers.suggest_finger_markers(meshes, body, H)
        assert len(m) >= 20   # 20 plus optional knuckle points on curved fingers
        tree = _tree(meshes)
        for s in ("L", "R"):
            for f in FING:
                tip = m["%s_tip_%s" % (f, s)]
                d = tree.find_nearest(tip["p"])[3]
                if d > 0.01:  # a fingertip that is not on the hand must not claim to be sure
                    assert tip["confidence"] <= 0.6, "%s %s %s: %.0f mm off the hand at confidence %.2f" % (
                        name, s, f, d * 1000, tip["confidence"])
        print("  %s: %s" % (name, warnings or "all fingers found"))


def test_knuckle_points_for_curved_fingers():
    """Curved fingers and claws get two optional points per finger on the finger's own centreline; the
    rig then bends through them instead of cutting the corner. Straight fingers get none."""
    from mpm import skeleton as SK
    seen = 0
    for name in kits.need():
        meshes, H, body = _scene(name)
        m, _w, _info = fingers.suggest_finger_markers(meshes, body, H)
        tree = _tree(meshes)
        extra = sorted(k for k in m if k.split("_")[1] in ("1", "2"))
        print("  %s: knuckle points on %s" % (name, sorted({k.rsplit("_", 2)[0] + "_" + k[-1] for k in extra}) or "no finger"))
        for k in extra:
            f, _n, s = k.split("_")
            assert ("%s_1_%s" % (f, s)) in m and ("%s_2_%s" % (f, s)) in m, k      # always as a pair
            assert tree.find_nearest(m[k]["p"])[3] < 0.02, "%s: %s is %.0f mm from the hand" % (
                name, k, tree.find_nearest(m[k]["p"])[3] * 1000)
            a, t = _p(m, "%s_0_%s" % (f, s)), _p(m, "%s_tip_%s" % (f, s))
            u = float(np.dot(_p(m, k) - a, t - a) / np.dot(t - a, t - a))
            assert -0.1 < u < 1.1, (name, k, u)                                      # between knuckle and tip
        seen += len(extra)
        markers = {k: v["p"] for k, v in {**body, **m}.items()}
        J = SK.derive_joints(markers)
        for k in extra:
            assert np.allclose(J[k], m[k]["p"]), (name, k)
        if not extra:   # without them the middle joints are on the straight line
            a, t = np.asarray(J["index_0_L"]), np.asarray(J["index_tip_L"])
            assert np.allclose(J["index_1_L"], a + 0.45 * (t - a))
    assert kits.names(hard=True) == [] or seen > 0, "no curved finger was given knuckle points on the hard kits"


def test_hand_weights_on_a_real_hand():
    """hand_weight_fractions: fractions sum to 1, fingertip vertices belong to the fingertip bone, palm
    vertices to the hand, and nothing outside the hand gets finger weight."""
    import bpy
    sys.path.insert(0, os.path.join(REPO, "engine", "jobs"))
    from mpm import skeleton as SK
    for name in kits.need(hard=False)[:2]:
        meshes, H, body = _scene(name)
        fm, _w, _i = fingers.suggest_finger_markers(meshes, body, H)
        markers = {k: v["p"] for k, v in {**body, **fm}.items()}
        J = SK.derive_joints(markers)
        Jl = {k: [float(x) for x in v] for k, v in J.items()}
        info = fingers.hand_info_from_markers(meshes, Jl, H)
        for s in ("L", "R"):
            assert info[s]["fallback"] is False
            for key in ("hand_axis", "lateral", "palm_normal", "hand_width", "wrist", "forearm_axis", "H", "joints"):
                assert key in info[s], key
            got = 0
            for o in meshes:
                wv = importer._world_verts(o)
                w = fingers.hand_weight_fractions(o, Jl, s, info)
                got += len(w)
                for i, fr in w.items():
                    assert abs(sum(fr.values()) - 1.0) < 1e-6 and all(b.endswith("." + s) for b in fr), (i, fr)
                    assert np.linalg.norm(wv[i] - np.asarray(J["wrist_" + s])) < 0.2 * H, "weights far from the hand"
                tip = np.asarray(J["index_tip_" + s])
                near = [i for i in w if np.linalg.norm(wv[i] - tip) < 0.008]
                for i in near:
                    assert w[i].get("index.03." + s, 0.0) > 0.8, (name, s, i, w[i])
                wr, mid = np.asarray(J["wrist_" + s]), np.asarray(J["middle_0_" + s])
                L = float(np.linalg.norm(mid - wr))
                ah = (mid - wr) / L
                thumb = [np.asarray(J["%s_%s" % (k, s)]) for k in ("thumb_0", "thumb_1", "thumb_2", "thumb_tip")]

                def seg_d(p, a, b):
                    t = np.clip(np.dot(p - a, b - a) / max(np.dot(b - a, b - a), 1e-12), 0.0, 1.0)
                    return float(np.linalg.norm(p - (a + t * (b - a))))

                palm = [i for i in w if 0.1 < float(np.dot(wv[i] - wr, ah)) / L < 0.5
                        and min(seg_d(wv[i], thumb[k], thumb[k + 1]) for k in range(3)) > 0.03]
                bad = [i for i in palm if w[i].get("hand." + s, 0.0) < 0.5]
                assert len(bad) <= 0.1 * max(len(palm), 1), "%s %s: %d of %d palm vertices not on the hand bone" % (
                    name, s, len(bad), len(palm))
            assert got > 50, (name, s, got)
        # a loose vertex 15 cm off the palm gets nothing
        far = np.asarray(J["wrist_L"]) + 0.15 * np.asarray(info["L"]["palm_normal"]) + 0.05 * np.asarray(info["L"]["hand_axis"])
        me = bpy.data.meshes.new("extra")
        me.from_pydata([tuple(far)], [], [])
        ob = bpy.data.objects.new("extra", me)
        bpy.context.scene.collection.objects.link(ob)
        assert 0 not in fingers.hand_weight_fractions(ob, Jl, "L", info)
