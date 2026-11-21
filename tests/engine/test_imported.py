# SPDX-License-Identifier: GPL-3.0-or-later
"""The "use the model's own skeleton" path (contracts sections 7, 8 "Imported rigs", 16 suggest_mapping),
run with the real jobs: import -> suggest_mapping -> rig with the mapping.

No kit ships a skeleton, so the models are real kits given one in a real exporter's convention
(rigged_kit.py: Mixamo, Unreal mannequin, 3ds Max Biped). Skipped when no kits are configured."""
import os
import shutil
import sys
import tempfile

import numpy as np

import bpy

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(REPO, "engine"))
from mpm import importer  # noqa: E402
from mpm import pose as PO  # noqa: E402
from mpm import skeleton as SK  # noqa: E402
from mpm.rig import imported  # noqa: E402
from mpm.rig.export import parse_glb_json  # noqa: E402
import kits  # noqa: E402
import rigged_kit  # noqa: E402

CONVENTIONS = ("mixamo", "ue", "biped")
END_JOINTS = {b["tail"] for b in SK.BONES} - {b["head"] for b in SK.BONES}   # head_top, finger tips, toes, grip tips
_projects = {}


def cases():
    """(kit, convention): every convention on the first ordinary kit, one convention on each other kit."""
    names = kits.need()
    first = (kits.names(hard=False) or names)[0]
    return [(first, c) for c in CONVENTIONS] + \
           [(n, CONVENTIONS[i % len(CONVENTIONS)]) for i, n in enumerate(x for x in names if x != first)]


def rigged_project(kit, conv):
    """A scratch project with the rigged variant imported by the real import job (shared by the tests)."""
    if (kit, conv) not in _projects:
        fbx = rigged_kit.rigged_variant(kit, conv)
        _projects[(kit, conv)] = kits.project_from_model(fbx, upto="import", label="%s_%s" % (kit, conv))
    return _projects[(kit, conv)]


def kit_joints(kit):
    return {k: np.array(v) for k, v in kits.project(kit, "rig").rig["joints"].items()}


def test_detect_convention_names():
    """Pure name rules, no model."""
    dc = imported.detect_convention
    assert dc(["mixamorig:Hips", "mixamorig:LeftUpLeg"]) == "mixamo" and dc(["Hips", "LeftUpLeg"]) == "mixamo"
    assert dc(["root", "pelvis", "upperarm_l"]) == "ue"
    assert dc(["Bip01", "Bip01 Pelvis"]) == "biped" and dc(["Bip001 Pelvis"]) == "biped"
    assert dc(["DEF-spine", "DEF-thigh.L"]) == "rigify"
    assert dc(["bone_000", "bone_001"]) == "unknown" and dc([]) == "unknown"


