# SPDX-License-Identifier: GPL-3.0-or-later
"""Mini Pose Master fixture generator (original procedural characters and weapons).

Run (headless):
  blender -b --factory-startup --python-exit-code 1 -P fixtures/generate.py -- --out <dir> [--only a,b]

Every fixture is written to <out>/<name>/ together with <name>.truth.json (exact ground truth).
See docs/briefs/WP2-fixtures.md and fixtures/README.md.
"""
import argparse
import json
import math
import os
import struct
import sys
import time
import zlib

import numpy as np

import bpy
import bmesh
from mathutils import Matrix, Vector

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Fixtures generated when --only is not given. `dense` takes ~7 s here, well under the 60 s limit of the
# brief, so it is part of the default run.
DEFAULT_FIXTURES = ["apose", "tpose", "yup_cm", "mitten", "curled", "skirt", "dense",
                    "rigged_mixamo", "rigged_ue", "rigged_biped", "sword", "rifle"]

FINGERS = ["thumb", "index", "middle", "ring", "pinky"]
FOUR_FINGERS = ["index", "middle", "ring", "pinky"]
APOSE_DEG = 50.0
HEIGHT_M = 1.80
# The brief does not say where the clavicle joint attaches to the spine chain; the skeleton parent of
# the shoulder bone is `chest`, so the arm part of the skin graph starts at chest (reported as a question).
CLAV_PARENT = "chest"


# ----------------------------------------------------------------------------------------------
# numpy helpers
# ----------------------------------------------------------------------------------------------
def nrm(v):
    v = np.asarray(v, dtype=np.float64)
    return v / np.linalg.norm(v)


def lerp(a, b, t):
    return a + t * (b - a)


def rodrigues(axis, ang):
    k = nrm(axis)
    K = np.array([[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]])
    return np.eye(3) + math.sin(ang) * K + (1 - math.cos(ang)) * (K @ K)


def mirror(p):
    return np.array([-p[0], p[1], p[2]], dtype=np.float64)


# ----------------------------------------------------------------------------------------------
# skeleton + ground-truth joints
# ----------------------------------------------------------------------------------------------
def load_skeleton():
    with open(os.path.join(REPO, "resources", "skeleton.json"), "r", encoding="utf-8") as f:
        sk = json.load(f)
    joints, editable = [], []
    for j in sk["joints"]:
        if "{s}" in j["name"]:
            for sd in sk["sides"]:
                n = j["name"].replace("{s}", sd["s"])
                joints.append(n)
                if j["editable"]:
                    editable.append(n)
        else:
            joints.append(j["name"])
            if j["editable"]:
                editable.append(j["name"])
    bones = []
    for b in sk["bones"]:
        if "{S}" in b["name"] or "{s}" in b["name"]:
            for sd in sk["sides"]:
                def ex(x):
                    return None if x is None else x.replace("{S}", sd["S"]).replace("{s}", sd["s"])
                bones.append({"name": ex(b["name"]), "head": ex(b["head"]), "tail": ex(b["tail"]),
                              "parent": ex(b["parent"]), "deform": b["deform"]})
        else:
            bones.append({"name": b["name"], "head": b["head"], "tail": b["tail"],
                          "parent": b["parent"], "deform": b["deform"]})
    return {"joints": joints, "editable": editable, "bones": bones}


SKELETON = None


def skeleton():
    global SKELETON
    if SKELETON is None:
        SKELETON = load_skeleton()
    return SKELETON


def left_editable(theta_deg):
    """Editable joints of the L side (+ centre line) exactly as in the brief's table."""
    th = math.radians(theta_deg)
    a = np.array([math.cos(th), 0.0, -math.sin(th)])
    lat = np.array([0.0, -1.0, 0.0])
    nL = nrm(np.cross(a, lat))
    E = {}
    sh = np.array([0.19, 0.02, 1.45])
    el = sh + 0.30 * a
    wr = el + 0.26 * a
    E["shoulder"], E["elbow"], E["wrist"] = sh, el, wr
    E["middle_0"] = wr + 0.090 * a
    E["index_0"] = wr + 0.085 * a + 0.025 * lat
    E["ring_0"] = wr + 0.085 * a - 0.020 * lat
    E["pinky_0"] = wr + 0.075 * a - 0.040 * lat
    E["index_tip"] = E["index_0"] + 0.080 * a
    E["middle_tip"] = E["middle_0"] + 0.090 * a
    E["ring_tip"] = E["ring_0"] + 0.085 * a
    E["pinky_tip"] = E["pinky_0"] + 0.068 * a
    E["thumb_0"] = wr + 0.020 * a + 0.030 * lat + 0.015 * nL
    E["thumb_tip"] = E["thumb_0"] + 0.070 * nrm(0.55 * a + 0.75 * lat + 0.35 * nL)
    E["hip"] = np.array([0.09, 0.00, 0.93])
    E["knee"] = np.array([0.10, -0.01, 0.50])
    E["ankle"] = np.array([0.11, 0.01, 0.08])
    E["toe"] = np.array([0.11, -0.17, 0.015])
    return E


def hand_frame(J, s):
    """Hand frame from contracts section 4."""
    w, i0, m0, r0, p0 = (J["%s_%s" % (n, s)] for n in ("wrist", "index_0", "middle_0", "ring_0", "pinky_0"))
    axis = nrm(m0 - w)
    lat = nrm(i0 - p0)
    n = nrm(np.cross(axis, lat)) if s == "L" else nrm(np.cross(lat, axis))
    width = float(np.linalg.norm(i0 - p0))
    grip_axis = nrm(lat - axis * np.dot(lat, axis))
    return {"palm_normal": n, "lateral": lat, "hand_axis": axis, "hand_width": width,
            "grip_axis": grip_axis, "palm_centre": (i0 + m0 + r0 + p0 + w) / 5.0}


