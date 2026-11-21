# SPDX-License-Identifier: GPL-3.0-or-later
"""The bake job (contracts sections 12-16) on real character kits (tests/engine/kits.py), plus the pure
budget / repair logic on plain shapes."""
import json
import math
import os
import random
import shutil
import sys
import tempfile

import numpy as np

import bpy
from mathutils import Quaternion, Vector

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(REPO, "engine"))
sys.path.insert(0, os.path.join(REPO, "engine", "jobs"))
import kits  # noqa: E402
from mpm import bake as BK  # noqa: E402
from mpm import pose as PO  # noqa: E402
from mpm import stlcheck  # noqa: E402
from mpm.dump import hips_index  # noqa: E402
from mpm.rig.export import parse_glb_json  # noqa: E402

# An action pose: right arm raised and bent (the weapon hand), left arm out, a striding left leg.
ACTION = {"upper_arm.R": -50.0, "forearm.R": -40.0, "upper_arm.L": 30.0, "thigh.L": -30.0, "shin.L": 25.0}
BAKE = {"scale": {"mode": "height_mm", "height_mm": 40}, "detail": 2.0, "flatten_mm": 0.5}


def _pose(rig, spec=ACTION):
    return {"schema": "mpm.pose/1", "rig_hash": rig["hash"], "root_offset": [0, 0, 0],
            "deltas": kits.local_x_deltas(rig, spec)}


def _weapon_entry(project_dir, name="sword"):
    """Convert the weapon with the real job and return its section 12 entry on the right-hand socket."""
    src = kits.weapon(name)
    d = os.path.join(project_dir, "weapons", name)
    os.makedirs(d, exist_ok=True)
    shutil.copy(src, os.path.join(d, os.path.basename(src)))
    res = kits.ok(*kits.run_job(project_dir, "convert_weapon", {"file": "weapons/%s/%s" % (name, os.path.basename(src))}))
    lo, hi = np.array(res["bbox_m"][0]), np.array(res["bbox_m"][1])
    c = (lo + hi) / 2
    return {"id": name, "file": res["weapon_glb"], "attach_bone": "grip.R",
            "offset": {"t": [float(-c[0]), float(-c[1]), float(-c[2])], "q": [1, 0, 0, 0], "s": 1.0}, "merge": True}


def _sealed(path):
    chk = stlcheck.check(path)
    assert chk["open_edges"] == 0 and chk["nonmanifold_edges"] == 0, chk
    return chk


# ---------------------------------------------------------------------------------------------------
# pure logic (no model)

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
    name = kits.need()[0]
    pr = kits.scratch_copy(name, "rig")
    w = _weapon_entry(pr.dir)
    arm, _meshes, rig = kits.open_rig(name)
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
    w["offset"] = {"t": [0.01, -0.02, 0.005], "q": list(Quaternion((0.3, 0.2, 0.9), 0.7)), "s": 1.25}
    ref = BK.import_weapon(os.path.join(pr.dir, w["file"]))
    (_w, placed), = BK.place_weapons(pr.dir, arm, rig, [w])
    M = BK.attach_frame(arm, rig, "grip.R") @ BK.offset_matrix(w["offset"])
    worst = 0.0
    for r, p in zip(ref, placed):
        for a, b in zip(r.data.vertices, p.data.vertices):
            worst = max(worst, ((M @ a.co) - b.co).length)
    assert worst < 1e-6, worst
    try:
        BK.place_weapons(pr.dir, arm, rig, [dict(w, file="../outside.glb")])
    except Exception as e:  # noqa: BLE001
        assert getattr(e, "code", None) == "E_ARGS", e
    else:
        raise AssertionError("a weapon outside the project was accepted")


