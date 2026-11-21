# SPDX-License-Identifier: GPL-3.0-or-later
"""Body joint finding on real character kits (tests/engine/kits.py). There is no made-up ground truth: the
tests assert what must hold on any real humanoid (measured, inside the body, anatomically ordered and
proportioned, symmetric) and compare against marker positions a person reviewed and accepted
(tests/local/expected/<kit>.markers.json, written by accept_kit.py)."""
import json
import os
import sys

import numpy as np

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(REPO, "engine"))
import kits  # noqa: E402
from mpm.rig import markers as mk  # noqa: E402

FALLBACK = 0.2
PAIRS = [n[:-2] for n in mk.BODY_MARKERS if n.endswith("_L")]


def _markers(name):
    return kits.project(name, "markers").result("markers")


def _p(m, n):
    return np.array(m[n]["p"], float)


def test_every_body_joint_is_measured():
    """On an ordinary humanoid kit no body joint falls back to a guess and all are confident."""
    for name in kits.need(hard=False):
        res = _markers(name)
        m = res["markers"]
        assert set(mk.BODY_MARKERS) <= set(m), set(mk.BODY_MARKERS) - set(m)
        guessed = [n for n in mk.BODY_MARKERS if m[n]["confidence"] <= FALLBACK]
        assert not guessed, "%s: guessed joints %s (%s)" % (name, guessed, res["warnings"])
        # The head joint may sit under a hat or crest (the inside test then lowers it); everything else is sure.
        low = [(n, m[n]["confidence"]) for n in mk.BODY_MARKERS if m[n]["confidence"] < 0.8 and n != "head"]
        assert not low, "%s: low confidence %s" % (name, low)
        print("  %s: %d body joints measured, lowest %.2f" % (
            name, len(mk.BODY_MARKERS), min(m[n]["confidence"] for n in mk.BODY_MARKERS)))


def test_hard_kits_still_get_every_marker():
    """Unusual anatomy (claws, spikes, armour): never an exception, every marker present, and what could
    not be measured is flagged at low confidence with a warning naming it."""
    for name in kits.need(hard=True):
        res = _markers(name)
        m = res["markers"]
        assert set(mk.BODY_MARKERS) <= set(m)
        for n in mk.BODY_MARKERS:
            if m[n]["confidence"] <= FALLBACK:
                assert any(n in w for w in res["warnings"]), (n, res["warnings"])
        measured = [n for n in mk.BODY_MARKERS if m[n]["confidence"] > FALLBACK]
        print("  %s: %d of %d body joints measured" % (name, len(measured), len(mk.BODY_MARKERS)))
        assert len(measured) >= 15, measured


def test_anatomy():
    """Joint order, proportions and symmetry that hold on any standing humanoid."""
    for name in kits.need(hard=False):
        m = _markers(name)["markers"]
        H = kits.project(name, "import").result("import")["height_m"]
        z = lambda n: _p(m, n)[2]  # noqa: E731
        for s in "LR":
            chain = ["toe_", "ankle_", "knee_", "hip_"]
            zs = [z(c + s) for c in chain]
            assert zs == sorted(zs), (name, s, dict(zip(chain, zs)))
            assert z("wrist_" + s) < z("elbow_" + s) < z("shoulder_" + s) + 0.05 * H, (name, s)
            thigh = np.linalg.norm(_p(m, "hip_" + s) - _p(m, "knee_" + s))
            shin = np.linalg.norm(_p(m, "knee_" + s) - _p(m, "ankle_" + s))
            upper = np.linalg.norm(_p(m, "shoulder_" + s) - _p(m, "elbow_" + s))
            fore = np.linalg.norm(_p(m, "elbow_" + s) - _p(m, "wrist_" + s))
            assert 0.75 < thigh / shin < 1.45, (name, s, "thigh/shin", thigh / shin)
            assert 0.8 < upper / fore < 1.7, (name, s, "upper arm/forearm", upper / fore)
            assert 0.18 * H < thigh < 0.33 * H and 0.11 * H < upper < 0.24 * H, (name, s, thigh / H, upper / H)
            assert abs(_p(m, "shoulder_" + s)[0]) > abs(_p(m, "hip_" + s)[0]), (name, s, "shoulders wider than hips")
        spine = [z("pelvis"), z("chest"), z("neck"), z("head"), z("head_top")]
        assert spine == sorted(spine), (name, spine)
        assert 0.42 * H < z("pelvis") < 0.62 * H, (name, z("pelvis") / H)
        assert 0.70 * H < z("neck") < 0.90 * H, (name, z("neck") / H)
        sw = abs(_p(m, "shoulder_L")[0] - _p(m, "shoulder_R")[0])
        assert 0.16 * H < sw < 0.36 * H, (name, "shoulder width", sw / H)
        for b in PAIRS:
            l, r = _p(m, b + "_L"), _p(m, b + "_R")
            d = np.linalg.norm(l - r * np.array([-1.0, 1.0, 1.0]))
            assert d < 0.03 * H, "%s: %s not symmetric (%.1f cm)" % (name, b, d * 100)
        for n in ("pelvis", "chest", "neck", "head", "head_top"):
            assert abs(_p(m, n)[0]) < 0.01 * H, (name, n)