def build_joints(theta_deg, curl_deg=0.0):
    """All 68 ground-truth joints, in skeleton order. Derived joints use the contracts section 4 rules."""
    sk = skeleton()
    E = left_editable(theta_deg)
    J = {"pelvis": np.array([0.0, 0.0, 0.95]), "chest": np.array([0.0, 0.01, 1.30]),
         "neck": np.array([0.0, 0.02, 1.52]), "head": np.array([0.0, 0.02, 1.60]),
         "head_top": np.array([0.0, 0.02, 1.80])}
    for k, v in E.items():
        J[k + "_L"] = v.copy()
        J[k + "_R"] = mirror(v)
    # derived
    J["spine0"] = lerp(J["pelvis"], J["chest"], 0.30)
    for s, sign in (("L", 1.0), ("R", -1.0)):
        sh = J["shoulder_" + s]
        J["clav_" + s] = np.array([J["pelvis"][0] + sign * 0.18 * abs(sh[0] - J["pelvis"][0]), J["neck"][1],
                                   J["neck"][2] - 0.25 * (J["neck"][2] - sh[2])])
        an, to = J["ankle_" + s], J["toe_" + s]
        b = lerp(an, to, 0.68)
        b[2] = 0.35 * an[2] + 0.65 * to[2]
        J["ball_" + s] = b
        for f in FOUR_FINGERS:
            J["%s_1_%s" % (f, s)] = lerp(J["%s_0_%s" % (f, s)], J["%s_tip_%s" % (f, s)], 0.45)
            J["%s_2_%s" % (f, s)] = lerp(J["%s_0_%s" % (f, s)], J["%s_tip_%s" % (f, s)], 0.75)
        J["thumb_1_" + s] = lerp(J["thumb_0_" + s], J["thumb_tip_" + s], 0.40)
        J["thumb_2_" + s] = lerp(J["thumb_0_" + s], J["thumb_tip_" + s], 0.73)
    if curl_deg:
        curl_fingers(J, curl_deg)
    for s in ("L", "R"):
        fr = hand_frame(J, s)
        J["grip_" + s] = fr["palm_centre"] + fr["palm_normal"] * 0.35 * fr["hand_width"]
        J["grip_tip_" + s] = J["grip_" + s] + fr["grip_axis"] * 0.10
    missing = [n for n in sk["joints"] if n not in J]
    assert not missing, missing
    return {n: J[n] for n in sk["joints"]}


def curl_fingers(J, deg):
    """Flex each finger joint (_0, _1, _2) by `deg` toward the palm.

    The flex axis is cross(rest segment dir, palm normal) and stays fixed per finger so that all three
    joints curl the same way (see QUESTIONS in the report)."""
    for s in ("L", "R"):
        n = hand_frame(J, s)["palm_normal"]
        for f in FOUR_FINGERS:
            names = ["%s_%d_%s" % (f, k, s) for k in range(3)] + ["%s_tip_%s" % (f, s)]
            pts = [J[x].copy() for x in names]
            axis = nrm(np.cross(nrm(pts[1] - pts[0]), n))
            R = rodrigues(axis, math.radians(deg))
            for k in range(3):
                pivot = pts[k].copy()
                for m in range(k + 1, 4):
                    pts[m] = pivot + R @ (pts[m] - pivot)
            for x, p in zip(names, pts):
                J[x] = p


def hands_truth(J):
    out = {}
    for s in ("L", "R"):
        fr = hand_frame(J, s)
        out[s] = {"palm_normal": fr["palm_normal"].tolist(), "lateral": fr["lateral"].tolist(),
                  "hand_axis": fr["hand_axis"].tolist(), "hand_width": fr["hand_width"]}
    return out


# ----------------------------------------------------------------------------------------------
# textures
# ----------------------------------------------------------------------------------------------
TEX_N = 1024
NORMAL_K = 2.0
_HEIGHT_CACHE = {}