def test_bake_job_with_a_weapon():
    """The whole bake on a real kit: posed, a sword in the right hand, merged and separate."""
    name = kits.need(hard=False)[0]
    pr = kits.scratch_copy(name, "rig")
    rig = pr.rig
    pose, sword = _pose(rig), _weapon_entry(pr.dir)
    r = kits.ok(*kits.run_job(pr.dir, "bake", {"name": "hero", "pose": pose, "weapons": [sword], "bake": BAKE}))
    print("  %s: bake %.1f s: %s" % (name, r["seconds"], r["report"]["summary"].replace("\n", "\n  ")))
    assert r["stl"] == "exports/hero.stl" and r["preview_glb"] == "exports/hero_preview.glb"
    chk = _sealed(os.path.join(pr.dir, r["stl"]))
    assert abs(r["unit_mm"] - 40.0 / rig["height_m"]) < 1e-9
    assert r["gates"]["posed"] and r["gates"]["follow"]["moved_fraction"] >= 0.05
    textured = [m["name"] for m in rig["meshes"] if m["normal_map"]]
    assert textured, "%s has no normal-mapped mesh: the detail bake is not being tested" % name
    for m in textured:   # real kits carry their detail in normal maps: it must be baked into the surface
        assert r["detail"]["levels"][m] >= 1 and m in r["detail"]["displaced_um"], (m, r["detail"])
    assert r["report"]["pieces"] == 1, "the sword should be merged into the figure"
    assert not r["weapons"]
    gj = parse_glb_json(os.path.join(pr.dir, r["preview_glb"]))
    assert sorted(m["name"] for m in gj["materials"]) == ["MP_Printable", "MP_TooThin"], gj["materials"]
    assert os.path.exists(os.path.join(pr.dir, "exports", "report.json"))

    # separate weapon STL
    rs = kits.ok(*kits.run_job(pr.dir, "bake", {"name": "sep", "pose": pose, "weapons": [sword],
                                                "bake": dict(BAKE, weapons_separate=True, detail=0)}))
    assert len(rs["weapons"]) == 1 and rs["weapons"][0]["stl"] == "exports/sep_sword.stl", rs["weapons"]
    cw = _sealed(os.path.join(pr.dir, rs["weapons"][0]["stl"]))
    _sealed(os.path.join(pr.dir, rs["stl"]))
    assert max(cw["dims"]) > 5.0

    # a pose made for another rig is refused before any work
    code, _res, err, p = kits.run_job(pr.dir, "bake", {"pose": dict(pose, rig_hash="0" * 40), "bake": BAKE})
    assert code != 0 and err and err["code"] == "E_ARGS", p.stdout[-1500:]


def test_every_kit_bakes_to_a_sealed_print():
    """Each real kit, posed, at 40 mm: one sealed piece at the standing scale."""
    for name in kits.need():
        pr = kits.scratch_copy(name, "rig")
        rig = pr.rig
        r = kits.ok(*kits.run_job(pr.dir, "bake", {"name": name, "pose": _pose(rig), "bake": BAKE}))
        chk = _sealed(os.path.join(pr.dir, r["stl"]))
        rep = r["report"]
        print("  %s: %.1f x %.1f x %.1f mm, %d triangles, %d piece(s), thin walls %.1f %% -> %.1f %%, %d sheets, %.0f s" % (
            name, chk["dims"][0], chk["dims"][1], chk["dims"][2], chk["tris"], rep["pieces"],
            rep["thin_area_pct_before"], rep["thin_area_pct"], rep["sheets"], r["seconds"]))
        # thin-wall thickening is on by default: fingers and blades must come out printable
        assert rep["thickened_verts"] > 0 and rep["thin_area_pct"] < 0.35 * rep["thin_area_pct_before"] + 0.5, (
            name, rep["thin_area_pct_before"], rep["thin_area_pct"])
        assert rep["thin_area_pct"] < 2.0, "%s: %.1f %% of the surface is still under the minimum wall" % (
            name, rep["thin_area_pct"])
        assert 28.0 < chk["dims"][2] <= 40.0 + 0.7, (name, chk["dims"])   # standing scale: a stride is lower
        assert rep["pieces"] == 1, "%s: %d separate pieces" % (name, rep["pieces"])
        assert chk["volume"] > 0


def test_thickening_can_be_turned_off():
    name = kits.need(hard=False)[0]
    pr = kits.scratch_copy(name, "rig")
    r = kits.ok(*kits.run_job(pr.dir, "bake", {"name": "thin", "pose": _pose(pr.rig),
                                               "bake": dict(BAKE, detail=0, thicken_thin=False)}))
    rep = r["report"]
    assert rep["thickened_verts"] == 0 and "thin_area_pct_before" not in rep, rep
    _sealed(os.path.join(pr.dir, r["stl"]))


def test_bake_dense_uses_full_detail_mesh():
    """A model over the proxy limit is rigged on the proxy; the bake must pose and print the original."""
    name = kits.need(hard=False)[0]
    pr = kits.project_from_model(kits.dense_model(name), "rig", label="dense")
    with open(os.path.join(pr.dir, "rig", "rig.json"), encoding="utf-8") as fh:
        rig = json.load(fh)
    assert pr.results["import"]["proxy"] is True and pr.results["import"]["tri_count"] > 300_000
    assert all(m["name"].endswith("__proxy") for m in rig["meshes"]), rig["meshes"]
    bake = {"scale": {"mode": "height_mm", "height_mm": 40}, "detail": 0, "max_tris": 1_000_000}
    r = kits.ok(*kits.run_job(pr.dir, "bake", {"name": "dense", "pose": _pose(rig), "bake": bake}))
    print("  dense %s: bake %.1f s, transferred %s, follow %s, source tris %d" % (
        name, r["seconds"], r["weights_transferred"], r["gates"]["follow"], r["report"]["source_tris"]))
    assert r["weights_transferred"] and not any(n.endswith("__proxy") for n in r["weights_transferred"])
    assert r["report"]["source_tris"] > 300_000, r["report"]["source_tris"]
    chk = _sealed(os.path.join(pr.dir, r["stl"]))
    assert 28.0 < chk["dims"][2] <= 40.0 + 0.7, chk["dims"]   # thickened thin tips may add a little