def test_conventions_and_mapping():
    """The import job normalises a rigged FBX (centimetres, rotated and scaled armature object) onto the
    figure of the kit, and suggest_mapping finds the convention and the whole mapping."""
    for kit, conv in cases():
        pr = rigged_project(kit, conv)
        imp = pr.results["import"]
        truth = rigged_kit.expected_mapping(kit, conv)
        assert imp["has_armature"] is True, (kit, conv)
        assert sorted(b["name"] for b in imp["armature_bones"]) == sorted(truth), (kit, conv)
        assert imp["orientation_used"]["unit_scale"] == rigged_kit.CONVENTIONS[conv]["unit_scale"], \
            (kit, conv, imp["suggested_orientation"])
        ref = kits.project(kit, "import").result("import")
        assert abs(imp["height_m"] - ref["height_m"]) < 1e-3, (kit, conv, imp["height_m"], ref["height_m"])
        assert sorted(o["name"] for o in imp["objects"]) == sorted(o["name"] for o in ref["objects"]), (kit, conv)

        # the normalised scene: armature and meshes at identity, meshes skinned to it, bones on the joints
        bpy.ops.wm.open_mainfile(filepath=os.path.join(pr.dir, "rig", "scene.blend"))
        arms = [o for o in bpy.data.objects if o.type == 'ARMATURE']
        meshes = [o for o in bpy.data.objects if o.type == 'MESH']
        assert len(arms) == 1 and importer._identity_error(arms[0]) < 1e-6, (kit, conv)
        for o in meshes:
            assert importer._identity_error(o) < 1e-6 and o.parent is None, (kit, conv, o.name)
            assert any(m.type == 'ARMATURE' and m.object == arms[0] for m in o.modifiers), (kit, conv, o.name)
        pts = importer._all_world_verts(meshes)
        assert abs(pts[:, 2].min()) < 1e-5, (kit, conv)
        J = kit_joints(kit)
        head_joint = {b["name"]: b["head"] for b in SK.BONES}
        worst = max(float(np.linalg.norm(np.array(arms[0].data.bones[n].head_local) - J[head_joint[c]]))
                    for n, c in truth.items() if c)
        assert worst < 1e-4, "%s %s: mapped bone heads are %.6f m off the kit's joints" % (kit, conv, worst)

        sug = kits.ok(*kits.run_job(pr.dir, "suggest_mapping", {}))
        assert sug["convention"] == conv, (kit, conv, sug["convention"])
        bad = {k: (sug["mapping"].get(k, "<absent>"), v) for k, v in truth.items() if sug["mapping"].get(k, "<absent>") != v}
        assert not bad and len(sug["mapping"]) == len(truth), "%s %s mapping differs: %s" % (kit, conv, dict(list(bad.items())[:8]))
        assert sug["unmapped_canonical"] == [] and sug["confidence"] > 0.9, (kit, conv, sug["unmapped_canonical"])
        print("  %s %s: %d bones, unit scale %g, confidence %.2f, bone heads within %.1e m of the joints" % (
            kit, conv, len(truth), imp["orientation_used"]["unit_scale"], sug["confidence"], worst))


