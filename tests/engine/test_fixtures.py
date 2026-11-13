# SPDX-License-Identifier: GPL-3.0-or-later
"""Acceptance tests for the WP2 fixtures (docs/briefs/WP2-fixtures.md)."""
import json
import os
import struct
import sys
import tempfile
import zlib

import numpy as np

import bpy
import bmesh
from mathutils import Vector
from mathutils.bvhtree import BVHTree

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(REPO, "engine"))
from mpm import stlcheck  # noqa: E402

HUMANOIDS = ["apose", "tpose", "yup_cm", "mitten", "curled", "skirt", "dense",
             "rigged_mixamo", "rigged_ue", "rigged_biped"]
TEXTURED = [n for n in HUMANOIDS if n != "dense"]
RIGGED = ["rigged_mixamo", "rigged_ue", "rigged_biped"]
WEAPONS = ["sword", "rifle"]
FILES = {"apose": [".fbx", ".glb", ".obj", ".mtl"], "tpose": [".fbx"], "yup_cm": [".fbx"], "mitten": [".fbx"],
         "curled": [".fbx"], "skirt": [".fbx"], "dense": [".fbx"], "rigged_mixamo": [".fbx"],
         "rigged_ue": [".fbx"], "rigged_biped": [".fbx"], "sword": [".glb", ".fbx"], "rifle": [".glb", ".fbx"]}


def fx_dir():
    return os.environ.get("MPM_FIXTURES") or os.path.join(REPO, "fixtures", "out")


def path(name, suffix):
    return os.path.join(fx_dir(), name, name + suffix)


def truth(name):
    with open(path(name, ".truth.json"), "r", encoding="utf-8") as f:
        return json.load(f)


def expand_bones():
    with open(os.path.join(REPO, "resources", "skeleton.json"), "r", encoding="utf-8") as f:
        sk = json.load(f)
    out = []
    for b in sk["bones"]:
        if "{S}" in b["name"] or "{s}" in b["name"]:
            for sd in sk["sides"]:
                out.append({k: (v if not isinstance(v, str) else v.replace("{S}", sd["S"]).replace("{s}", sd["s"]))
                            for k, v in b.items()})
        else:
            out.append(b)
    return out


def import_fbx(name, **kw):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.fbx(filepath=path(name, ".fbx"), **kw)
    return [o for o in bpy.data.objects if o not in before]


def world_mesh(obj):
    mw = obj.matrix_world
    verts = [tuple(mw @ v.co) for v in obj.data.vertices]
    polys = [tuple(p.vertices) for p in obj.data.polygons]
    return verts, polys


def count_bad_edges(obj):
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bad = sum(1 for e in bm.edges if len(e.link_faces) != 2)
    bm.free()
    return bad


# ------------------------------------------------------------------------------------------------
def test_fixture_files_exist():
    for n in HUMANOIDS + WEAPONS:
        assert os.path.isfile(path(n, ".truth.json")), "missing truth for " + n
        for suf in FILES[n]:
            assert os.path.isfile(path(n, suf)), "missing %s%s" % (n, suf)
        if n in TEXTURED:
            for suf in ("_n.png", "_d.png", "_height.npy"):
                assert os.path.isfile(path(n, suf)), "missing %s%s" % (n, suf)


def test_truth_joints_and_skeleton():
    for n in HUMANOIDS:
        t = truth(n)
        assert t["schema"] == "mpm.fixture/1" and t["name"] == n
        assert len(t["joints"]) == 68, (n, len(t["joints"]))
        for b in expand_bones():
            assert b["head"] in t["joints"] and b["tail"] in t["joints"], (n, b["name"])
        for e in t["editable"]:
            assert e in t["joints"]
        assert set(t["hands"]) == {"L", "R"}
        assert t["normal_convention"] == "directx"
    for n in WEAPONS:
        t = truth(n)
        assert set(t["grips"]) == {"main", "support"}
        for g in t["grips"].values():
            assert set(g) == {"point", "axis", "palm_normal"}
            assert abs(np.dot(g["axis"], g["palm_normal"])) < 1e-9


