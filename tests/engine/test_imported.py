# SPDX-License-Identifier: GPL-3.0-or-later
"""WP4d acceptance: imported-rig mapping, normalisation, export."""
import json
import os
import shutil
import sys
import tempfile

import numpy as np

import bpy

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(REPO, "engine"))
from mpm import importer  # noqa: E402
from mpm.rig import imported  # noqa: E402
from mpm.rig.export import parse_glb_json  # noqa: E402
from test_markers import fx, load_truth  # noqa: E402

RIGGED = ("rigged_mixamo", "rigged_ue", "rigged_biped")


def load_rigged(name):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    new = importer.import_model(fx(name))
    meshes, arm, _w = importer.select_objects(new)
    importer.normalise(meshes, arm, importer.suggest_orientation(meshes))
    return meshes, arm


def test_conventions_and_mapping():
    for name, conv in zip(RIGGED, ("mixamo", "ue", "biped")):
        meshes, arm = load_rigged(name)
        sug = imported.suggest_mapping(arm)
        assert sug["convention"] == conv, (name, sug["convention"])
        truth = load_truth(name)["mapping"]
        bad = {k: (sug["mapping"].get(k), v) for k, v in truth.items() if sug["mapping"].get(k) != v}
        assert not bad, "%s mapping differs from truth: %s" % (name, dict(list(bad.items())[:8]))
        print("  %s: %s, confidence %.2f, unmapped %d" % (name, conv, sug["confidence"], len(sug["unmapped_canonical"])))


def test_unknown_convention():
    meshes, arm = load_rigged("rigged_mixamo")
    for i, b in enumerate(arm.data.bones):
        b.name = "bone_%03d" % i
    sug = imported.suggest_mapping(arm)
    assert sug["convention"] == "unknown" and sug["mapping"] == {} and sug["confidence"] == 0.0


def test_rig_imported_all():
    tmp = tempfile.mkdtemp(prefix="mpm_imp_")
    try:
        for name in RIGGED:
            meshes, arm = load_rigged(name)
            nbones = len(arm.data.bones)
            mapping = imported.suggest_mapping(arm)["mapping"]
            heads = {mapping[b.name]: np.array(b.head_local) for b in arm.data.bones if mapping.get(b.name)}
            rig, chk, secs = imported.rig_imported(arm, meshes, os.path.join(tmp, name), mapping)
            print("  %s: %.1f s, follow %s" % (name, secs, chk))
            assert rig["kind"] == "imported" and len(rig["bones"]) == nbones + 2, (name, len(rig["bones"]), nbones)
            from mpm import skeleton as SK
            for b in SK.BONES:
                if b["name"] in heads:
                    d = float(np.linalg.norm(np.array(rig["joints"][b["head"]]) - heads[b["name"]]))
                    assert d < 1e-6, (name, b["name"], d)
            T = load_truth(name)
            for s in ("L", "R"):
                assert rig["hands"][s] is not None, (name, s)
            pn = np.array(rig["hands"]["L"]["palm_normal"])
            if T["arm_angle_deg"] < 10:   # T-pose: palms down
                assert pn[2] < 0, (name, pn)
            else:                          # A-pose: palms toward the thighs
                assert pn[0] < 0, (name, pn)
            gj = parse_glb_json(os.path.join(tmp, name, "rig", "rig.glb"))
            nodes = {n.get("name") for n in gj["nodes"]}
            assert all(b["name"] in nodes for b in rig["bones"]), name
            grips = [b for b in rig["bones"] if b["canonical"] in ("grip.L", "grip.R")]
            assert len(grips) == 2 and not any(g["deform"] for g in grips), name
            for o in meshes:
                gi = {g.index: g.name for g in o.vertex_groups}
                for v in o.data.vertices:
                    ws = [e.weight for e in v.groups if gi.get(e.group)]
                    assert 1 <= len(ws) <= 4 and abs(sum(ws) - 1.0) < 1e-5, (name, v.index, ws)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
