# SPDX-License-Identifier: GPL-3.0-or-later
"""Acceptance tests for WP4b (docs/briefs/WP4b-fingers.md): finger markers and hand weight fractions."""
import json
import os
import sys
import time

import numpy as np

import bpy

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(REPO, "engine"))
from mpm import importer  # noqa: E402
from mpm.rig import fingers  # noqa: E402

FING = fingers.FINGERS
_cache = {}


def fx_dir():
    return os.environ.get("MPM_FIXTURES") or os.path.join(REPO, "fixtures", "out")


def truth(name):
    with open(os.path.join(fx_dir(), name, name + ".truth.json"), "r", encoding="utf-8") as f:
        return json.load(f)


def load(name):
    """Import a fixture; returns (meshes, H, truth joints)."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    new = importer.import_model(os.path.join(fx_dir(), name, name + ".fbx"))
    meshes, _arm, _w = importer.select_objects(new)
    pts = importer._all_world_verts(meshes)
    H = float(pts[:, 2].max() - pts[:, 2].min())
    return meshes, H, truth(name)


def body_markers(J):
    return {k: {"p": J[k], "confidence": 1.0, "source": "auto"} for k in ("wrist_L", "elbow_L", "wrist_R", "elbow_R")}


def run(name):
    meshes, H, T = load(name)
    J = {k: np.asarray(v, np.float64) for k, v in T["joints"].items()}
    t0 = time.perf_counter()
    markers, warnings, info = fingers.suggest_finger_markers(meshes, body_markers(T["joints"]), H)
    dt = time.perf_counter() - t0
    return meshes, H, T, J, markers, warnings, info, dt


def P(markers, name):
    return np.asarray(markers[name]["p"], np.float64)


def error_table(name, J, markers):
    rows = []
    for s in ("L", "R"):
        hl = float(np.linalg.norm(J["middle_tip_" + s] - J["wrist_" + s]))
        for f in FING:
            e0 = np.linalg.norm(P(markers, "%s_0_%s" % (f, s)) - J["%s_0_%s" % (f, s)]) / hl
            et = np.linalg.norm(P(markers, "%s_tip_%s" % (f, s)) - J["%s_tip_%s" % (f, s)]) / hl
            rows.append((s, f, e0, et))
    print("per-finger error table for %s (fraction of hand length): side finger knuckle tip" % name)
    for s, f, e0, et in rows:
        print("  %s %-6s %.3f %.3f" % (s, f, e0, et))
    return rows


def _check_markers_present(markers):
    for s in ("L", "R"):
        for f in FING:
            for k in ("0", "tip"):
                m = markers["%s_%s_%s" % (f, k, s)]
                assert m["source"] == "auto" and 0.0 <= m["confidence"] <= 1.0 and len(m["p"]) == 3


def _tips_knuckles(name, tip_tol, knuckle_tol):
    _m, _H, _T, J, markers, warnings, info, _dt = run(name)
    _check_markers_present(markers)
    rows = error_table(name, J, markers)
    for s, f, e0, et in rows:
        assert et < tip_tol, "%s %s tip error %.3f hl" % (s, f, et)
        if knuckle_tol is not None:
            assert e0 < knuckle_tol, "%s %s knuckle error %.3f hl" % (s, f, e0)
    return J, markers, info


def _assert_detected(info, markers):
    for s in ("L", "R"):
        assert info[s]["fallback"] is False, "hand %s fell back to the template" % s
        for f in FING:
            for k in ("0", "tip"):
                assert markers["%s_%s_%s" % (f, k, s)]["confidence"] > 0.9, (s, f, k)


def test_tips_knuckles_apose():
    _J, markers, info = _tips_knuckles("apose", 0.15, 0.20)
    _assert_detected(info, markers)


def test_tips_knuckles_tpose():
    _J, markers, info = _tips_knuckles("tpose", 0.15, 0.20)
    _assert_detected(info, markers)


def _thumb_order_normal(name):
    J, markers, info = _tips_knuckles(name, 1.0, None)
    T = truth(name)
    for s in ("L", "R"):
        wrist = J["wrist_" + s]
        # thumb tip is the marker furthest from the finger axis, on the index side
        pts = {f: P(markers, "%s_tip_%s" % (f, s)) for f in FING}
        a = _unit(P(markers, "middle_0_" + s) - wrist)
        lat = _unit(P(markers, "index_0_" + s) - P(markers, "pinky_0_" + s))
        ang = {f: np.arccos(np.clip(np.dot(_unit(pts[f] - wrist), a), -1, 1)) for f in FING}
        assert max(ang, key=ang.get) == "thumb", "thumb is not the widest-angle tip: %s" % ang
        # finger order: index, middle, ring, pinky along the lateral axis (index first)
        proj = [float(np.dot(pts[f] - wrist, lat)) for f in LONG]
        assert proj == sorted(proj, reverse=True), "finger order wrong: %s" % proj
        # the thumb lies on the index side
        assert np.dot(pts["thumb"] - wrist, lat) > 0
        # palm normal sign
        pn = np.asarray(info[s]["palm_normal"])
        assert np.dot(pn, np.asarray(T["hands"][s]["palm_normal"])) > 0.9, (s, pn)
        if name == "apose" and s == "L":
            assert pn[0] < 0
        assert np.dot(np.asarray(info[s]["lateral"]), np.asarray(T["hands"][s]["lateral"])) > 0.9


LONG = fingers.LONG_FINGERS


def _unit(v):
    return v / np.linalg.norm(v)


def test_thumb_order_normal_apose():
    _thumb_order_normal("apose")


def test_thumb_order_normal_tpose():
    _thumb_order_normal("tpose")


def test_tips_curled():
    _m, _H, _T, J, markers, _w, info, _dt = run("curled")
    rows = error_table("curled", J, markers)
    print("curled fallback flags:", {s: info[s]["fallback"] for s in info})
    bad = [(s, f) for s, f, _e0, et in rows if et > 0.25]
    for s, f in bad:
        assert markers["%s_tip_%s" % (f, s)]["confidence"] <= 0.4,             "%s %s tip is wrong but claims confidence %.2f" % (s, f, markers["%s_tip_%s" % (f, s)]["confidence"])


def test_fallback_mitten():
    _m, _H, _T, _J, markers, warnings, info, _dt = run("mitten")
    _check_markers_present(markers)
    for s in ("L", "R"):
        assert info[s]["fallback"] is True
        for f in FING:
            for k in ("0", "tip"):
                assert markers["%s_%s_%s" % (f, k, s)]["confidence"] <= 0.3
    assert warnings


def test_never_raises():
    meshes, H, T = load("apose")
    markers, warnings, info = fingers.suggest_finger_markers([], body_markers(T["joints"]), H)
    for s in ("L", "R"):
        assert info[s]["fallback"] is True
        assert markers["index_tip_" + s]["confidence"] <= 0.3
    markers, warnings, info = fingers.suggest_finger_markers(meshes, {}, H)
    assert warnings


def test_hand_info_from_markers_and_weights():
    meshes, H, T = load("apose")
    J = {k: np.asarray(v, np.float64) for k, v in T["joints"].items()}
    info = fingers.hand_info_from_markers(meshes, T["joints"], H)
    body = max(meshes, key=lambda o: len(o.data.vertices))
    wv = importer._world_verts(body)
    for s in ("L", "R"):
        assert info[s]["fallback"] is False
        for key in ("verts", "edges", "dist_from_wrist", "pred", "tips", "labels"):
            assert key not in info[s], "proxy key %r must not be in hand_info" % key
        for key in ("hand_axis", "lateral", "palm_normal", "hand_width", "wrist", "forearm_axis", "H", "joints"):
            assert key in info[s], key
        w = fingers.hand_weight_fractions(body, T["joints"], s, info)
        assert len(w) > 100
        for i, fr in w.items():
            assert abs(sum(fr.values()) - 1.0) < 1e-6, (i, fr)
            assert all(0.0 <= x <= 1.0 + 1e-9 for x in fr.values())
        for f_bones in w.values():
            for b in f_bones:
                assert b.endswith("." + s)
        tip = J["index_tip_" + s]
        near = [i for i in w if np.linalg.norm(wv[i] - tip) < 0.01]
        assert near, "no mesh vertices near the index tip"
        for i in near:
            assert w[i].get("index.03." + s, 0.0) > 0.9, (s, i, w[i])
        # Palm vertices: the proximal 60 % of wrist->middle knuckle along the hand axis, at least 1.5 cm
        # from the thumb chain (the thumb root legitimately carries thumb weight). The fixture palm block
        # is low-poly: its only vertices sit at its wrist and knuckle ends, so test every such vertex.
        wr = np.asarray(J["wrist_" + s])
        ax = np.asarray(J["middle_0_" + s]) - wr
        L = float(np.linalg.norm(ax))
        ah = ax / L
        thumb = [np.asarray(J[k + "_" + s]) for k in ("thumb_0", "thumb_1", "thumb_2", "thumb_tip")]

        def seg_d(p, a, b):
            t = np.clip(np.dot(p - a, b - a) / max(np.dot(b - a, b - a), 1e-12), 0.0, 1.0)
            return float(np.linalg.norm(p - (a + t * (b - a))))

        near = [i for i in w
                if 0.0 < float(np.dot(wv[i] - wr, ah)) / L < 0.6
                and min(seg_d(wv[i], thumb[k], thumb[k + 1]) for k in range(3)) > 0.015]
        assert near, "no palm vertices found"
        for i in near:
            assert w[i].get("hand." + s, 0.0) > 0.6, (s, i, w[i])


def test_weights_cutoff_far_vertex():
    meshes, H, T = load("apose")
    J = {k: np.asarray(v, np.float64) for k, v in T["joints"].items()}
    info = fingers.hand_info_from_markers(meshes, T["joints"], H)
    far = J["wrist_L"] + np.array([-0.06, 0.0, -0.05])
    me = bpy.data.meshes.new("extra")
    me.from_pydata([tuple(far)], [], [])
    ob = bpy.data.objects.new("extra", me)
    bpy.context.scene.collection.objects.link(ob)
    w = fingers.hand_weight_fractions(ob, T["joints"], "L", info)
    assert 0 not in w, "a vertex 5 cm from the hand must not get hand weights"
    near = J["wrist_L"] + 0.4 * (J["middle_0_L"] - J["wrist_L"])
    me2 = bpy.data.meshes.new("extra2")
    me2.from_pydata([tuple(near)], [], [])
    ob2 = bpy.data.objects.new("extra2", me2)
    bpy.context.scene.collection.objects.link(ob2)
    assert 0 in fingers.hand_weight_fractions(ob2, T["joints"], "L", info)


def _lerp(a, b, t):
    return a + t * (b - a)


def test_speed():
    _m, _H, _T, _J, _mk, _w, _info, dt = run("apose")
    print("suggest_finger_markers (both sides): %.2f s" % dt)
    assert dt / 2.0 < 10.0
