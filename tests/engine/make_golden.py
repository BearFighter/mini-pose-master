# SPDX-License-Identifier: GPL-3.0-or-later
"""Write tests/golden/<case>/ for the GLB <-> three.js conformance tests (WP5).

Run directly:  blender -b --factory-startup --python-exit-code 1 -P tests/engine/make_golden.py
Cases: auto_apose (WP4c rig from truth markers), imported_mixamo (WP4d, suggested mapping).
Files per case: rig.json, rig_noimg.glb (pinned export, no images), poses.json, expected.json.
"""
import json
import math
import os
import random
import shutil
import sys
import tempfile

import bpy
from mathutils import Quaternion, Vector

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(REPO, "engine"))
sys.path.insert(0, os.path.join(REPO, "engine", "jobs"))
sys.path.insert(0, os.path.join(REPO, "tests", "engine"))
from mpm import dump  # noqa: E402
from mpm.rig import export, imported  # noqa: E402
import rig as RIGJOB  # noqa: E402
import test_imported  # noqa: E402
import test_rig_build  # noqa: E402

OUT = os.path.join(REPO, "tests", "golden")
SAMPLES = 2000


def random_poses(arm, seed=42, n=3):
    """Identity + n random poses: each bone a random rotation (<= 40 deg) on top of its parent's delta."""
    rnd = random.Random(seed)
    bones = list(arm.data.bones)
    index = {b.name: i for i, b in enumerate(bones)}
    poses = [{"schema": "mpm.pose/1", "rig_hash": "", "root_offset": [0, 0, 0], "deltas": {}}]
    for _ in range(n):
        D = {}
        for i, b in enumerate(bones):  # bones are created parents-first in both cases
            ax = Vector((rnd.uniform(-1, 1), rnd.uniform(-1, 1), rnd.uniform(-1, 1))).normalized()
            q = Quaternion(ax, math.radians(rnd.uniform(0, 40)))
            parent = D.get(index[b.parent.name]) if b.parent else None
            D[i] = (parent @ q) if parent is not None else q
        deltas = {str(i): [q.w, q.x, q.y, q.z] for i, q in D.items()}
        off = [rnd.uniform(-0.05, 0.05) for _ in range(3)]
        poses.append({"schema": "mpm.pose/1", "rig_hash": "", "root_offset": off, "deltas": deltas})
    return poses


def write_case(name, arm, meshes, project):
    rig = json.load(open(os.path.join(project, "rig", "rig.json"), encoding="utf-8"))
    d = os.path.join(OUT, name)
    os.makedirs(d, exist_ok=True)
    shutil.copy(os.path.join(project, "rig", "rig.json"), os.path.join(d, "rig.json"))
    from mpm import pose as PO
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
    json.dump(poses, open(os.path.join(d, "poses.json"), "w", encoding="utf-8"))
    json.dump(expected, open(os.path.join(d, "expected.json"), "w", encoding="utf-8"))
    print("golden", name, "bones", len(rig["bones"]), "samples", {k: len(v) for k, v in sample.items()})


def main():
    tmp = tempfile.mkdtemp(prefix="mpm_golden_")
    try:
        meshes, joints, markers = test_rig_build.truth_markers("apose")
        RIGJOB.build_auto_rig(os.path.join(tmp, "auto"), markers)
        arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
        write_case("auto_apose", arm, meshes, os.path.join(tmp, "auto"))

        meshes, arm = test_imported.load_rigged("rigged_mixamo")
        mapping = imported.suggest_mapping(arm)["mapping"]
        imported.rig_imported(arm, meshes, os.path.join(tmp, "mixamo"), mapping)
        write_case("imported_mixamo", arm, meshes, os.path.join(tmp, "mixamo"))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


main()
