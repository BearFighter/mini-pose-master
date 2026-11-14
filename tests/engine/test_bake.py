# SPDX-License-Identifier: GPL-3.0-or-later
"""WP10 acceptance: the bake job (contracts sections 12-16). Uses only the original procedural fixtures."""
import json
import math
import os
import random
import shutil
import sys
import tempfile
import unittest

import bpy
from mathutils import Matrix, Quaternion, Vector

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(REPO, "engine", "jobs"))

from mpm import bake as BK  # noqa: E402
from mpm import pose as PO  # noqa: E402
from mpm import stlcheck  # noqa: E402
from mpm.dump import hips_index  # noqa: E402
from mpm.rig.export import parse_glb_json  # noqa: E402
import rig as RIGJOB  # noqa: E402  (engine/jobs/rig.py)
from test_markers import fx, load_truth  # noqa: E402
from test_rig_build import _run_job, truth_markers  # noqa: E402


def _ok(code, res, errs, p):
    assert code == 0 and len(res) == 1 and not errs, p.stdout[-3000:] + p.stderr[-2000:]
    return json.loads(res[0][len("@@result"):])


def _local_x_deltas(rig, spec):
    """{bone index: [w,x,y,z]} rotating each named bone about its own rest X axis (armature space)."""
    out = {}
    for b in rig["bones"]:
        if b["name"] in spec:
            R = Quaternion(b["rest_q"]).to_matrix()
            q = (R @ Matrix.Rotation(math.radians(spec[b["name"]]), 3, 'X') @ R.transposed()).to_quaternion()
            if q.w < 0:
                q.negate()
            out[str(b["index"])] = [q.w, q.x, q.y, q.z]
    return out


def _project_with_rig(name, tmp):
    """import job + rig job (truth markers) in a fresh project folder, as the app does."""
    src = os.path.join(tmp, "source")
    os.makedirs(src)
    d = os.path.dirname(fx(name))
    for f in os.listdir(d):
        if f == name + ".fbx" or f.endswith(".png"):
            shutil.copy(os.path.join(d, f), os.path.join(src, f))
    _ok(*_run_job(tmp, "import", {"file": "source/%s.fbx" % name}))
    _m, _j, markers = truth_markers(name)
    _ok(*_run_job(tmp, "rig", {"markers": markers}))
    with open(os.path.join(tmp, "rig", "rig.json"), encoding="utf-8") as fh:
        return json.load(fh)


def _add_weapon(tmp, name="sword"):
    os.makedirs(os.path.join(tmp, "weapons"), exist_ok=True)
    shutil.copy(fx(name, ".glb"), os.path.join(tmp, "weapons", name + ".glb"))
    g = load_truth(name)["grips"]["main"]["point"]
    # put the main grip point on the socket origin
    return {"id": name, "file": "weapons/%s.glb" % name, "attach_bone": "grip.R",
            "offset": {"t": [-g[0], -g[1], -g[2]], "q": [1, 0, 0, 0], "s": 1.0}, "merge": True}


# ---------------------------------------------------------------------------------------------------

def test_unit_mm():
    rig = {"height_m": 1.8, "floor_z": 0.0, "joints": {"head": [0, 0, 1.6], "head_top": [0, 0, 1.8]}}
    u, h = BK.unit_mm(rig, {"scale": {"mode": "height_mm", "height_mm": 36}})
    assert abs(u - 20.0) < 1e-9 and abs(h - 36.0) < 1e-9
    u, h = BK.unit_mm(rig, {"scale": {"mode": "heroic", "size_mm": 32}})
    assert abs(u - 32 / 1.68) < 1e-9 and abs(h - 1.8 * 32 / 1.68) < 1e-9
    u, h = BK.unit_mm(rig, {})
    assert abs(h - 40.0) < 1e-9


def test_plan_levels_and_budget():
    bpy.ops.mesh.primitive_cube_add(size=0.1)   # 6 quads, edges 0.1 m
    cube = bpy.context.active_object
    bpy.ops.mesh.primitive_ico_sphere_add(radius=0.05, subdivisions=3)  # 320 triangles
    ico = bpy.context.active_object
    unit = 40 / 1.8
    levels, faces, lowered = BK.plan_levels([cube, ico], unit, {cube.name: True, ico.name: False})
    # 0.1 m * 22.2 mm/m = 2.2 mm edges -> ceil(log2(2.2 / 0.06)) = 6 -> capped at 4; no map -> 0
    assert levels == {cube.name: 4, ico.name: 0} and not lowered, levels
    assert faces == 24 * 4 ** 3 + 320, faces
    assert BK.faces_at(ico.data, 1) == 960 and BK.faces_at(ico.data, 2) == 3840
    saved = BK.FACE_BUDGET
    try:
        BK.FACE_BUDGET = 1000
        levels, faces, lowered = BK.plan_levels([cube, ico], unit, {cube.name: True, ico.name: True})
        assert lowered and faces <= 1000, (levels, faces)
    finally:
        BK.FACE_BUDGET = saved