def test_truth_values_follow_the_brief_and_contracts():
    t = truth("apose")
    J = {k: np.array(v) for k, v in t["joints"].items()}
    th = np.radians(50.0)
    a = np.array([np.cos(th), 0, -np.sin(th)])
    lat = np.array([0, -1.0, 0])
    assert np.allclose(J["pelvis"], [0, 0, 0.95]) and np.allclose(J["head_top"], [0, 0.02, 1.80])
    assert np.allclose(J["elbow_L"], J["shoulder_L"] + 0.30 * a)
    assert np.allclose(J["wrist_L"], J["elbow_L"] + 0.26 * a)
    assert np.allclose(J["pinky_0_L"], J["wrist_L"] + 0.075 * a - 0.040 * lat)
    for k, v in J.items():  # R is the mirror of L
        if k.endswith("_L"):
            r = J[k[:-2] + "_R"]
            assert np.allclose(r, [-v[0], v[1], v[2]], atol=1e-9), k
    # contracts section 4 derived joints
    assert np.allclose(J["spine0"], J["pelvis"] + 0.30 * (J["chest"] - J["pelvis"]))
    assert np.allclose(J["index_1_L"], J["index_0_L"] + 0.45 * (J["index_tip_L"] - J["index_0_L"]))
    assert np.allclose(J["thumb_2_R"], J["thumb_0_R"] + 0.73 * (J["thumb_tip_R"] - J["thumb_0_R"]))
    an, to = J["ankle_L"], J["toe_L"]
    ball = an + 0.68 * (to - an)
    ball[2] = 0.35 * an[2] + 0.65 * to[2]
    assert np.allclose(J["ball_L"], ball)
    sh = J["shoulder_R"]
    clav = [-0.18 * abs(sh[0]), J["neck"][1], J["neck"][2] - 0.25 * (J["neck"][2] - sh[2])]
    assert np.allclose(J["clav_R"], clav)
    h = t["hands"]["L"]
    centre = np.mean([J[x + "_L"] for x in ("index_0", "middle_0", "ring_0", "pinky_0", "wrist")], axis=0)
    grip = centre + np.array(h["palm_normal"]) * 0.35 * h["hand_width"]
    assert np.allclose(J["grip_L"], grip)
    assert abs(np.linalg.norm(J["grip_tip_L"] - J["grip_L"]) - 0.10) < 1e-9
    # curled fingers really are curled: the tip is much closer to its root than in the straight hand
    c = {k: np.array(v) for k, v in truth("curled")["joints"].items()}
    assert np.linalg.norm(c["index_tip_L"] - c["index_0_L"]) < 0.75 * np.linalg.norm(J["index_tip_L"] - J["index_0_L"])
    assert np.allclose(c["index_0_L"], J["index_0_L"])


def test_palm_normal_signs():
    a = truth("apose")["hands"]
    assert a["L"]["palm_normal"][0] < 0 and a["R"]["palm_normal"][0] > 0, a
    tp = truth("tpose")["hands"]
    assert tp["L"]["palm_normal"][2] < 0 and tp["R"]["palm_normal"][2] < 0, tp


def test_apose_reimport_single_manifold_mesh():
    objs = import_fbx("apose", automatic_bone_orientation=False)
    meshes = [o for o in objs if o.type == "MESH"]
    assert len(meshes) == 1, [o.name for o in objs]
    assert count_bad_edges(meshes[0]) == 0
    assert len(meshes[0].data.materials) == 1


def test_apose_glb_has_material_with_normal_map():
    with open(path("apose", ".glb"), "rb") as f:
        b = f.read()
    ln = struct.unpack("<I", b[12:16])[0]
    j = json.loads(b[20:20 + ln])
    assert len(j["materials"]) == 1 and "normalTexture" in j["materials"][0], j.get("materials")
    assert "TEXCOORD_0" in j["meshes"][0]["primitives"][0]["attributes"]
    assert "material" in j["meshes"][0]["primitives"][0]


def ray_parity(bvh, origin, direction):
    d = Vector(direction)
    o = Vector(origin)
    hits = 0
    for _ in range(64):
        loc, _n, _idx, _dist = bvh.ray_cast(o, d)
        if loc is None:
            break
        hits += 1
        o = loc + d * 1e-5
    return hits


def test_apose_editable_joints_inside_mesh():
    objs = import_fbx("apose", automatic_bone_orientation=False)
    mesh = [o for o in objs if o.type == "MESH"][0]
    verts, polys = world_mesh(mesh)
    bvh = BVHTree.FromPolygons(verts, polys)
    t = truth("apose")
    fallbacks = []
    failed = []
    for j in t["editable"]:
        p = Vector(t["joints"][j])
        for dname, d in (("+X", (1, 0, 0)), ("-X", (-1, 0, 0)), ("+Z", (0, 0, 1))):
            if ray_parity(bvh, p, d) % 2 == 1:
                continue
            # a ray that runs exactly along a mesh edge/vertex can miscount: retry with a 1e-5 m offset
            q = p + (Vector((0.0, 1.3e-5, 0.0)) if dname != "+Z" else Vector((1.3e-5, 1.7e-5, 0.0)))
            if ray_parity(bvh, q, d) % 2 == 1:
                fallbacks.append((j, dname))
            else:
                failed.append((j, dname))
    print("  inside-mesh test: %d editable joints x 3 rays, %d needed the 1e-5 m offset retry"
          % (len(t["editable"]), len(fallbacks)))
    assert not failed, "joints not inside the mesh (even ray parity): %s" % failed


