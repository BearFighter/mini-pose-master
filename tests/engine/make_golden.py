# SPDX-License-Identifier: GPL-3.0-or-later
"""Write tests/golden/<case>/ for the GLB <-> three.js conformance test (tests/ts/conformance.test.ts).

Run directly:  blender -b --factory-startup --python-exit-code 1 -P tests/engine/make_golden.py -- [kit]

The data comes from a real kit (tests/engine/kits.py; default: the first configured ordinary kit), never
from a figure made for the app, and tests/golden is git-ignored:
  auto rig      the kit's cached project (import -> suggest_markers -> rig)
  imported rig  the same kit with a Mixamo-style skeleton (rigged_kit.rigged_variant), rigged by the real
                jobs with the suggested mapping
Files per case: rig.json, rig_noimg.glb (pinned export, no images), poses.json, expected.json.
"""
import json
import math
import os
import random
import shutil
import sys

import bpy
from mathutils import Quaternion, Vector

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(REPO, "engine"))
sys.path.insert(0, os.path.join(REPO, "tests", "engine"))
from mpm import dump  # noqa: E402
from mpm import pose as PO  # noqa: E402
from mpm.rig import export  # noqa: E402
import kits  # noqa: E402
import rigged_kit  # noqa: E402

OUT = os.path.join(REPO, "tests", "golden")
# Folder names the TypeScript test looks for (its CASES list); they are only labels.
CASE_AUTO = "auto_apose"
CASE_IMPORTED = "imported_mixamo"
IMPORTED_CONVENTION = "mixamo"
SAMPLES = 2000


def random_poses(arm, seed=42, n=3):
    """Identity + n random poses: each bone a random rotation (<= 40 deg) on top of its parent's delta."""
    rnd = random.Random(seed)
    bones = list(arm.data.bones)
    index = {b.name: i for i, b in enumerate(bones)}
    depth = lambda b: 0 if b.parent is None else 1 + depth(b.parent)  # noqa: E731
    order = sorted(range(len(bones)), key=lambda i: (depth(bones[i]), i))   # parents first
    poses = [{"schema": "mpm.pose/1", "rig_hash": "", "root_offset": [0, 0, 0], "deltas": {}}]
    for _ in range(n):
        D = {}
        for i in order:
            b = bones[i]
            ax = Vector((rnd.uniform(-1, 1), rnd.uniform(-1, 1), rnd.uniform(-1, 1))).normalized()
            q = Quaternion(ax, math.radians(rnd.uniform(0, 40)))
            D[i] = (D[index[b.parent.name]] @ q) if b.parent else q
        deltas = {str(i): [q.w, q.x, q.y, q.z] for i, q in sorted(D.items())}
        off = [rnd.uniform(-0.05, 0.05) for _ in range(3)]
        poses.append({"schema": "mpm.pose/1", "rig_hash": "", "root_offset": off, "deltas": deltas})
    return poses


def write_case(case, project_dir, source):
    """Golden files of one rigged project (its rig/rig.blend and rig/rig.json)."""
    with open(os.path.join(project_dir, "rig", "rig.json"), encoding="utf-8") as fh:
        rig = json.load(fh)
    bpy.ops.wm.open_mainfile(filepath=os.path.join(project_dir, "rig", "rig.blend"))
    arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
    meshes = [bpy.data.objects[m["name"]] for m in rig["meshes"]]
    d = os.path.join(OUT, case)
    if os.path.isdir(d):
        shutil.rmtree(d)
    os.makedirs(d)
    shutil.copy(os.path.join(project_dir, "rig", "rig.json"), os.path.join(d, "rig.json"))
    PO.rest_pose(arm)
    export.export_glb(arm, meshes, os.path.join(d, "rig_noimg.glb"), images=False)
    poses = random_poses(arm)
    for p in poses:
        p["rig_hash"] = rig["hash"]
    rnd = random.Random(7)
    sample = {o.name: sorted(rnd.sample(range(len(o.data.vertices)), min(SAMPLES, len(o.data.vertices))))
              for o in meshes}
    expected = [dump.dump(arm, meshes, rig, p, sample) for p in poses]
    PO.rest_pose(arm)
    with open(os.path.join(d, "poses.json"), "w", encoding="utf-8") as fh:
        json.dump(poses, fh)
    with open(os.path.join(d, "expected.json"), "w", encoding="utf-8") as fh:
        json.dump(expected, fh)
    with open(os.path.join(d, "source.json"), "w", encoding="utf-8") as fh:
        json.dump(source, fh, indent=1)
    print("golden %s: %s, kind %s, %d bones, %d meshes, %d sampled vertices, %d poses" % (
        case, source, rig["kind"], len(rig["bones"]), len(meshes), sum(len(v) for v in sample.values()), len(poses)))


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    have = kits.names()
    if not have:
        print("make_golden: no real kits configured (tests/local/kits.json); see tests/engine/kits.py")
        sys.exit(1)
    kit = argv[0] if argv else (kits.names(hard=False) or have)[0]
    if kit not in have:
        print("make_golden: unknown kit %r (configured: %s)" % (kit, ", ".join(have)))
        sys.exit(1)
    write_case(CASE_AUTO, kits.project(kit, "rig").dir, {"kit": kit, "rig": "auto"})

    pr = kits.project_from_model(rigged_kit.rigged_variant(kit, IMPORTED_CONVENTION), upto="import",
                                 label="golden_" + kit)
    kits.ok(*kits.run_job(pr.dir, "rig", {"mapping": {}}))   # {} = the suggested mapping
    write_case(CASE_IMPORTED, pr.dir, {"kit": kit, "rig": "imported", "convention": IMPORTED_CONVENTION})


main()