def smoothstep(t):
    t = np.clip(t, 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def height_field():
    if "H" in _HEIGHT_CACHE:
        return _HEIGHT_CACHE["H"]
    rng = np.random.default_rng(1234)
    N = TEX_N
    idx = np.arange(N)
    g = (idx % 64) < 3
    H = np.zeros((N, N), dtype=np.float64)
    H[g[:, None] | g[None, :]] = -1.0
    yy, xx = np.mgrid[0:N, 0:N]
    cx = rng.integers(16, N - 16, size=40)
    cy = rng.integers(16, N - 16, size=40)
    S = np.zeros((N, N), dtype=np.float64)
    for x0, y0 in zip(cx, cy):
        d = np.hypot(xx - x0, yy - y0)
        s = np.where(d < 10.0, smoothstep((10.0 - d) / 3.0), 0.0)
        S = np.maximum(S, s)
    H = (H + S).astype(np.float32)
    _HEIGHT_CACHE["H"] = H
    return H


def normals_from_height(H, k=NORMAL_K):
    """Tangent-space normals, DirectX convention (green flipped). Row 0 is the top of the image (v up)."""
    H = np.asarray(H, dtype=np.float64)
    du = np.gradient(H, axis=1)
    dv = -np.gradient(H, axis=0)
    n = np.stack([-k * du, -k * dv, np.ones_like(H)], axis=-1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    n[..., 1] *= -1.0
    return n


def write_png(path, arr):
    arr = np.ascontiguousarray(arr, dtype=np.uint8)
    h, w, c = arr.shape
    assert c == 3

    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    raw = b"".join(b"\x00" + arr[i].tobytes() for i in range(h))
    data = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) +
            chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(data)


def write_textures(d, name):
    H = height_field()
    np.save(os.path.join(d, name + "_height.npy"), H)
    n = normals_from_height(H)
    write_png(os.path.join(d, name + "_n.png"), np.clip(np.rint((n * 0.5 + 0.5) * 255.0), 0, 255))
    grey = int(round(0.6 * 255))
    write_png(os.path.join(d, name + "_d.png"), np.full((TEX_N, TEX_N, 3), grey, dtype=np.uint8))


def make_material(d, name):
    mat = bpy.data.materials.new(name + "_mat")
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    tex_d = nt.nodes.new("ShaderNodeTexImage")
    tex_n = nt.nodes.new("ShaderNodeTexImage")
    nm = nt.nodes.new("ShaderNodeNormalMap")
    img_d = bpy.data.images.load(os.path.join(d, name + "_d.png"))
    img_n = bpy.data.images.load(os.path.join(d, name + "_n.png"))
    img_n.colorspace_settings.name = "Non-Color"
    tex_d.image = img_d
    tex_n.image = img_n
    nt.links.new(tex_d.outputs["Color"], bsdf.inputs["Base Color"])
    nt.links.new(tex_n.outputs["Color"], nm.inputs["Color"])
    nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    return mat


def smart_uv(obj):
    if not obj.data.uv_layers:
        obj.data.uv_layers.new(name="UVMap")
    bpy.context.view_layer.objects.active = obj
    for o in bpy.context.view_layer.objects:
        o.select_set(o == obj)
    with bpy.context.temp_override(active_object=obj, object=obj, selected_objects=[obj],
                                   selected_editable_objects=[obj], edit_object=obj):
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.select_all(action="SELECT")
        bpy.ops.uv.smart_project(angle_limit=math.radians(66.0), island_margin=0.02)
        bpy.ops.object.mode_set(mode="OBJECT")


# ----------------------------------------------------------------------------------------------
# mesh construction
# ----------------------------------------------------------------------------------------------
RADIUS = {"pelvis": 0.12, "spine0": 0.13, "chest": 0.16, "upper_chest": 0.17, "neck": 0.055,
          "neck_mid": 0.050, "head": 0.075, "cranium": 0.10, "head_top": 0.03,
          "clav": 0.06, "shoulder": 0.065, "upper_arm_mid": 0.048, "elbow": 0.042, "forearm_mid": 0.040,
          "wrist": 0.030, "hip": 0.085, "mid_thigh": 0.075, "knee": 0.048, "mid_calf": 0.060,
          "ankle": 0.040, "ball": 0.035, "toe": 0.025}


def base_name(n):
    return n[:-2] if n.endswith("_L") or n.endswith("_R") else n


def radius_of(n):
    b = base_name(n)
    if b in RADIUS:
        return RADIUS[b]
    if b.startswith("thumb"):
        return 0.010
    if b.endswith("_tip"):
        return 0.007
    return 0.009  # finger joints _0 _1 _2


def skin_parts(J, mitten=False):
    """Skin edge graphs: (name, edges, radius overrides). The first vertex of each part is its skin root.

    The brief asks for ONE skin graph; Blender's Skin modifier cannot build the junctions of that graph
    (see DEVIATIONS), so the graph is split at the problem junctions and the parts are unioned.
    Returns (parts, positions incl. extra non-joint vertices, palm/paddle blocks)."""
    parts = []
    blocks = []
    P = dict(J)
    P["upper_chest"] = np.array([0.0, 0.015, 1.40])
    P["neck_mid"] = lerp(J["neck"], J["head"], 0.5)
    P["cranium"] = np.array([0.0, 0.02, 1.69])
    body = [("pelvis", "spine0"), ("spine0", "chest"), ("chest", "upper_chest"), ("upper_chest", "neck"),
            ("neck", "neck_mid"), ("neck_mid", "head"), ("head", "cranium"), ("cranium", "head_top")]
    for s in ("L", "R"):
        P["mid_thigh_" + s] = lerp(J["hip_" + s], J["knee_" + s], 0.4)
        P["mid_calf_" + s] = lerp(J["knee_" + s], J["ankle_" + s], 0.30)
        P["upper_arm_mid_" + s] = lerp(J["shoulder_" + s], J["elbow_" + s], 0.5)
        P["forearm_mid_" + s] = lerp(J["elbow_" + s], J["wrist_" + s], 0.4)
        body += [("pelvis", "hip_" + s), ("hip_" + s, "mid_thigh_" + s), ("mid_thigh_" + s, "knee_" + s),
                 ("knee_" + s, "mid_calf_" + s), ("mid_calf_" + s, "ankle_" + s),
                 ("ankle_" + s, "ball_" + s), ("ball_" + s, "toe_" + s)]
    parts.append(("body", body, {}))
    for s in ("L", "R"):
        parts.append(("arm_" + s, [(CLAV_PARENT, "clav_" + s), ("clav_" + s, "shoulder_" + s),
                                   ("shoulder_" + s, "upper_arm_mid_" + s), ("upper_arm_mid_" + s, "elbow_" + s),
                                   ("elbow_" + s, "forearm_mid_" + s), ("forearm_mid_" + s, "wrist_" + s)], {}))
        fr = hand_frame(J, s)
        ax, lat, nrm_ = fr["hand_axis"], fr["lateral"], fr["palm_normal"]
        x = nrm(lat - ax * np.dot(lat, ax))
        w, m0, tip = J["wrist_" + s], J["middle_0_" + s], J["middle_tip_" + s]
        mean0 = np.mean([J["%s_0_%s" % (f, s)] for f in FOUR_FINGERS], axis=0)
        blocks.append(("palm_" + s, lerp(w, mean0, 0.5), (x, ax, nrm_),
                       (fr["hand_width"] + 0.022, float(np.linalg.norm(m0 - w)) + 0.01, 0.030)))
        if mitten:
            blocks.append(("paddle_" + s, lerp(m0, tip, 0.5), (x, ax, nrm_),
                           (fr["hand_width"] + 0.01, float(np.linalg.norm(tip - m0)) + 0.01, 0.025)))
        for f in FINGERS:
            if mitten and f in ("index", "middle", "ring", "pinky"):
                continue
            # Each finger chain starts at an anchor 0.008 m back from its first joint, inside the palm.
            f0 = J["%s_0_%s" % (f, s)]
            a_ = "anchor_%s_%s" % (f, s)
            P[a_] = f0 + 0.008 * nrm(w - f0)
            names = [a_] + ["%s_%d_%s" % (f, k, s) for k in range(3)] + ["%s_tip_%s" % (f, s)]
            parts.append(("%s_%s" % (f, s), list(zip(names[:-1], names[1:])), {a_: radius_of(names[1])}))
    return parts, P, blocks


def make_block(name, centre, axes, size):
    bm = bmesh.new()
    rot = Matrix([[axes[0][i], axes[1][i], axes[2][i]] for i in range(3)]).to_4x4()
    m = Matrix.Translation(Vector(tuple(float(c) for c in centre))) @ rot @ Matrix.Diagonal((size[0], size[1], size[2], 1.0))
    bmesh.ops.create_cube(bm, size=1.0, matrix=m)
    bmesh.ops.bevel(bm, geom=list(bm.verts) + list(bm.edges), offset=0.006, offset_type="OFFSET",
                    segments=2, affect="EDGES")
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    for pl in mesh.polygons:
        pl.use_smooth = True
    return link(bpy.data.objects.new(name, mesh))


def link(obj):
    bpy.context.scene.collection.objects.link(obj)
    return obj


def bake_modifiers(obj):
    """Apply the whole modifier stack of obj by evaluating it (no bpy.ops)."""
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    new = bpy.data.meshes.new_from_object(obj.evaluated_get(dg))
    old = obj.data
    obj.modifiers.clear()
    obj.data = new
    bpy.data.meshes.remove(old)
    return obj


END_EXTENSION = 0.3  # chain ends are extended by this fraction of their radius, see skin_part


def skin_part(name, J, edges, rad_over, sub_levels=1):
    # A Skin surface ends flush at an end vertex and Subdivision Surface shrinks that cap further inwards,
    # so an end joint (head_top, finger tips, toes) would lie just OUTSIDE the mesh. Every chain end gets one
    # extra vertex END_EXTENSION * radius beyond the joint so that the joint is inside the surface.
    J = dict(J)
    edges = list(edges)
    valence = {}
    for a, b in edges:
        valence[a] = valence.get(a, 0) + 1
        valence[b] = valence.get(b, 0) + 1
    rad_over = dict(rad_over)
    for a, b in list(edges):
        for end, other in ((b, a), (a, b)):
            if valence[end] == 1 and end != edges[0][0]:
                r = rad_over.get(end, radius_of(end))
                d = np.asarray(J[end]) - np.asarray(J[other])
                ext = end + "_ext"
                J[ext] = np.asarray(J[end]) + d / np.linalg.norm(d) * END_EXTENSION * r
                rad_over[ext] = r
                edges.append((end, ext))
    names = []
    for a, b in edges:
        for n in (a, b):
            if n not in names:
                names.append(n)
    bm = bmesh.new()
    sk = bm.verts.layers.skin.verify()
    verts = {n: bm.verts.new(tuple(float(c) for c in J[n])) for n in names}
    for a, b in edges:
        bm.edges.new((verts[a], verts[b]))
    for i, n in enumerate(names):
        r = rad_over.get(n, radius_of(n))
        verts[n][sk].radius = (r, r)
        if i == 0:
            verts[n][sk].use_root = True  # pelvis for the body part
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    obj = link(bpy.data.objects.new(name, mesh))
    m = obj.modifiers.new("Skin", "SKIN")
    m.use_smooth_shade = True
    m.use_x_symmetry = False
    s = obj.modifiers.new("Subsurf", "SUBSURF")
    s.levels = sub_levels
    s.render_levels = sub_levels
    bake_modifiers(obj)
    return obj


def skin_body(name, J, mitten=False, sub_levels=1):
    parts, P, blocks = skin_parts(J, mitten)
    objs = [skin_part("%s_%s" % (name, pn), P, e, r, sub_levels) for pn, e, r in parts]
    objs += [make_block("%s_%s" % (name, bn), c, ax, sz) for bn, c, ax, sz in blocks]
    base = objs[0]
    for o in objs[1:]:
        m = base.modifiers.new("Union", "BOOLEAN")
        m.operation = "UNION"
        m.solver = "EXACT"
        m.object = o
        bake_modifiers(base)
        mesh = o.data
        bpy.data.objects.remove(o)
        bpy.data.meshes.remove(mesh)
    base.name = name
    base.data.name = name
    return base


def mesh_stats(obj):
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bad = sum(1 for e in bm.edges if len(e.link_faces) != 2)
    # connected components
    seen, comps = set(), 0
    for v in bm.verts:
        if v.index in seen:
            continue
        comps += 1
        stack = [v]
        seen.add(v.index)
        while stack:
            x = stack.pop()
            for e in x.link_edges:
                o = e.other_vert(x)
                if o.index not in seen:
                    seen.add(o.index)
                    stack.append(o)
    tris = sum(len(f.verts) - 2 for f in bm.faces)
    bm.free()
    return {"bad_edges": bad, "components": comps, "tris": tris, "verts": len(obj.data.vertices)}


LAST_MEASURE = {}


def measure(objs, body):
    """Final-mesh bbox of objs and crotch_z: first hit of a ray going up at x=0, y=mean(hip_L.y, hip_R.y)."""
    mn, mx = np.full(3, np.inf), np.full(3, -np.inf)
    for o in objs:
        a = np.array([tuple(v.co) for v in o.data.vertices])
        mn, mx = np.minimum(mn, a.min(0)), np.maximum(mx, a.max(0))
    from mathutils.bvhtree import BVHTree
    bm = bmesh.new()
    bm.from_mesh(body.data)
    bvh = BVHTree.FromBMesh(bm)
    bm.free()
    y = HIP_Y_MEAN
    loc, _n, _i, _d = bvh.ray_cast(Vector((0.0, y, -1.0)), Vector((0, 0, 1)))
    return {"mesh_bbox_m": {"min": mn.tolist(), "max": mx.tolist()},
            "crotch_z": None if loc is None else float(loc.z)}


HIP_Y_MEAN = 0.0


def textured_body(name, d, J, mitten=False, textured=True):
    global HIP_Y_MEAN
    HIP_Y_MEAN = float((J["hip_L"][1] + J["hip_R"][1]) / 2.0)
    obj = skin_body(name, J, mitten=mitten)
    LAST_MEASURE.clear()
    LAST_MEASURE.update(measure([obj], obj))
    st = mesh_stats(obj)
    assert st["bad_edges"] == 0, "non-manifold edges in %s: %s" % (name, st)
    assert st["components"] == 1, "body is not one connected piece: %s" % st
    if textured:
        smart_uv(obj)
        obj.data.materials.clear()  # the Skin modifier output carries an empty slot
        obj.data.materials.append(make_material(d, name))
    return obj


# ----------------------------------------------------------------------------------------------
# export helpers
# ----------------------------------------------------------------------------------------------
def select_only(objs):
    bpy.context.view_layer.update()
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]