def test_yup_cm_import_height():
    t = truth("yup_cm")
    assert t["export"] == {"up": "Y", "forward": "-Z", "unit_scale": 0.01}
    objs = import_fbx("yup_cm")
    meshes = [o for o in objs if o.type == "MESH"]
    assert len(meshes) == 1
    verts, _ = world_mesh(meshes[0])
    a = np.array(verts)
    ext = a.max(0) - a.min(0)
    m = meshes[0]
    print("  yup_cm observed after default import: world bbox min=%s max=%s extents=%s; object scale=%s rot=%s" %
          (a.min(0).round(3).tolist(), a.max(0).round(3).tolist(), ext.round(3).tolist(),
           tuple(round(x, 4) for x in m.scale), tuple(round(x, 4) for x in m.rotation_euler)))
    # Observed: the importer converts the axes (Z is the height) but NOT the unit: the file stores
    # Lcl Scaling 100 (global_scale) and the default import keeps it, so the height is 1.80 / 0.01 = 180
    # Blender units, not 1.80 m. The test asserts the height in file units (metres / unit_scale).
    assert abs(ext[2] * t["export"]["unit_scale"] - 1.80) < 0.05, "height along Z after import = %.4f" % ext[2]


# ---- textures -------------------------------------------------------------------------------------
def read_png_rgb(p):
    with open(p, "rb") as f:
        data = f.read()
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    pos, idat, w, h = 8, b"", None, None
    while pos < len(data):
        ln = struct.unpack(">I", data[pos:pos + 4])[0]
        typ = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + ln]
        pos += 12 + ln
        if typ == b"IHDR":
            w, h, depth, ctype = struct.unpack(">IIBB", body[:10])
            assert depth == 8 and ctype == 2
        elif typ == b"IDAT":
            idat += body
    raw = zlib.decompress(idat)
    stride = w * 3
    out = np.zeros((h, stride), dtype=np.uint8)
    prev = np.zeros(stride, dtype=np.int32)
    for y in range(h):
        row = raw[y * (stride + 1):(y + 1) * (stride + 1)]
        ft = row[0]
        cur = np.frombuffer(row[1:], dtype=np.uint8).astype(np.int32)
        if ft == 2:
            cur = (cur + prev) & 255
        elif ft == 1:
            for i in range(3, stride):
                cur[i] = (cur[i] + cur[i - 3]) & 255
        elif ft != 0:
            raise AssertionError("unsupported PNG filter %d" % ft)
        out[y] = cur
        prev = cur
    return out.reshape(h, w, 3)


def test_normal_map_round_trip():
    for n in TEXTURED:
        H = np.load(path(n, "_height.npy")).astype(np.float64)
        assert H.shape == (1024, 1024)
        k = 2.0
        du = np.gradient(H, axis=1)
        dv = -np.gradient(H, axis=0)  # v points up, image row 0 is the top
        nv = np.stack([-k * du, -k * dv, np.ones_like(H)], axis=-1)
        nv /= np.linalg.norm(nv, axis=-1, keepdims=True)
        nv[..., 1] *= -1.0  # DirectX: green flipped
        png = read_png_rgb(path(n, "_n.png")).astype(np.float64) / 255.0
        dec = png * 2.0 - 1.0
        err = np.abs((nv * 0.5 + 0.5) - png).mean() * 255.0
        assert err < 2.0, "%s: mean abs error %.3f/255" % (n, err)
        assert np.abs(np.linalg.norm(dec, axis=-1) - 1).mean() < 0.01
        assert truth(n)["normal_convention"] == "directx"
        d = read_png_rgb(path(n, "_d.png"))
        assert d.min() == d.max() == round(0.6 * 255)
    print("  normal map round trip ok for %d fixtures" % len(TEXTURED))


def test_height_field_is_deterministic():
    a = np.load(path("apose", "_height.npy"))
    b = np.load(path("rigged_ue", "_height.npy"))
    assert np.array_equal(a, b)
    assert a.min() == -1.0 and a.max() > 0.99


