# SPDX-License-Identifier: GPL-3.0-or-later
"""Rig build, skinning, posing and export on real character kits (tests/engine/kits.py): the rig the real
`rig` job writes for each kit, from the joints the engine itself found."""
import json
import math
import os
import random
import sys

import numpy as np

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(REPO, "engine"))
sys.path.insert(0, os.path.join(REPO, "engine", "jobs"))
import kits  # noqa: E402
from mpm import pose as PO  # noqa: E402
from mpm import skeleton as SK  # noqa: E402
from mpm.rig.export import parse_glb_json  # noqa: E402


def _weights(o, names):
    gi = {g.index: g.name for g in o.vertex_groups}
    return [{gi[e.group]: e.weight for e in v.groups if gi.get(e.group) in names} for v in o.data.vertices]


def test_skeleton_matches_ts_counts():
    assert len(SK.JOINTS) == 68 and len(SK.BONES) == 53
    assert [b["name"] for b in SK.BONES[:5]] == ["hips", "spine", "chest", "neck", "head"]
    assert SK.bone_index("upper_arm.L") < SK.bone_index("upper_arm.R")
    assert SK.mirror_name("thumb.01.L") == "thumb.01.R" and SK.mirror_name("hips") == "hips"


def test_rig_files_of_every_kit():
    for name in kits.need():
        pr = kits.project(name, "rig")
        res, rig = pr.result("rig"), pr.rig
        assert rig["schema"] == "mpm.rig/1" and rig["kind"] == "auto" and len(rig["bones"]) == 53, name
        assert all(isinstance(b["gltf_node"], int) for b in rig["bones"])
        assert all((b["radius_m"] is not None) == SK.is_finger_bone(b["name"]) for b in rig["bones"])
        for b in rig["bones"]:
            if b["radius_m"] is not None:
                assert 0.002 < b["radius_m"] < 0.03, "%s: %s radius %.1f mm" % (name, b["name"], b["radius_m"] * 1000)
        assert 1.5 < rig["height_m"] < 2.3 and abs(rig["floor_z"]) < 1e-3, (name, rig["height_m"], rig["floor_z"])
        assert rig["hands"]["L"] and rig["hands"]["R"]
        gj = parse_glb_json(os.path.join(pr.dir, "rig", "rig.glb"))
        assert len(gj["skins"][0]["joints"]) == 53
        for f in ("rig.blend", "rig.json", "rig.glb", "markers.json", "import.json", "preview.glb"):
            assert os.path.exists(os.path.join(pr.dir, "rig", f)), (name, f)
        f = res["follow"]
        assert f["moved_fraction"] >= PO.MOVED_MIN and f["worst_drift"] < PO.DRIFT_MAX and f["grow"] < PO.GROW_MAX
        print("  %s: follow %s, unreached vertices %s, %.1f s" % (
            name, {k: round(v, 4) for k, v in f.items()}, res.get("blind_vertices"), res["seconds"]))
        assert res["seconds"] < 120


def test_bones_follow_the_joints_and_the_roll_rule():
    from mathutils import Vector
    for name in kits.need()[:3]:
        arm, _meshes, rig = kits.open_rig(name)
        J = SK.derive_joints(kits.project(name, "markers").markers)
        hands = SK.hand_frames(J)
        bones = arm.data.bones
        for b in SK.BONES:
            bb = bones[b["name"]]
            assert (Vector(J[b["head"]]) - bb.head_local).length < 1e-5, (name, b["name"])
            assert (Vector(J[b["tail"]]) - bb.tail_local).length < 1e-5, (name, b["name"])
            side = SK.side_of(b["name"])
            if side and (SK.is_finger_bone(b["name"]) or b["name"].startswith("grip.")):
                # contracts section 10 finger frame: z = normalize(n - d * dot(n, d))
                z = bb.matrix_local.to_3x3().col[2].normalized()
                d = (bb.tail_local - bb.head_local).normalized()
                n = Vector(hands[side]["palm_normal"])
                zf = (n - d * n.dot(d)).normalized()
                assert z.dot(zf) > 0.99, (name, b["name"], z.dot(zf))
        for k, v in rig["joints"].items():
            assert np.linalg.norm(np.array(v) - np.array(J[k])) < 1e-5, (name, k)