def export_fbx(path, objs, up="Z", forward="-Y", scale=1.0, textures=True):
    select_only(objs)
    kw = dict(filepath=path, use_selection=True, axis_up=up, axis_forward=forward, global_scale=scale,
              object_types={"MESH", "ARMATURE"}, add_leaf_bones=False, use_armature_deform_only=False,
              bake_anim=False)
    if textures:
        kw.update(path_mode="COPY", embed_textures=True)
    bpy.ops.export_scene.fbx(**kw)


def export_glb(path, objs):
    select_only(objs)
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", use_selection=True, export_yup=True)


def export_obj(path, objs):
    select_only(objs)
    bpy.ops.wm.obj_export(filepath=path, export_selected_objects=True, export_materials=True,
                          forward_axis="NEGATIVE_Y", up_axis="Z", path_mode="COPY")


def write_truth(d, name, data):
    with open(os.path.join(d, name + ".truth.json"), "w", encoding="utf-8") as f:
        json.dump(data, f, indent=1)


def humanoid_truth(name, J, theta, export, mapping=None):
    t = {"schema": "mpm.fixture/1", "name": name, "height_m": HEIGHT_M, "up": "Z", "forward": "-Y",
         "export": export, "arm_angle_deg": theta,
         "joints": {k: [float(c) for c in v] for k, v in J.items()},
         "hands": hands_truth(J), "editable": list(skeleton()["editable"]),
         "normal_convention": "directx"}
    t.update(LAST_MEASURE)
    if mapping is not None:
        t["mapping"] = mapping
    return t


