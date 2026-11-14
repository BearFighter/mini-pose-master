# SPDX-License-Identifier: GPL-3.0-or-later
"""Acceptance tests for WP4a (docs/briefs/WP4a-body-markers.md): automatic body markers."""
import json
import os
import shutil
import subprocess
import sys
import tempfile

import numpy as np

import bpy

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(REPO, "engine"))
from mpm import importer  # noqa: E402
from mpm.rig import markers as mk  # noqa: E402

_cache = {}


def fx_dir():
    return os.environ.get("MPM_FIXTURES") or os.path.join(REPO, "fixtures", "out")


def fx(name, ext=".fbx"):
    return os.path.join(fx_dir(), name, name + ext)


def load_truth(name):
    with open(fx(name, ".truth.json"), "r", encoding="utf-8") as f:
        return json.load(f)


def load_normalised(name):
    """Import + normalise a fixture the way the import job does. Returns (meshes, truth joints in the
    normalised frame)."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    new = importer.import_model(fx(name))
    meshes, arm, _w = importer.select_objects(new)
    sug = importer.suggest_orientation(meshes)
    # the translation normalise() applies: bbox centre to x = y = 0, lowest point to z = 0
    M = np.array(importer.orientation_matrix(sug))
    pts = importer._all_world_verts(meshes) @ M[:3, :3].T + M[:3, 3]
    lo, hi = pts.min(0), pts.max(0)
    t = np.array([-(lo[0] + hi[0]) / 2, -(lo[1] + hi[1]) / 2, -lo[2]])
    importer.normalise(meshes, arm, sug)
    joints = {k: np.array(v) + t for k, v in load_truth(name)["joints"].items()}
    return meshes, joints


def analyse(name):
    meshes, joints = load_normalised(name)
    r = mk.analyse_body_markers(meshes)
    return meshes, joints, r


def print_table(name, r, joints):
    H = r["H"]
    print("  %s: H = %.4f m" % (name, H))
    for n in mk.BODY_MARKERS:
        e = np.linalg.norm(np.array(r["markers"][n]["p"]) - joints[n])
        print("    %-11s err %6.2f cm (%4.2f %% H)  conf %.2f" % (n, e * 100, 100 * e / H,
                                                                  r["markers"][n]["confidence"]))
    print("    theta L/R: %s" % ", ".join("%.1f" % t for t in r["theta"].values() if t is not None))
    for w in r["warnings"]:
        print("    warning: %s" % w)


def check_fixture(name):
    _meshes, joints, r = analyse(name)
    print_table(name, r, joints)
    H = r["H"]
    assert set(r["markers"]) == set(mk.BODY_MARKERS), set(mk.BODY_MARKERS) ^ set(r["markers"])
    bad, low = [], []
    for n in mk.BODY_MARKERS:
        m = r["markers"][n]
        assert m["source"] == "auto" and len(m["p"]) == 3
        err = np.linalg.norm(np.array(m["p"]) - joints[n])
        tol = 0.03 if n in ("pelvis", "chest", "neck", "head", "head_top") else 0.02
        if err > tol * H:
            bad.append("%s: %.2f cm" % (n, err * 100))
        if m["confidence"] < 0.6:
            low.append("%s: %.2f" % (n, m["confidence"]))
    assert not bad, "markers beyond tolerance (limbs 2 %%, torso 3 %% of H) on %s: %s" % (name, bad)
    assert not low, "confidence below 0.6 on %s: %s" % (name, low)
    return r


def test_markers_apose():
    r = check_fixture("apose")
    for s in "LR":
        assert 40.0 < r["theta"][s] < 60.0, r["theta"]


def test_markers_tpose():
    r = check_fixture("tpose")
    for s in "LR":
        assert r["theta"][s] < 10.0, r["theta"]


def test_markers_skirt():
    check_fixture("skirt")


def test_markers_mitten():
    check_fixture("mitten")


def test_markers_yup_cm():
    check_fixture("yup_cm")


def test_markers_job_end_to_end():
    with tempfile.TemporaryDirectory() as proj:
        os.makedirs(os.path.join(proj, "source"))
        shutil.copy(fx("apose"), os.path.join(proj, "source", "apose.fbx"))
        res = None
        for typ, args in (("import", {"file": "source/apose.fbx"}), ("suggest_markers", {})):
            jp = os.path.join(proj, "job_%s.json" % typ)
            with open(jp, "w", encoding="utf-8") as f:
                json.dump({"schema": "mpm.job/1", "id": "t-" + typ, "type": typ, "project_dir": proj,
                           "args": args}, f)
            cmd = [bpy.app.binary_path, "-b", "--factory-startup", "--python-exit-code", "1", "-P",
                   os.path.join(REPO, "engine", "jobs", typ + ".py"), "--", jp]
            p = subprocess.run(cmd, capture_output=True, text=True, timeout=900)
            assert p.returncode == 0, (typ, p.returncode, p.stderr[-2000:], p.stdout[-1000:])
            res = [ln for ln in p.stdout.splitlines() if ln.startswith("@@result ")]
            assert len(res) == 1, p.stdout[-1000:]
        out = json.loads(res[0].split(" ", 1)[1])
        assert "markers" in out and isinstance(out["warnings"], list)
        with open(os.path.join(proj, "rig", "markers.json"), "r", encoding="utf-8") as f:
            doc = json.load(f)
        assert doc["schema"] == "mpm.markers/1"
        assert set(mk.BODY_MARKERS) <= set(doc["markers"])
        for n, m in doc["markers"].items():
            assert set(m) == {"p", "confidence", "source"}, (n, m)
            assert len(m["p"]) == 3 and all(isinstance(x, float) for x in m["p"]), (n, m)
            assert 0.0 <= m["confidence"] <= 1.0 and m["source"] == "auto", (n, m)
        if "finger markers not available" in out["warnings"]:
            assert not any(k.startswith(("index_", "thumb_")) for k in doc["markers"])


def test_markers_robust_without_arms():
    import bmesh
    meshes, _joints = load_normalised("apose")
    base, _w = mk.suggest_body_markers(meshes)
    for o in meshes:
        bm = bmesh.new()
        bm.from_mesh(o.data)
        bmesh.ops.delete(bm, geom=[v for v in bm.verts if abs(v.co.x) > 0.25], context='VERTS')
        bm.to_mesh(o.data)
        bm.free()
    markers, warnings = mk.suggest_body_markers(meshes)  # must not raise
    assert set(markers) == set(mk.BODY_MARKERS)
    for n in mk.BODY_MARKERS:
        if n.startswith(("wrist", "elbow")):
            assert markers[n]["confidence"] == 0.2, (n, markers[n])
        if markers[n]["confidence"] == 0.2:
            assert any(n in w for w in warnings), (n, warnings)
    assert warnings
    print("  fallbacks: %s" % [n for n in mk.BODY_MARKERS if markers[n]["confidence"] == 0.2])
    H = max(m["p"][2] for m in markers.values())
    for n in ("hip_L", "knee_R", "ankle_L", "toe_R"):  # deleting the arms must not move the leg markers
        assert np.linalg.norm(np.array(markers[n]["p"]) - np.array(base[n]["p"])) < 0.02 * H, n
