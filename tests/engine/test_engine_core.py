# SPDX-License-Identifier: GPL-3.0-or-later
"""Acceptance tests for WP3 (docs/briefs/WP3-engine-core.md): protocol, import/normalise, detail, printable."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

import numpy as np

import bpy

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(REPO, "engine"))
from mpm import detail, importer, printable, protocol, stlcheck  # noqa: E402


def fx_dir():
    return os.environ.get("MPM_FIXTURES") or os.path.join(REPO, "fixtures", "out")


def fx(name, ext=".fbx"):
    return os.path.join(fx_dir(), name, name + ext)


def truth(name):
    with open(fx(name, ".truth.json"), "r", encoding="utf-8") as f:
        return json.load(f)


def fresh():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def load(name, ext=".fbx", normalise=True):
    """Import a fixture; returns (meshes, armature, suggested, warnings)."""
    fresh()
    new = importer.import_model(fx(name, ext))
    meshes, arm, warnings = importer.select_objects(new)
    sug = importer.suggest_orientation(meshes)
    if normalise:
        warnings += importer.normalise(meshes, arm, sug)
    return meshes, arm, sug, warnings


def bbox(meshes):
    pts = importer._all_world_verts(meshes)
    return pts.min(0), pts.max(0)


def h_ref():
    fresh()
    new = importer.import_model(fx("apose"))
    meshes = [o for o in new if o.type == "MESH"]
    lo, hi = bbox(meshes)
    return float(hi[2] - lo[2])


def run_job(job_path, project_dir):
    job_script = os.path.join(REPO, "engine", "jobs", "import.py")
    cmd = [bpy.app.binary_path, "-b", "--factory-startup", "--python-exit-code", "1", "-P", job_script,
           "--", job_path]
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    lines = p.stdout.splitlines()
    return p.returncode, lines, p.stderr


def tagged(lines, tag):
    return [ln for ln in lines if ln.startswith("@@" + tag + " ")]


# ---- 1. protocol -----------------------------------------------------------------------------------
def test_protocol_end_to_end():
    with tempfile.TemporaryDirectory() as proj:
        os.makedirs(os.path.join(proj, "source"))
        shutil.copy(fx("apose"), os.path.join(proj, "source", "apose.fbx"))
        job = {"schema": "mpm.job/1", "id": "t-1", "type": "import", "project_dir": proj,
               "args": {"file": "source/apose.fbx"}}
        jp = os.path.join(proj, "job.json")
        with open(jp, "w", encoding="utf-8") as f:
            json.dump(job, f)
        code, lines, err = run_job(jp, proj)
        assert code == 0, (code, err[-2000:], lines[-10:])
        assert len(tagged(lines, "progress")) >= 1
        assert len(tagged(lines, "result")) == 1, lines
        assert not tagged(lines, "error")
        assert all(ln.isascii() for ln in tagged(lines, "result"))
        res = json.loads(tagged(lines, "result")[0].split(" ", 1)[1])
        assert res["has_armature"] is False and res["tri_count"] > 0 and "orientation_used" in res
        assert os.path.isfile(os.path.join(proj, "rig", "scene.blend"))

        job["schema"] = "mpm.job/0"
        with open(jp, "w", encoding="utf-8") as f:
            json.dump(job, f)
        code, lines, err = run_job(jp, proj)
        assert code == 1, code
        errs = tagged(lines, "error")
        assert len(errs) == 1 and not tagged(lines, "result"), lines
        assert json.loads(errs[0].split(" ", 1)[1])["code"] == "E_ARGS"


def test_protocol_helpers():
    try:
        protocol.MpmError("E_NOPE", "x")
    except AssertionError:
        pass
    else:
        raise AssertionError("unknown error code accepted")
    e = protocol.MpmError("E_BUDGET", "m", {"a": 1})
    assert e.code == "E_BUDGET" and e.detail == {"a": 1}


# ---- 2. import / normalise -------------------------------------------------------------------------
def test_import_apose():
    href = h_ref()
    print("  H_ref = %.4f" % href)
    meshes, arm, sug, _w = load("apose")
    assert sug["forward"] == "-Y" and sug["up"] == "Z" and sug["unit_scale"] == 1.0, sug
    lo, hi = bbox(meshes)
    assert abs((hi[2] - lo[2]) - href) < 0.005, (hi[2] - lo[2], href)
    assert abs(lo[2]) < 1e-5 and abs((lo[0] + hi[0]) / 2) < 1e-5 and abs((lo[1] + hi[1]) / 2) < 1e-5
    for o in meshes:
        assert importer._identity_error(o) < 1e-6
    info = importer.inspect(meshes, arm, suggested_orientation=sug)
    assert info["has_armature"] is False and info["proxy"] is False
    assert abs(info["height_m"] - href) < 0.005


def test_import_yup_cm_matches_apose():
    href = h_ref()
    m_a, _a, _s, _w = load("apose")
    lo_a, hi_a = bbox(m_a)
    m_y, _a2, sug, _w = load("yup_cm")
    assert sug["unit_scale"] == 0.01, sug
    lo_y, hi_y = bbox(m_y)
    assert abs((hi_y[2] - lo_y[2]) - href) < 0.005, (hi_y[2] - lo_y[2], href)
    assert np.abs(lo_y - lo_a).max() < 0.005 and np.abs(hi_y - hi_a).max() < 0.005, (lo_y, lo_a, hi_y, hi_a)


def test_import_rigged_mixamo():
    meshes, arm, sug, _w = load("rigged_mixamo")
    info = importer.inspect(meshes, arm, suggested_orientation=sug)
    assert info["has_armature"]
    assert importer._identity_error(arm) < 1e-6
    n_truth = len(truth("rigged_mixamo")["mapping"])
    assert len(info["armature_bones"]) == n_truth, (len(info["armature_bones"]), n_truth)
    assert len(meshes) == 1
    assert any(m.type == "ARMATURE" and m.object == arm for m in meshes[0].modifiers)
    assert meshes[0].parent is None
    lo, hi = bbox(meshes)
    assert abs(lo[2]) < 1e-5
    # the armature must sit on the mesh: the head bone is near the top of the mesh
    ztop = max(b["head"][2] for b in info["armature_bones"])
    assert abs(ztop - hi[2]) < 0.15, (ztop, hi[2])


def test_import_glb_obj_heights():
    m_a, _a, _s, _w = load("apose")
    lo, hi = bbox(m_a)
    h = hi[2] - lo[2]
    for ext in (".glb", ".obj"):
        m, _arm, sug, _w = load("apose", ext)
        l2, h2 = bbox(m)
        assert abs((h2[2] - l2[2]) - h) < 0.005, (ext, h2[2] - l2[2], h, sug)


def test_import_dense_proxy():
    p = fx("dense")
    if not os.path.isfile(p):
        raise unittest.SkipTest("dense.fbx not present")
    meshes, arm, sug, w = load("dense")
    made = importer.make_proxy(meshes)
    assert made is True
    proxies = [o for o in bpy.data.objects if "mpm_proxy_of" in o]
    assert len(proxies) == len(meshes)
    total = 0
    for pr in proxies:
        assert pr.hide_viewport and pr.name.endswith("__proxy")
        total += importer._tri_count(pr.data)
        src = bpy.data.objects[pr["mpm_proxy_of"]]
        if src.data.uv_layers.active is not None:
            assert pr.data.uv_layers.active is not None
    print("  proxy triangles: %d" % total)
    assert total <= 300_000, total
    info = importer.inspect(meshes, arm, suggested_orientation=sug, proxy=made)
    assert info["proxy"] is True and info["tri_count"] > 300_000


def test_import_skirt_multiple_objects():
    meshes, _arm, sug, _w = load("skirt")
    info = importer.inspect(meshes, None, suggested_orientation=sug)
    assert len(info["objects"]) > 1, info["objects"]


def test_import_errors():
    fresh()
    for bad, code in (("x.abc", "E_IMPORT_FAILED"), ("missing.fbx", "E_IMPORT_FAILED")):
        try:
            importer.import_model(os.path.join(tempfile.gettempdir(), bad))
        except protocol.MpmError as e:
            assert e.code == code
        else:
            raise AssertionError("no error for " + bad)


# ---- 3. normal map discovery -----------------------------------------------------------------------
def test_normal_map_discovery():
    meshes, _arm, _s, _w = load("apose", normalise=False)
    found = detail.find_normal_maps(meshes[0])
    assert len(found) == 1, found
    assert found[0]["space"] == "TANGENT"
    img = found[0]["image"]
    assert tuple(img.size) == (1024, 1024), tuple(img.size)
    info = importer.inspect(meshes, None)
    assert len(info["normal_maps"]) == 1 and info["normal_maps"][0]["size"] == [1024, 1024]


# ---- 4. detail ---------------------------------------------------------------------------------------
def test_detail_height_from_normal():
    meshes, _arm, _s, _w = load("apose")
    found = detail.find_normal_maps(meshes[0])
    assert len(found) == 1
    nrm = detail.image_rgb(found[0]["image"])
    assert nrm.shape == (1024, 1024, 3) and nrm.dtype == np.float32
    mask = detail.raster_mask(detail.uv_triangles(meshes[0].data), 1024, 1024)
    hgt, info = detail.height_from_normal(nrm, mask)
    assert info["green"].startswith("DirectX"), info
    truth_h = np.load(fx("apose", "_height.npy")).astype(np.float64)[::-1]  # file row 0 = top; ours = +V first
    a = hgt.astype(np.float64)[mask]
    b = truth_h[mask]
    a = a - a.mean()
    b = b - b.mean()
    r = float(np.dot(a, b) / np.sqrt(np.dot(a, a) * np.dot(b, b)))
    print("  detail correlation r = %.4f (%s, curl ratio %s)" % (r, info["green"], info["curl_ratio"]))
    assert r > 0.9, r


# ---- 5. printable ------------------------------------------------------------------------------------
def test_printable_apose():
    meshes, _arm, _s, _w = load("apose")
    with tempfile.TemporaryDirectory() as d:
        out = os.path.join(d, "apose.stl")
        ob, rep = printable.make_printable(meshes, printable.Settings(height=40, flatten=0.5, base_diameter=0), out)
        chk = stlcheck.check(out)
        print("  " + printable.summarize(rep).replace("\n", "\n  "))
        print("  stlcheck: %s" % {k: chk[k] for k in ("tris", "dims", "open_edges", "nonmanifold_edges")})
        assert chk["open_edges"] == 0 and chk["nonmanifold_edges"] == 0, chk
        assert abs(chk["dims"][2] - 40.0) < 0.05, chk["dims"]
        assert "error" not in rep


def test_printable_voxel_budget():
    meshes, _arm, _s, _w = load("apose")
    s = printable.Settings(height=40, flatten=0.5, voxel=0.5, base_diameter=0)
    saved = printable.VOXEL_BUDGET
    try:
        with tempfile.TemporaryDirectory() as d:
            out = os.path.join(d, "a.stl")
            _ob, rep = printable.make_printable(meshes, s, out)
            est = rep["voxel_estimate"]
            assert "voxel_coarsened_to" not in rep
            # needs ~1.41x: coarsened and reported
            printable.VOXEL_BUDGET = est // 2
            _ob, rep2 = printable.make_printable(meshes, s, out)
            assert 0.5 < rep2["voxel_coarsened_to"] <= 1.0 + 1e-9, rep2.get("voxel_coarsened_to")
            # needs ~3.2x: refused
            printable.VOXEL_BUDGET = max(1, est // 10)
            try:
                printable.make_printable(meshes, s, out)
            except protocol.MpmError as e:
                assert e.code == "E_BUDGET", e.code
            else:
                raise AssertionError("E_BUDGET not raised")
    finally:
        printable.VOXEL_BUDGET = saved