def test_repair_nonmanifold_edge_contact():
    """Two closed cubes sharing one edge (4 faces on it after welding) come out sealed and manifold."""
    import bmesh
    from mpm import printable
    bm = bmesh.new()
    for c in ((0.5, 0.5, 0.5), (1.5, 1.5, 0.5)):
        r = bmesh.ops.create_cube(bm, size=1.0)
        bmesh.ops.translate(bm, vec=c, verts=r["verts"])
    bmesh.ops.subdivide_edges(bm, edges=bm.edges[:], cuts=6, use_grid_fill=True)
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    me = bpy.data.meshes.new("touch")
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new("touch", me)
    bpy.context.scene.collection.objects.link(ob)
    tmp = tempfile.mkdtemp(prefix="mpm_nm_")
    try:
        before = os.path.join(tmp, "before.stl")
        printable.write_stl(me, before)
        c0 = stlcheck.check(before)
        assert c0["nonmanifold_edges"] > 0, c0
        n = printable._repair_nonmanifold(ob)
        after = os.path.join(tmp, "after.stl")
        printable.write_stl(ob.data, after)
        c1 = stlcheck.check(after)
        print("  repaired %d verts: %s -> %s" % (n, {k: c0[k] for k in ("open_edges", "nonmanifold_edges")},
                                                 {k: c1[k] for k in ("open_edges", "nonmanifold_edges")}))
        assert n > 0 and c1["open_edges"] == 0 and c1["nonmanifold_edges"] == 0, c1
        assert abs(c1["volume"] - 2.0) < 0.1, c1["volume"]
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_attach_frame_and_weapon_placement():
    """Section 12: A = T(posed head) * D_b * R(rest_q) equals pose_bone.matrix; the weapon lands at A*TRS."""
    tmp = tempfile.mkdtemp(prefix="mpm_bake_")
    try:
        _m, _j, markers = truth_markers("apose")
        RIGJOB.build_auto_rig(tmp, markers)
        rig = json.load(open(os.path.join(tmp, "rig", "rig.json"), encoding="utf-8"))
        arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
        rnd = random.Random(7)
        deltas = {}
        for b in rig["bones"]:
            ax = Vector((rnd.uniform(-1, 1), rnd.uniform(-1, 1), rnd.uniform(-1, 1))).normalized()
            q = Quaternion(ax, math.radians(rnd.uniform(0, 35)))
            deltas[str(b["index"])] = [q.w, q.x, q.y, q.z]
        posed = PO.apply_pose_state(arm, deltas, (0.01, 0.02, -0.03), hips_index=hips_index(rig))
        for sock in ("grip.L", "grip.R", "hand.R"):
            b = next(x for x in rig["bones"] if x["canonical"] == sock)
            Db, h = posed[b["index"]]
            A = (Db @ Quaternion(b["rest_q"]).to_matrix()).to_4x4()
            A.translation = h
            got = BK.attach_frame(arm, rig, sock)
            err = max(abs(got[r][c] - A[r][c]) for r in range(4) for c in range(4))
            assert err < 1e-5, (sock, err)
        w = _add_weapon(tmp)
        w["offset"] = {"t": [0.01, -0.02, 0.005], "q": list(Quaternion((0.3, 0.2, 0.9), 0.7)), "s": 1.25}
        ref = BK.import_weapon(os.path.join(tmp, w["file"]))
        (_w, placed), = BK.place_weapons(tmp, arm, rig, [w])
        M = BK.attach_frame(arm, rig, "grip.R") @ BK.offset_matrix(w["offset"])
        worst = 0.0
        for r, p in zip(ref, placed):
            for a, b in zip(r.data.vertices, p.data.vertices):
                worst = max(worst, ((M @ a.co) - b.co).length)
        assert worst < 1e-6, worst
        try:
            BK.place_weapons(tmp, arm, rig, [dict(w, file="../outside.glb")])
        except Exception as e:  # noqa: BLE001
            assert getattr(e, "code", None) == "E_ARGS", e
        else:
            raise AssertionError("a weapon outside the project was accepted")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_bake_job_end_to_end():
    tmp = tempfile.mkdtemp(prefix="mpm_bakejob_")
    try:
        rig = _project_with_rig("apose", tmp)
        deltas = _local_x_deltas(rig, {"upper_arm.R": -50.0, "forearm.R": -40.0, "thigh.L": -30.0,
                                       "upper_arm.L": 30.0})
        pose = {"schema": "mpm.pose/1", "rig_hash": rig["hash"], "root_offset": [0, 0, 0], "deltas": deltas}
        sword = _add_weapon(tmp)
        bake = {"scale": {"mode": "height_mm", "height_mm": 40}, "detail": 2.0, "flatten_mm": 0.5}
        r = _ok(*_run_job(tmp, "bake", {"name": "hero", "pose": pose, "weapons": [sword], "bake": bake}))
        print("  bake %.1f s: %s" % (r["seconds"], r["report"]["summary"].replace("\n", "\n  ")))
        print("  gates %s, detail levels %s, displaced %s" % (r["gates"], r["detail"]["levels"],
                                                               r["detail"]["displaced_um"]))
        assert r["stl"] == "exports/hero.stl" and r["preview_glb"] == "exports/hero_preview.glb"
        chk = stlcheck.check(os.path.join(tmp, r["stl"]))
        print("  stlcheck: %s" % {k: chk[k] for k in ("tris", "dims", "open_edges", "nonmanifold_edges")})
        assert chk["open_edges"] == 0 and chk["nonmanifold_edges"] == 0, chk
        assert abs(r["unit_mm"] - 40.0 / rig["height_m"]) < 1e-9
        assert r["gates"]["posed"] and r["gates"]["follow"]["moved_fraction"] >= 0.05
        # the body has a normal map (subdivided + displaced); the sword fixture has none (level 0)
        assert r["detail"]["levels"]["apose"] >= 1 and r["detail"]["levels"]["sword_weapon"] == 0, r["detail"]
        assert "apose" in r["detail"]["displaced_um"], r["detail"]
        assert r["report"]["pieces"] == 1, "the sword should be merged into the figure"
        assert not r["weapons"]
        gj = parse_glb_json(os.path.join(tmp, r["preview_glb"]))
        assert sorted(m["name"] for m in gj["materials"]) == ["MP_Printable", "MP_TooThin"], gj["materials"]
        assert os.path.exists(os.path.join(tmp, "exports", "report.json"))

        # the same pose without the sword: the merged sword must have added material
        r0 = _ok(*_run_job(tmp, "bake", {"name": "bare", "pose": pose, "weapons": [], "bake": bake}))
        c0 = stlcheck.check(os.path.join(tmp, r0["stl"]))
        assert c0["open_edges"] == 0 and c0["nonmanifold_edges"] == 0, c0
        assert 30.0 < c0["dims"][2] <= 40.0 + 0.05, c0["dims"]   # standing scale: a raised leg prints shorter
        assert chk["tris"] != c0["tris"] or chk["dims"] != c0["dims"]

        # separate weapon STL
        rs = _ok(*_run_job(tmp, "bake", {"name": "sep", "pose": pose, "weapons": [sword],
                                         "bake": dict(bake, weapons_separate=True)}))
        assert len(rs["weapons"]) == 1 and rs["weapons"][0]["stl"] == "exports/sep_sword.stl", rs["weapons"]
        cw = stlcheck.check(os.path.join(tmp, rs["weapons"][0]["stl"]))
        assert cw["open_edges"] == 0 and cw["nonmanifold_edges"] == 0, cw
        print("  separate sword dims %s mm" % cw["dims"])
        assert max(cw["dims"]) > 5.0

        # a pose made for another rig is refused before any work
        code, res, errs, p = _run_job(tmp, "bake", {"pose": dict(pose, rig_hash="0" * 40), "bake": bake})
        assert code != 0 and errs and json.loads(errs[0][len("@@error"):])["code"] == "E_ARGS", p.stdout[-1500:]
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_bake_dense_uses_full_detail_mesh():
    """A model over the proxy limit is rigged on the proxy; the bake must pose and print the original."""
    if not os.path.exists(fx("dense")):
        raise unittest.SkipTest("dense.fbx not present")
    tmp = tempfile.mkdtemp(prefix="mpm_bakedense_")
    try:
        rig = _project_with_rig("dense", tmp)
        assert all(m["name"].endswith("__proxy") for m in rig["meshes"]), rig["meshes"]
        deltas = _local_x_deltas(rig, {"upper_arm.L": 40.0, "thigh.R": -30.0})
        pose = {"schema": "mpm.pose/1", "rig_hash": rig["hash"], "deltas": deltas}
        bake = {"scale": {"mode": "height_mm", "height_mm": 40}, "detail": 0, "max_tris": 1_000_000}
        r = _ok(*_run_job(tmp, "bake", {"name": "dense", "pose": pose, "bake": bake}))
        print("  dense bake %.1f s, transferred %s, follow %s, source tris %d" % (
            r["seconds"], r["weights_transferred"], r["gates"]["follow"], r["report"]["source_tris"]))
        assert r["weights_transferred"] and not any(n.endswith("__proxy") for n in r["weights_transferred"])
        assert r["report"]["source_tris"] > 300_000, r["report"]["source_tris"]
        rep = r["report"]
        assert rep["sheets"] == 0 and rep["closed"] == rep["parts"], "a closed model must stay closed: %s" % rep["summary"]
        chk = stlcheck.check(os.path.join(tmp, r["stl"]))
        print("  stlcheck: %s" % {k: chk[k] for k in ("tris", "dims", "open_edges", "nonmanifold_edges")})
        assert chk["open_edges"] == 0 and chk["nonmanifold_edges"] == 0, chk
        assert 30.0 < chk["dims"][2] <= 40.0 + 0.05, chk["dims"]
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