def test_skin_parity_on_every_kit():
    """Contracts section 7: 1 to 4 influences summing to 1, one Armature modifier first, _ORIG_INDEX."""
    names = {b["name"] for b in SK.BONES if b["deform"]}
    for name in kits.need():
        arm, meshes, _rig = kits.open_rig(name)
        assert meshes, name
        for o in meshes:
            for i, w in enumerate(_weights(o, names)):
                assert 1 <= len(w) <= 4, (name, o.name, i, w)
                assert abs(sum(w.values()) - 1.0) < 1e-5, (name, o.name, i, w)
            mods = [m for m in o.modifiers if m.type == 'ARMATURE']
            assert len(mods) == 1 and o.modifiers[0].type == 'ARMATURE', (name, o.name)
            assert mods[0].object == arm and not mods[0].use_deform_preserve_volume and not mods[0].use_bone_envelopes
            assert o.data.attributes.get("_ORIG_INDEX") is not None, (name, o.name)


def test_fingertips_belong_to_their_finger():
    names = {b["name"] for b in SK.BONES if b["deform"]}
    for name in kits.need(hard=False):
        _arm, meshes, rig = kits.open_rig(name)
        J = rig["joints"]
        for s in ("L", "R"):
            for f in ("index", "pinky", "thumb"):
                tip = np.array(J["%s_tip_%s" % (f, s)])
                bone = "%s.03.%s" % (f, s)
                near = on = 0
                for o in meshes:
                    W = _weights(o, names)
                    for i, v in enumerate(o.data.vertices):
                        if np.linalg.norm(np.array(v.co) - tip) < 0.008:
                            near += 1
                            on += W[i].get(bone, 0.0) > 0.5
                assert near, "%s: no vertices near %s_tip_%s" % (name, f, s)
                assert near - on <= max(1, 0.2 * near), "%s: only %d of %d vertices at the %s %s tip follow %s" % (
                    name, on, near, s, f, bone)


def test_pose_identity_and_head_rule():
    import bpy
    from mathutils import Quaternion, Vector
    name = kits.need()[0]
    arm, meshes, _rig = kits.open_rig(name)
    dg = bpy.context.evaluated_depsgraph_get()
    PO.apply_pose_state(arm, {})
    for o in meshes:
        ev = o.evaluated_get(dg)
        me = ev.to_mesh()
        d = max((a.co - b.co).length for a, b in zip(o.data.vertices, me.vertices))
        ev.to_mesh_clear()
        assert d < 1e-5, "identity pose moved the mesh by %.2e" % d
    rnd = random.Random(42)
    deltas = {}
    for i in range(len(arm.data.bones)):
        ax = Vector((rnd.uniform(-1, 1), rnd.uniform(-1, 1), rnd.uniform(-1, 1))).normalized()
        q = Quaternion(ax, math.radians(rnd.uniform(0, 40)))
        deltas[i] = [q.w, q.x, q.y, q.z]
    posed = PO.apply_pose_state(arm, deltas, root_offset=(0.01, -0.02, 0.03))
    bones = list(arm.data.bones)
    for i, b in enumerate(bones):
        pb = arm.pose.bones[b.name]
        Db, h = posed[i]
        assert (pb.head - h).length < 1e-5, (b.name, (pb.head - h).length)
        if b.parent is not None:
            Dp, hp = posed[bones.index(b.parent)]
            assert (pb.head - (hp + Dp @ (b.head_local - b.parent.head_local))).length < 1e-5, b.name
        R = pb.matrix.to_3x3().normalized()
        Rexp = (Db @ b.matrix_local.to_3x3()).normalized()
        assert max(abs(R[r][c] - Rexp[r][c]) for r in range(3) for c in range(3)) < 1e-5, b.name