# ---- stlcheck -------------------------------------------------------------------------------------
def write_cube_stl(p, drop_face=False):
    v = np.array([[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], float)
    quads = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]  # outward
    tris = []
    for q in quads:
        tris += [(q[0], q[1], q[2]), (q[0], q[2], q[3])]
    if drop_face:
        tris = tris[2:]
    with open(p, "wb") as f:
        f.write(b"\0" * 80)
        f.write(struct.pack("<I", len(tris)))
        for t in tris:
            a, b, c = v[t[0]], v[t[1]], v[t[2]]
            n = np.cross(b - a, c - a)
            n = n / np.linalg.norm(n)
            f.write(struct.pack("<12fH", *n, *a, *b, *c, 0))


def test_stlcheck_cube():
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "cube.stl")
        write_cube_stl(p)
        r = stlcheck.check(p)
        assert r["tris"] == 12 and r["open_edges"] == 0 and r["nonmanifold_edges"] == 0, r
        assert abs(r["volume"] - 1.0) < 1e-9, r
        assert np.allclose(r["dims"], [1, 1, 1]) and r["floor_z"] == 0.0
        # the bottom face (2 tris, normal -z, z=0 < floor+0.1) is contact; centroids x>=0 -> L only
        assert abs(r["sole_contact"]["L"] - 1.0) < 1e-9 and r["sole_contact"]["R"] == 0.0, r
        p2 = os.path.join(d, "open.stl")
        write_cube_stl(p2, drop_face=True)
        r2 = stlcheck.check(p2)
        assert r2["tris"] == 10 and r2["open_edges"] == 4, r2


# ---- variants ---------------------------------------------------------------------------------------
def test_skirt_has_three_separate_objects():
    objs = [o for o in import_fbx("skirt") if o.type == "MESH"]
    assert len(objs) == 3, [o.name for o in objs]
    open_objs = [o for o in objs if count_bad_edges(o) > 0]
    assert len(open_objs) == 2, "cone sheet and back flap must be open, body closed"


def test_dense_triangle_count():
    objs = [o for o in import_fbx("dense") if o.type == "MESH"]
    assert len(objs) == 1
    objs[0].data.calc_loop_triangles()
    n = len(objs[0].data.loop_triangles)
    print("  dense triangles after import: %d" % n)
    assert 900_000 <= n <= 1_200_000, n


def test_mitten_is_a_paddle():
    full = [o for o in import_fbx("apose") if o.type == "MESH"][0]
    nf = len(full.data.vertices)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    mit = [o for o in import_fbx("mitten") if o.type == "MESH"][0]
    assert count_bad_edges(mit) == 0
    assert len(mit.data.vertices) < nf


def test_weapons_import():
    for n in WEAPONS:
        bpy.ops.wm.read_factory_settings(use_empty=True)
        objs = import_fbx(n)
        meshes = [o for o in objs if o.type == "MESH"]
        assert len(meshes) == 1
        verts = np.array(world_mesh(meshes[0])[0])
        ext = verts.max(0) - verts.min(0)
        print("  %s FBX extents %s" % (n, ext.round(3).tolist()))
        if n == "sword":  # blade toward +Z: grip/pommel -0.11 .. blade tip 0.89
            assert 0.95 < ext[2] < 1.05 and abs(ext[0] - 0.20) < 0.01
        else:  # barrel along +Y
            assert ext[1] > ext[0] and ext[1] > ext[2]


# ---- rigged fixtures --------------------------------------------------------------------------------
def test_rigged_fixtures_reimport():
    skel_bones = {b["name"] for b in expand_bones()}
    for n in RIGGED:
        bpy.ops.wm.read_factory_settings(use_empty=True)
        t = truth(n)
        mapping = t["mapping"]
        for canon in mapping.values():
            assert canon is None or canon in skel_bones, (n, canon)
        assert sum(1 for c in mapping.values() if c is not None) >= 40
        objs = import_fbx(n, automatic_bone_orientation=False)
        arms = [o for o in objs if o.type == "ARMATURE"]
        meshes = [o for o in objs if o.type == "MESH"]
        assert len(arms) == 1 and len(meshes) == 1, (n, [(o.name, o.type) for o in objs])
        names = {b.name for b in arms[0].data.bones}
        missing = [b for b in mapping if b not in names]
        assert not missing, "%s: bones missing after import: %s" % (n, missing)
        mesh = meshes[0]
        zero = sum(1 for v in mesh.data.vertices if sum(g.weight for g in v.groups) <= 0.0)
        assert zero == 0, "%s: %d vertices with zero total weight" % (n, zero)
        print("  %s: %d bones, %d vertices, all weighted" % (n, len(names), len(mesh.data.vertices)))