EXPORT_STD = {"up": "Z", "forward": "-Y", "unit_scale": 1.0}


# ----------------------------------------------------------------------------------------------
# humanoid fixtures
# ----------------------------------------------------------------------------------------------
def fx_apose(d, name="apose"):
    J = build_joints(APOSE_DEG)
    write_textures(d, name)
    body = textured_body(name, d, J)
    export_fbx(os.path.join(d, name + ".fbx"), [body])
    export_glb(os.path.join(d, name + ".glb"), [body])
    export_obj(os.path.join(d, name + ".obj"), [body])
    write_truth(d, name, humanoid_truth(name, J, APOSE_DEG, EXPORT_STD))


def fx_tpose(d, name="tpose"):
    J = build_joints(0.0)
    write_textures(d, name)
    body = textured_body(name, d, J)
    export_fbx(os.path.join(d, name + ".fbx"), [body])
    write_truth(d, name, humanoid_truth(name, J, 0.0, EXPORT_STD))


def fx_yup_cm(d, name="yup_cm"):
    J = build_joints(APOSE_DEG)
    write_textures(d, name)
    body = textured_body(name, d, J)
    export_fbx(os.path.join(d, name + ".fbx"), [body], up="Y", forward="-Z", scale=100.0)
    write_truth(d, name, humanoid_truth(name, J, APOSE_DEG, {"up": "Y", "forward": "-Z", "unit_scale": 0.01}))


def fx_mitten(d, name="mitten"):
    J = build_joints(APOSE_DEG)
    write_textures(d, name)
    body = textured_body(name, d, J, mitten=True)
    export_fbx(os.path.join(d, name + ".fbx"), [body])
    write_truth(d, name, humanoid_truth(name, J, APOSE_DEG, EXPORT_STD))


def fx_curled(d, name="curled"):
    J = build_joints(APOSE_DEG, curl_deg=60.0)
    write_textures(d, name)
    body = textured_body(name, d, J)
    export_fbx(os.path.join(d, name + ".fbx"), [body])
    write_truth(d, name, humanoid_truth(name, J, APOSE_DEG, EXPORT_STD))


