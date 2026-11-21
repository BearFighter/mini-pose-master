# SPDX-License-Identifier: GPL-3.0-or-later
"""Prints how each configured real kit fares in import, joint finding and rigging (see kits.py).

  blender -b --factory-startup --python-exit-code 1 -P tests/engine/kit_report.py -- [kit ...]
"""
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "engine"))
import kits  # noqa: E402

FING = ("thumb", "index", "middle", "ring", "pinky")


def surface_tree(meshes):
    from mathutils.bvhtree import BVHTree
    verts, polys = [], []
    for o in meshes:
        base = len(verts)
        verts += [o.matrix_world @ v.co for v in o.data.vertices]
        polys += [[base + i for i in p.vertices] for p in o.data.polygons]
    return BVHTree.FromPolygons(verts, polys)


def report(name):
    pr = kits.project(name, "rig")
    imp, mk, rig = pr.result("import"), pr.result("markers"), pr.result("rig")
    print("=== %s: %d objects kept, %d tris, height %.3f m, facing %s, props %s" % (
        name, sum(1 for o in imp.get("all_objects", imp["objects"]) if o.get("included", True)), imp["tri_count"],
        imp["height_m"], imp["orientation_used"]["forward"], [p["file"] for p in imp.get("props", [])]))
    m = mk["markers"]
    low = sorted((v["confidence"], k) for k, v in m.items() if v["confidence"] < 0.8)
    print("  markers: %d, below 80%%: %s" % (len(m), ["%s %.0f%%" % (k, c * 100) for c, k in low] or "none"))
    for w in mk.get("warnings", []):
        print("  warn:", w)
    meshes = kits.open_scene(name)
    tree = surface_tree([o for o in meshes if "mpm_proxy_of" not in o])
    for s in ("L", "R"):
        d = [tree.find_nearest(m["%s_tip_%s" % (f, s)]["p"])[3] * 1000 for f in FING]
        ln = [float(np.linalg.norm(np.array(m["%s_tip_%s" % (f, s)]["p"]) - np.array(m["%s_0_%s" % (f, s)]["p"]))) * 1000
              for f in FING]
        print("  hand %s: tip to surface mm %s, finger length mm %s" % (
            s, " ".join("%.1f" % x for x in d), " ".join("%.0f" % x for x in ln)))
    print("  rig: %d bones, follow %s, unreached %s, %.1f s" % (
        rig["bones"], {k: round(v, 4) for k, v in rig["follow"].items()}, rig.get("blind_vertices"), rig["seconds"]))


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    for name in (argv or kits.need()):
        try:
            report(name)
        except Exception as e:  # noqa: BLE001
            print("=== %s: FAILED: %s" % (name, str(e)[:1500]))


main()