# A strong but natural pose: both arms out and bent, a deep knee bend, a twist, curled fingers.
ACTION = {"upper_arm.L": 55.0, "forearm.L": -70.0, "upper_arm.R": -35.0, "forearm.R": -90.0, "thigh.L": -70.0,
          "shin.L": 85.0, "thigh.R": 20.0, "shin.R": 30.0, "spine": 15.0, "chest": 10.0, "head": -15.0,
          "index.01.R": 60.0, "index.02.R": 70.0, "middle.01.R": 60.0, "middle.02.R": 70.0, "thumb.02.L": 30.0}


def test_posed_skin_does_not_tear():
    """Skinning quality on real meshes: in a strong pose almost no edge may stretch far. Bad weights
    (a vertex following the wrong limb) show up as edges several times their rest length."""
    import bpy
    for name in kits.need():
        arm, meshes, rig = kits.open_rig(name)
        PO.apply_pose_state(arm, kits.local_x_deltas(rig, ACTION))
        dg = bpy.context.evaluated_depsgraph_get()
        ratios = []
        for o in meshes:
            ev = o.evaluated_get(dg)
            me = ev.to_mesh()
            r = np.array([v.co[:] for v in o.data.vertices])
            p = np.array([v.co[:] for v in me.vertices])
            ed = np.array([e.vertices[:] for e in o.data.edges], np.int64).reshape(-1, 2)
            ev.to_mesh_clear()
            l0 = np.linalg.norm(r[ed[:, 0]] - r[ed[:, 1]], axis=1)
            l1 = np.linalg.norm(p[ed[:, 0]] - p[ed[:, 1]], axis=1)
            ok = l0 > 1e-4
            ratios.append(l1[ok] / l0[ok])
        ratios = np.concatenate(ratios)
        torn = float((ratios > 3.0).mean())
        print("  %s: edge stretch median %.2f, 99th percentile %.2f, max %.1f, over 3x: %.3f %%" % (
            name, np.median(ratios), np.percentile(ratios, 99), ratios.max(), torn * 100))
        if name in kits.names(hard=True) or kits.kit(name).get("cloth"):
            # Known limit: draped cloth that is part of the body (coat tails, a tabard) and long claws
            # stretch in a deep lunge. It must stay a small share.
            assert torn < 0.04, "%s: %.2f %% of edges stretch more than 3x" % (name, torn * 100)
        else:
            assert np.percentile(ratios, 99) < 2.0, (name, float(np.percentile(ratios, 99)))
            assert torn < 0.003, "%s: %.2f %% of edges stretch more than 3x" % (name, torn * 100)
        chk = PO.follow_check(arm, meshes, rig["height_m"])
        PO.gate(chk, posed_any=True)


def test_hash_stable_across_builds():
    name = kits.need()[0]
    first = kits.project(name, "rig").rig["hash"]
    again = kits.scratch_copy(name, "rig")
    res = kits.ok(*kits.run_job(again.dir, "rig", {"markers": again.markers}))
    assert res["hash"] == first == again.rig["hash"], "rig hash not stable across runs"


def test_rig_job_reads_markers_file_and_reports_missing_markers():
    name = kits.need()[0]
    pr = kits.scratch_copy(name, "rig")
    res = kits.ok(*kits.run_job(pr.dir, "rig", {}))  # no args: rig/markers.json
    assert res["hash"] == kits.project(name, "rig").rig["hash"]
    m = dict(pr.markers)
    del m["knee_L"]
    code, _res, err, _p = kits.run_job(pr.dir, "rig", {"markers": m})
    assert code != 0 and err and err["code"] == "E_MARKERS_INCOMPLETE", err
    with open(os.path.join(pr.dir, "rig", "rig.json"), encoding="utf-8") as fh:
        assert json.load(fh)["hash"] == res["hash"], "a failed rig job must leave the old rig in place"