def test_rig_imported_all():
    """rig with the mapping: kind imported, every armature bone listed, grip sockets, hands, joints on the
    mapped bones, follow check passed, weights in parity (contracts sections 7 and 8)."""
    for kit, conv in cases():
        pr = rigged_project(kit, conv)
        truth = rigged_kit.expected_mapping(kit, conv)
        parents = {n: p for n, _h, _t, p, _c in rigged_kit.spec_of(kit, conv)}
        mapping = kits.ok(*kits.run_job(pr.dir, "suggest_mapping", {}))["mapping"]
        res = kits.ok(*kits.run_job(pr.dir, "rig", {"mapping": mapping}))
        rig = pr.rig
        assert rig["schema"] == "mpm.rig/1" and rig["kind"] == "imported" and rig["hash"] == res["hash"], (kit, conv)
        bones = rig["bones"]
        assert len(bones) == len(truth) + 2 == res["bones"], (kit, conv, len(bones), len(truth))
        by = {b["name"]: b for b in bones}
        assert set(by) == set(truth) | {"mpm_grip.L", "mpm_grip.R"}, (kit, conv)
        for i, b in enumerate(bones):
            assert b["index"] == i, (kit, conv, b["name"])
            if b["name"] in truth:
                assert b["canonical"] == truth[b["name"]], (kit, conv, b["name"], b["canonical"])
                want = parents[b["name"]]
                assert (bones[b["parent"]]["name"] if b["parent"] >= 0 else None) == want, (kit, conv, b["name"])
        hand = {c: n for n, c in truth.items() if c in ("hand.L", "hand.R")}
        for s in ("L", "R"):
            g = by["mpm_grip." + s]
            assert g["canonical"] == "grip." + s and g["deform"] is False, (kit, conv, g)
            assert bones[g["parent"]]["name"] == hand["hand." + s], (kit, conv, s)
            assert rig["hands"][s] is not None, (kit, conv, s)

        # joints: mapped bone heads are the kit's joints; end joints come from tails (FBX keeps no tails,
        # so only their direction is the file's); hands are the same hand frames
        auto = kits.project(kit, "rig").rig
        J = {k: np.array(v) for k, v in auto["joints"].items()}
        assert set(rig["joints"]) == set(J), (kit, conv, set(J) ^ set(rig["joints"]))
        off = {k: float(np.linalg.norm(np.array(v) - J[k])) for k, v in rig["joints"].items()}
        derived = {"grip_L", "grip_R", "grip_tip_L", "grip_tip_R"}
        worst = max(v for k, v in off.items() if k not in END_JOINTS and k not in derived)
        assert worst < 1e-4, "%s %s: joints %.6f m off the mapped bone heads" % (kit, conv, worst)
        for s in ("L", "R"):
            assert off["grip_" + s] < 1e-3, (kit, conv, s, off["grip_" + s])
            for k in ("palm_normal", "lateral", "hand_axis"):
                d = float(np.dot(rig["hands"][s][k], auto["hands"][s][k]))
                assert d > 0.9999, (kit, conv, s, k, d)
            assert abs(rig["hands"][s]["hand_width"] - auto["hands"][s]["hand_width"]) < 1e-4, (kit, conv, s)
        end_off, end_name = max((off[k], k) for k in END_JOINTS if k in off and k not in derived)

        f = res["follow"]   # the job passed its own gate; these are its thresholds (contracts section 14)
        assert f["moved_fraction"] >= PO.MOVED_MIN and f["worst_drift"] < PO.DRIFT_MAX and f["grow"] < PO.GROW_MAX,             (kit, conv, f)

        gj = parse_glb_json(os.path.join(pr.dir, res["rig_glb"]))
        nodes = [n.get("name") for n in gj["nodes"]]
        for b in bones:
            assert nodes[b["gltf_node"]] == b["name"], (kit, conv, b["name"])
        assert sorted(m["name"] for m in rig["meshes"]) == sorted(m["name"] for m in auto["meshes"]), (kit, conv)

        # rig.blend: section 7 parity on every mesh
        bpy.ops.wm.open_mainfile(filepath=os.path.join(pr.dir, "rig", "rig.blend"))
        arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
        deform = {b.name for b in arm.data.bones if b.use_deform}
        assert [b.name for b in arm.data.bones] == [b["name"] for b in bones], (kit, conv)
        for m in rig["meshes"]:
            o = bpy.data.objects[m["name"]]
            assert len(o.data.vertices) == m["vertices"], (kit, conv, o.name)
            mods = [md for md in o.modifiers]
            assert len(mods) == 1 and mods[0].type == 'ARMATURE' and mods[0].object == arm, (kit, conv, o.name)
            assert {g.name for g in o.vertex_groups} <= deform, (kit, conv, o.name)
            assert o.data.attributes.get("_ORIG_INDEX") is not None, (kit, conv, o.name)
            for v in o.data.vertices:
                ws = [e.weight for e in v.groups]
                assert 1 <= len(ws) <= 4 and abs(sum(ws) - 1.0) < 1e-5, (kit, conv, o.name, v.index, ws)
        print("  %s %s: %d bones, %.1f s, follow %s, joints within %.1e m, end joints within %.3f m (%s)" % (
            kit, conv, len(bones), res["seconds"], {k: round(v, 4) for k, v in f.items()}, worst, end_off, end_name))


def test_unknown_convention():
    """Bone names of no known convention: nothing is suggested, and rigging without a mapping is refused."""
    kit = cases()[0][0]
    src = rigged_project(kit, "mixamo")
    tmp = tempfile.mkdtemp(prefix="mpm_unknown_")
    try:
        os.makedirs(os.path.join(tmp, "rig"))
        bpy.ops.wm.open_mainfile(filepath=os.path.join(src.dir, "rig", "scene.blend"))
        arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
        for i, b in enumerate(arm.data.bones):
            b.name = "bone_%03d" % i
        sug = imported.suggest_mapping(arm)
        assert sug["convention"] == "unknown" and sug["mapping"] == {} and sug["confidence"] == 0.0, sug
        assert len(sug["unmapped_canonical"]) == len(SK.BONES)
        bpy.ops.wm.save_as_mainfile(filepath=os.path.join(tmp, "rig", "scene.blend"), compress=True)
        res = kits.ok(*kits.run_job(tmp, "suggest_mapping", {}))
        assert res["convention"] == "unknown" and res["mapping"] == {} and res["confidence"] == 0.0, res
        code, res, err, _p = kits.run_job(tmp, "rig", {"mapping": {}})
        assert code == 1 and res is None and err is not None and err["code"] == "E_ARGS", (code, err)
    finally:
        bpy.ops.wm.read_factory_settings(use_empty=True)
        shutil.rmtree(tmp, ignore_errors=True)