def cone_sheet(name, z_top, r_top, z_bot, r_bot, segs=48):
    bm = bmesh.new()
    top = [bm.verts.new((r_top * math.cos(2 * math.pi * i / segs), r_top * math.sin(2 * math.pi * i / segs), z_top))
           for i in range(segs)]
    bot = [bm.verts.new((r_bot * math.cos(2 * math.pi * i / segs), r_bot * math.sin(2 * math.pi * i / segs), z_bot))
           for i in range(segs)]
    for i in range(segs):
        j = (i + 1) % segs
        bm.faces.new((top[i], bot[i], bot[j], top[j]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    return link(bpy.data.objects.new(name, mesh))


def flap_strip(name):
    bm = bmesh.new()
    vs = [bm.verts.new(p) for p in ((-0.03, 0.13, 0.45), (0.03, 0.13, 0.45), (0.03, 0.13, 0.95), (-0.03, 0.13, 0.95))]
    bm.faces.new(vs)
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    return link(bpy.data.objects.new(name, mesh))


def fx_skirt(d, name="skirt"):
    J = build_joints(APOSE_DEG)
    write_textures(d, name)
    body = textured_body(name, d, J)
    cone = cone_sheet(name + "_cone", 0.95, 0.17, 0.62, 0.30)
    flap = flap_strip(name + "_flap")
    mat = body.data.materials[0]
    for o in (cone, flap):
        smart_uv(o)
        o.data.materials.append(mat)
    LAST_MEASURE.update({k: v for k, v in measure([body, cone, flap], body).items() if k == "mesh_bbox_m"})
    export_fbx(os.path.join(d, name + ".fbx"), [body, cone, flap])
    write_truth(d, name, humanoid_truth(name, J, APOSE_DEG, EXPORT_STD))


def fx_dense(d, name="dense"):
    J = build_joints(APOSE_DEG)
    body = textured_body(name, d, J, textured=False)
    base = mesh_stats(body)["tris"]
    target = 1_050_000
    level = 0
    while base * 4 ** (level + 1) <= target * 4:  # smallest level with tris >= target / 1 (may overshoot)
        level += 1
        if base * 4 ** level >= target:
            break
    s = body.modifiers.new("Subsurf", "SUBSURF")
    s.levels = level
    s.render_levels = level
    bake_modifiers(body)
    tris = mesh_stats(body)["tris"]
    if tris > 1_150_000:
        dm = body.modifiers.new("Decimate", "DECIMATE")
        dm.ratio = 1_050_000.0 / tris
        dm.use_collapse_triangulate = True
        bake_modifiers(body)
    st = mesh_stats(body)
    print("dense: %d tris, %d bad edges" % (st["tris"], st["bad_edges"]))
    assert 900_000 <= st["tris"] <= 1_200_000, st
    LAST_MEASURE.update(measure([body], body))
    export_fbx(os.path.join(d, name + ".fbx"), [body], textures=False)
    write_truth(d, name, humanoid_truth(name, J, APOSE_DEG, EXPORT_STD))


# ----------------------------------------------------------------------------------------------
# rigged fixtures
# ----------------------------------------------------------------------------------------------
def end_dir(a, b, length):
    return b + nrm(b - a) * length


def mixamo_spec(J):
    P = "mixamorig:"
    B = []

    def add(n, h, t, p, c):
        B.append((P + n, np.asarray(h), np.asarray(t), (P + p) if p else None, c))

    m1 = lerp(J["spine0"], J["chest"], 0.5)
    add("Hips", J["pelvis"], J["spine0"], None, "hips")
    add("Spine", J["spine0"], m1, "Hips", "spine")
    add("Spine1", m1, J["chest"], "Spine", None)
    add("Spine2", J["chest"], J["neck"], "Spine1", "chest")
    add("Neck", J["neck"], J["head"], "Spine2", "neck")
    add("Head", J["head"], J["head_top"], "Neck", "head")
    add("HeadTop_End", J["head_top"], J["head_top"] + np.array([0, 0, 0.05]), "Head", None)
    for s, S in (("L", "Left"), ("R", "Right")):
        j = lambda n: J["%s_%s" % (n, s)]
        add(S + "Shoulder", j("clav"), j("shoulder"), "Spine2", "shoulder." + s)
        add(S + "Arm", j("shoulder"), j("elbow"), S + "Shoulder", "upper_arm." + s)
        add(S + "ForeArm", j("elbow"), j("wrist"), S + "Arm", "forearm." + s)
        add(S + "Hand", j("wrist"), j("middle_0"), S + "ForeArm", "hand." + s)
        for f in FINGERS:
            pts = [j(f + "_0"), j(f + "_1"), j(f + "_2"), j(f + "_tip")]
            prev = S + "Hand"
            for k in (1, 2, 3):
                nm_ = "%sHand%s%d" % (S, f.capitalize(), k)
                add(nm_, pts[k - 1], pts[k], prev, "%s.0%d.%s" % (f, k, s))
                prev = nm_
            add("%sHand%s4" % (S, f.capitalize()), pts[3], end_dir(pts[2], pts[3], 0.02), prev, None)
        add(S + "UpLeg", j("hip"), j("knee"), "Hips", "thigh." + s)
        add(S + "Leg", j("knee"), j("ankle"), S + "UpLeg", "shin." + s)
        add(S + "Foot", j("ankle"), j("ball"), S + "Leg", "foot." + s)
        add(S + "ToeBase", j("ball"), j("toe"), S + "Foot", "toe." + s)
        add(S + "Toe_End", j("toe"), end_dir(j("ball"), j("toe"), 0.04), S + "ToeBase", None)
    return B


def ue_spec(J):
    B = []

    def add(n, h, t, p, c):
        B.append((n, np.asarray(h), np.asarray(t), p, c))

    z = np.zeros(3)
    add("root", z, np.array([0, 0, 0.1]), None, None)
    add("pelvis", J["pelvis"], J["spine0"], "root", "hips")
    pts = [lerp(J["spine0"], J["chest"], k / 4.0) for k in range(5)] + [J["neck"]]
    prev = "pelvis"
    for k in range(5):
        nm_ = "spine_0%d" % (k + 1)
        add(nm_, pts[k], pts[k + 1], prev, "spine" if k == 0 else ("chest" if k == 4 else None))
        prev = nm_
    nm1 = lerp(J["neck"], J["head"], 0.5)
    add("neck_01", J["neck"], nm1, "spine_05", "neck")
    add("neck_02", nm1, J["head"], "neck_01", None)
    add("head", J["head"], J["head_top"], "neck_02", "head")
    add("ik_foot_root", z, np.array([0, 0, 0.1]), "root", None)
    add("ik_hand_root", z, np.array([0, 0, 0.1]), "root", None)
    add("ik_hand_gun", J["wrist_R"], J["middle_0_R"], "ik_hand_root", None)
    for s in ("l", "r"):
        S = s.upper()
        j = lambda n: J["%s_%s" % (n, S)]
        add("clavicle_" + s, j("clav"), j("shoulder"), "spine_05", "shoulder." + S)
        add("upperarm_" + s, j("shoulder"), j("elbow"), "clavicle_" + s, "upper_arm." + S)
        add("lowerarm_" + s, j("elbow"), j("wrist"), "upperarm_" + s, "forearm." + S)
        add("hand_" + s, j("wrist"), j("middle_0"), "lowerarm_" + s, "hand." + S)
        add("upperarm_twist_01_" + s, lerp(j("shoulder"), j("elbow"), 0.5), j("elbow"), "upperarm_" + s, None)
        add("lowerarm_twist_01_" + s, lerp(j("elbow"), j("wrist"), 0.5), j("wrist"), "lowerarm_" + s, None)
        for f in FINGERS:
            fp = [j(f + "_0"), j(f + "_1"), j(f + "_2"), j(f + "_tip")]
            prev = "hand_" + s
            if f != "thumb":
                nm_ = "%s_metacarpal_%s" % (f, s)
                add(nm_, j("wrist"), j(f + "_0"), prev, None)
                prev = nm_
            for k in (1, 2, 3):
                nm_ = "%s_0%d_%s" % (f, k, s)
                add(nm_, fp[k - 1], fp[k], prev, "%s.0%d.%s" % (f, k, S))
                prev = nm_
        add("thigh_" + s, j("hip"), j("knee"), "pelvis", "thigh." + S)
        add("calf_" + s, j("knee"), j("ankle"), "thigh_" + s, "shin." + S)
        add("foot_" + s, j("ankle"), j("ball"), "calf_" + s, "foot." + S)
        add("ball_" + s, j("ball"), j("toe"), "foot_" + s, "toe." + S)
        add("thigh_twist_01_" + s, lerp(j("hip"), j("knee"), 0.5), j("knee"), "thigh_" + s, None)
        add("calf_twist_01_" + s, lerp(j("knee"), j("ankle"), 0.5), j("ankle"), "calf_" + s, None)
        an, ba = j("ankle"), j("ball")
        add("ik_foot_" + s, np.array([an[0], an[1], 0.0]), np.array([ba[0], ba[1], 0.0]), "ik_foot_root", None)
        add("ik_hand_" + s, j("wrist"), j("middle_0"), "ik_hand_gun", None)
    return B


def biped_spec(J):
    B = []

    def add(n, h, t, p, c):
        B.append((n, np.asarray(h), np.asarray(t), p, c))

    add("Bip01", J["pelvis"], J["pelvis"] + np.array([0, 0, -0.05]), None, None)
    add("Bip01 Pelvis", J["pelvis"], J["spine0"], "Bip01", "hips")
    add("Bip01 Spine", J["spine0"], J["chest"], "Bip01 Pelvis", "spine")
    add("Bip01 Spine1", J["chest"], J["neck"], "Bip01 Spine", "chest")
    add("Bip01 Neck", J["neck"], J["head"], "Bip01 Spine1", "neck")
    add("Bip01 Head", J["head"], J["head_top"], "Bip01 Neck", "head")
    fnum = {"thumb": 0, "index": 1, "middle": 2, "ring": 3, "pinky": 4}
    for s in ("L", "R"):
        j = lambda n: J["%s_%s" % (n, s)]
        pre = "Bip01 %s " % s
        add(pre + "Clavicle", j("clav"), j("shoulder"), "Bip01 Spine1", "shoulder." + s)
        add(pre + "UpperArm", j("shoulder"), j("elbow"), pre + "Clavicle", "upper_arm." + s)
        add(pre + "Forearm", j("elbow"), j("wrist"), pre + "UpperArm", "forearm." + s)
        add(pre + "Hand", j("wrist"), j("middle_0"), pre + "Forearm", "hand." + s)
        for f in FINGERS:
            fp = [j(f + "_0"), j(f + "_1"), j(f + "_2"), j(f + "_tip")]
            fn = fnum[f]
            names = ["%sFinger%d" % (pre, fn), "%sFinger%d1" % (pre, fn) if fn else "%sFinger01" % pre,
                     "%sFinger%d2" % (pre, fn) if fn else "%sFinger02" % pre]
            prev = pre + "Hand"
            for k in range(3):
                add(names[k], fp[k], fp[k + 1], prev, "%s.0%d.%s" % (f, k + 1, s))
                prev = names[k]
        add(pre + "Thigh", j("hip"), j("knee"), "Bip01 Pelvis", "thigh." + s)
        add(pre + "Calf", j("knee"), j("ankle"), pre + "Thigh", "shin." + s)
        add(pre + "Foot", j("ankle"), j("ball"), pre + "Calf", "foot." + s)
        add(pre + "Toe0", j("ball"), j("toe"), pre + "Foot", "toe." + s)
    return B


def point_segment_dist(V, A, B):
    """V (N,3), segments A,B (M,3) -> (N,M) distances."""
    AB = B - A
    L2 = np.maximum((AB * AB).sum(1), 1e-12)
    out = np.empty((V.shape[0], A.shape[0]))
    for m in range(A.shape[0]):
        t = np.clip(((V - A[m]) @ AB[m]) / L2[m], 0.0, 1.0)
        out[:, m] = np.linalg.norm(V - (A[m] + t[:, None] * AB[m]), axis=1)
    return out


def build_rig(name, d, J, spec, arm_loc=(0, 0, 0), arm_rot=(0, 0, 0), arm_scale=1.0, mesh_obj=None):
    """Create the armature from `spec` (world-space heads/tails in metres), skin `mesh_obj` to it."""
    ad = bpy.data.armatures.new(name + "_armature")
    arm = link(bpy.data.objects.new(name + "_armature", ad))
    arm.location = arm_loc
    arm.rotation_euler = arm_rot
    arm.scale = (arm_scale,) * 3
    bpy.context.view_layer.update()
    inv = arm.matrix_world.inverted()
    bpy.context.view_layer.objects.active = arm
    for o in bpy.context.view_layer.objects:
        o.select_set(o == arm)
    with bpy.context.temp_override(active_object=arm, object=arm, selected_objects=[arm],
                                   selected_editable_objects=[arm]):
        bpy.ops.object.mode_set(mode="EDIT")
        ebs = {}
        for n, h, t, p, c in spec:
            eb = ad.edit_bones.new(n)
            eb.head = inv @ Vector(tuple(float(x) for x in h))
            eb.tail = inv @ Vector(tuple(float(x) for x in t))
            ebs[n] = eb
        for n, h, t, p, c in spec:
            if p:
                ebs[n].parent = ebs[p]
        bpy.ops.object.mode_set(mode="OBJECT")
    # deterministic weights: 2 nearest segments among bones with a canonical mapping, w ~ 1/d^4
    wb = [(n, np.asarray(h), np.asarray(t)) for n, h, t, p, c in spec if c is not None]
    V = np.array([tuple(v.co) for v in mesh_obj.data.vertices], dtype=np.float64)
    Dm = point_segment_dist(V, np.array([x[1] for x in wb]), np.array([x[2] for x in wb]))
    two = np.argsort(Dm, axis=1, kind="stable")[:, :2]
    groups = {n: mesh_obj.vertex_groups.new(name=n) for n, _, _ in wb}
    for vi in range(V.shape[0]):
        ds = np.maximum(Dm[vi, two[vi]], 1e-9)
        w = 1.0 / ds ** 4
        w = w / w.sum()
        for k in range(2):
            groups[wb[two[vi, k]][0]].add([vi], float(w[k]), "REPLACE")
    mod = mesh_obj.modifiers.new("Armature", "ARMATURE")
    mod.object = arm
    mesh_obj.parent = arm
    mesh_obj.matrix_parent_inverse = arm.matrix_world.inverted()
    return arm


def rigged(d, name, theta, spec_fn, export, arm_kw):
    J = build_joints(theta)
    write_textures(d, name)
    body = textured_body(name, d, J)
    spec = spec_fn(J)
    arm = build_rig(name, d, J, spec, mesh_obj=body, **arm_kw)
    kw = {k: export[k] for k in ("up", "forward")}
    scale = 1.0 / export["unit_scale"] if export["unit_scale"] != 1.0 else 1.0
    export_fbx(os.path.join(d, name + ".fbx"), [arm, body], up=kw["up"], forward=kw["forward"], scale=scale)
    mapping = {n: c for n, h, t, p, c in spec}
    write_truth(d, name, humanoid_truth(name, J, theta, export, mapping))


def fx_rigged_mixamo(d, name="rigged_mixamo"):
    rigged(d, name, 0.0, mixamo_spec, {"up": "Y", "forward": "-Z", "unit_scale": 0.01},
           dict(arm_rot=(math.radians(90.0), 0, 0), arm_scale=0.01))


def fx_rigged_ue(d, name="rigged_ue"):
    rigged(d, name, APOSE_DEG, ue_spec, {"up": "Z", "forward": "-Y", "unit_scale": 0.01}, {})


def fx_rigged_biped(d, name="rigged_biped"):
    rigged(d, name, 0.0, biped_spec, EXPORT_STD, {})


# ----------------------------------------------------------------------------------------------
# weapons
# ----------------------------------------------------------------------------------------------
def bm_to_obj(bm, name):
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    for p in mesh.polygons:
        p.use_smooth = False
    return link(bpy.data.objects.new(name, mesh))


def add_box(bm, centre, size):
    m = Matrix.Translation(centre) @ Matrix.Diagonal((size[0], size[1], size[2], 1.0))
    bmesh.ops.create_cube(bm, size=1.0, matrix=m)


def add_cyl(bm, centre, radius, length, axis=Vector((0, 0, 1)), segs=24):
    rot = Vector((0, 0, 1)).rotation_difference(axis).to_matrix().to_4x4()
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=segs, radius1=radius, radius2=radius,
                          depth=length, matrix=Matrix.Translation(centre) @ rot)


def add_blade(bm, z0, length, width, thick, taper_len):
    hw, ht = width / 2.0, thick / 2.0
    z1 = z0 + length - taper_len
    base = [bm.verts.new(p) for p in ((-hw, -ht, z0), (hw, -ht, z0), (hw, ht, z0), (-hw, ht, z0))]
    top = [bm.verts.new(p) for p in ((-hw, -ht, z1), (hw, -ht, z1), (hw, ht, z1), (-hw, ht, z1))]
    tip = bm.verts.new((0, 0, z0 + length))
    bm.faces.new(base[::-1])
    for i in range(4):
        j = (i + 1) % 4
        bm.faces.new((base[i], base[j], top[j], top[i]))
        bm.faces.new((top[i], top[j], tip))


def fx_sword(d, name="sword"):
    bm = bmesh.new()
    add_cyl(bm, Vector((0, 0, 0)), 0.015, 0.12)                       # grip, centre at origin
    add_box(bm, Vector((0, 0, 0.075)), (0.20, 0.03, 0.03))            # cross-guard
    add_blade(bm, 0.09, 0.80, 0.04, 0.006, 0.10)                      # blade z 0.09 .. 0.89
    bmesh.ops.create_uvsphere(bm, u_segments=24, v_segments=12, radius=0.025,
                              matrix=Matrix.Translation((0, 0, -0.085)))  # pommel
    obj = bm_to_obj(bm, name)
    export_glb(os.path.join(d, name + ".glb"), [obj])
    export_fbx(os.path.join(d, name + ".fbx"), [obj], textures=False)
    grips = {"main": {"point": [0.0, 0.0, 0.03], "axis": [0.0, 0.0, 1.0], "palm_normal": [-1.0, 0.0, 0.0]},
             "support": {"point": [0.0, 0.0, -0.035], "axis": [0.0, 0.0, 1.0], "palm_normal": [-1.0, 0.0, 0.0]}}
    write_truth(d, name, {"schema": "mpm.fixture/1", "name": name, "up": "Z", "forward": "-Y",
                          "export": EXPORT_STD, "grips": grips})


def fx_rifle(d, name="rifle"):
    ang = math.radians(20.0)
    g_axis = Vector((0, math.sin(ang), math.cos(ang)))               # up the grip (tilted back at the bottom)
    bm = bmesh.new()
    add_cyl(bm, Vector((0, 0, 0)), 0.016, 0.11, axis=g_axis)         # pistol grip, centred at origin
    add_box(bm, Vector((0, 0.08, 0.0867)), (0.04, 0.26, 0.07))       # receiver  y -0.05 .. 0.21
    add_box(bm, Vector((0, 0.31, 0.085)), (0.05, 0.20, 0.05))        # handguard y 0.21 .. 0.41
    add_cyl(bm, Vector((0, 0.425, 0.085)), 0.010, 0.45, axis=Vector((0, 1, 0)))  # barrel y 0.20 .. 0.65
    add_box(bm, Vector((0, -0.16, 0.075)), (0.035, 0.22, 0.08))      # stock y -0.27 .. -0.05
    obj = bm_to_obj(bm, name)
    export_glb(os.path.join(d, name + ".glb"), [obj])
    export_fbx(os.path.join(d, name + ".fbx"), [obj], textures=False)
    pn = Vector((0, math.cos(ang), -math.sin(ang)))                   # palm presses on the rear strap
    grips = {"main": {"point": [0.0, 0.0, 0.0], "axis": list(g_axis), "palm_normal": list(pn)},
             "support": {"point": [0.0, 0.31, 0.085], "axis": [0.0, 1.0, 0.0], "palm_normal": [0.0, 0.0, 1.0]}}
    grips = {k: {kk: [float(x) for x in vv] for kk, vv in v.items()} for k, v in grips.items()}
    write_truth(d, name, {"schema": "mpm.fixture/1", "name": name, "up": "Z", "forward": "-Y",
                          "export": EXPORT_STD, "grips": grips})


FIXTURE_FUNCS = {"apose": fx_apose, "tpose": fx_tpose, "yup_cm": fx_yup_cm, "mitten": fx_mitten,
                 "curled": fx_curled, "skirt": fx_skirt, "dense": fx_dense,
                 "rigged_mixamo": fx_rigged_mixamo, "rigged_ue": fx_rigged_ue,
                 "rigged_biped": fx_rigged_biped, "sword": fx_sword, "rifle": fx_rifle}


def dir_size(d):
    return sum(os.path.getsize(os.path.join(r, f)) for r, _, fs in os.walk(d) for f in fs)


def generate(out, only=None):
    names = only or DEFAULT_FIXTURES
    report = {}
    for n in names:
        if n not in FIXTURE_FUNCS:
            raise SystemExit("unknown fixture: %s" % n)
        d = os.path.join(out, n)
        os.makedirs(d, exist_ok=True)
        bpy.ops.wm.read_factory_settings(use_empty=True)
        t0 = time.perf_counter()
        FIXTURE_FUNCS[n](d)
        dt = time.perf_counter() - t0
        report[n] = {"seconds": round(dt, 2), "bytes": dir_size(d)}
        print("fixture %-14s %7.2f s  %10.2f MB" % (n, dt, report[n]["bytes"] / 1e6), flush=True)
    return report


def main(argv=None):
    if argv is None:
        argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser(prog="generate.py")
    ap.add_argument("--out", required=True)
    ap.add_argument("--only", default="")
    a = ap.parse_args(argv)
    only = [x for x in a.only.split(",") if x] or None
    return generate(os.path.abspath(a.out), only)


if __name__ == "__main__":
    main()