def test_joints_are_inside_the_body():
    for name in kits.need(hard=False):
        m = _markers(name)["markers"]
        meshes = [o for o in kits.open_scene(name) if "mpm_proxy_of" not in o]
        inner = [n for n in mk.BODY_MARKERS if n not in ("head_top", "head") and not n.startswith("toe_")]
        score = mk.inside_scores(meshes, {n: _p(m, n) for n in inner})
        out = {n: s for n, s in score.items() if s < 0.5}
        assert not out, "%s: joints outside the mesh %s" % (name, out)


def test_matches_reviewed_markers():
    """Regression against positions a person looked at and accepted for each kit."""
    checked = 0
    for name in kits.need():
        exp = kits.expected_markers(name)
        if exp is None:
            print("  %s: no reviewed markers yet (tests/engine/accept_kit.py)" % name)
            continue
        m = _markers(name)["markers"]
        H = kits.project(name, "import").result("import")["height_m"]
        worst = max(((float(np.linalg.norm(_p(m, n) - np.array(p["p"]))) / H, n) for n, p in exp.items() if n in m))
        print("  %s: worst move from the reviewed markers %.2f %% of height (%s)" % (name, worst[0] * 100, worst[1]))
        assert worst[0] < 0.015, "%s: %s moved %.1f cm from its reviewed position" % (name, worst[1], worst[0] * H * 100)
        checked += 1
    if not checked:
        import unittest
        raise unittest.SkipTest("no reviewed markers on this machine")


def test_markers_file_and_job_result():
    name = kits.need()[0]
    pr = kits.project(name, "markers")
    out = pr.result("markers")
    assert "markers" in out and isinstance(out["warnings"], list)
    with open(os.path.join(pr.dir, "rig", "markers.json"), encoding="utf-8") as f:
        doc = json.load(f)
    assert doc["schema"] == "mpm.markers/1"
    assert set(mk.BODY_MARKERS) <= set(doc["markers"]) and len(doc["markers"]) >= 39   # + optional knuckle points
    for n, m in doc["markers"].items():
        assert set(m) == {"p", "confidence", "source"}, (n, m)
        assert len(m["p"]) == 3 and all(isinstance(x, float) for x in m["p"]), (n, m)
        assert 0.0 <= m["confidence"] <= 1.0 and m["source"] == "auto", (n, m)


def test_robust_without_arms():
    """A body with its arms cut off: no exception, arm joints flagged as guesses, legs unchanged."""
    import bmesh
    name = kits.need(hard=False)[0]
    meshes = [o for o in kits.open_scene(name) if "mpm_proxy_of" not in o]
    base, _w = mk.suggest_body_markers(meshes)
    cut = 1.3 * abs(base["shoulder_L"]["p"][0])   # just outside the shoulders: the arms go, the torso stays
    for o in meshes:
        bm = bmesh.new()
        bm.from_mesh(o.data)
        bmesh.ops.delete(bm, geom=[v for v in bm.verts if abs(v.co.x) > cut], context='VERTS')
        bm.to_mesh(o.data)
        bm.free()
    markers, warnings = mk.suggest_body_markers(meshes)
    assert set(markers) == set(mk.BODY_MARKERS)
    for n in mk.BODY_MARKERS:
        if n.startswith(("wrist", "elbow")):
            assert markers[n]["confidence"] == FALLBACK, (n, markers[n])
        if markers[n]["confidence"] == FALLBACK:
            assert any(n in w for w in warnings), (n, warnings)
    H = max(m["p"][2] for m in markers.values())
    for n in ("hip_L", "knee_R", "ankle_L", "toe_R"):
        assert np.linalg.norm(np.array(markers[n]["p"]) - np.array(base[n]["p"])) < 0.02 * H, n
    print("  %s without arms: guessed %s" % (name, [n for n in mk.BODY_MARKERS if markers[n]["confidence"] == FALLBACK]))


def test_never_raises_on_nonsense():
    import bpy
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=(0, 0, 0.5))
    markers, warnings = mk.suggest_body_markers([bpy.context.active_object])
    assert set(markers) == set(mk.BODY_MARKERS) and warnings
    markers, warnings = mk.suggest_body_markers([])
    assert set(markers) == set(mk.BODY_MARKERS) and warnings
