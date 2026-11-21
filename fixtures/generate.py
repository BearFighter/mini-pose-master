# SPDX-License-Identifier: GPL-3.0-or-later
"""Mini Pose Master fixture generator: original procedural weapon props (a sword and a rifle).

Run (headless):
  blender -b --factory-startup --python-exit-code 1 -P fixtures/generate.py -- --out <dir> [--only a,b]

Every fixture is written to <out>/<name>/ together with <name>.truth.json (exact ground truth).
There is no procedural figure: character behaviour is tested on real kits (tests/engine/kits.py).
See fixtures/README.md.
"""
import argparse
import json
import math
import os
import sys
import time

import bpy
import bmesh
from mathutils import Matrix, Vector

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Fixtures generated when --only is not given.
DEFAULT_FIXTURES = ["sword", "rifle"]

EXPORT_STD = {"up": "Z", "forward": "-Y", "unit_scale": 1.0}


# ----------------------------------------------------------------------------------------------
# export helpers
# ----------------------------------------------------------------------------------------------
def link(obj):
    bpy.context.scene.collection.objects.link(obj)
    return obj


def select_only(objs):
    bpy.context.view_layer.update()
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]


def export_fbx(path, objs):
    select_only(objs)
    bpy.ops.export_scene.fbx(filepath=path, use_selection=True, axis_up="Z", axis_forward="-Y", global_scale=1.0,
                             object_types={"MESH", "ARMATURE"}, add_leaf_bones=False,
                             use_armature_deform_only=False, bake_anim=False)


def export_glb(path, objs):
    select_only(objs)
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", use_selection=True, export_yup=True)


def write_truth(d, name, data):
    with open(os.path.join(d, name + ".truth.json"), "w", encoding="utf-8") as f:
        json.dump(data, f, indent=1)


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
    export_fbx(os.path.join(d, name + ".fbx"), [obj])
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
    export_fbx(os.path.join(d, name + ".fbx"), [obj])
    pn = Vector((0, math.cos(ang), -math.sin(ang)))                   # palm presses on the rear strap
    grips = {"main": {"point": [0.0, 0.0, 0.0], "axis": list(g_axis), "palm_normal": list(pn)},
             "support": {"point": [0.0, 0.31, 0.085], "axis": [0.0, 1.0, 0.0], "palm_normal": [0.0, 0.0, 1.0]}}
    grips = {k: {kk: [float(x) for x in vv] for kk, vv in v.items()} for k, v in grips.items()}
    write_truth(d, name, {"schema": "mpm.fixture/1", "name": name, "up": "Z", "forward": "-Y",
                          "export": EXPORT_STD, "grips": grips})


FIXTURE_FUNCS = {"sword": fx_sword, "rifle": fx_rifle}


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
