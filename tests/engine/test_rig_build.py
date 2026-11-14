# SPDX-License-Identifier: GPL-3.0-or-later
"""WP4c acceptance: rig build, skinning, pose application, export, rig job.
Markers are the fixture TRUTH editable joints, so this tests building, not marker finding."""
import json
import math
import os
import random
import shutil
import subprocess
import sys
import tempfile
import time

import numpy as np

import bpy
from mathutils import Matrix, Quaternion, Vector

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(REPO, "engine"))
sys.path.insert(0, os.path.join(REPO, "engine", "jobs"))
from mpm import pose as PO  # noqa: E402
from mpm import skeleton as SK  # noqa: E402
from mpm.rig import build, export  # noqa: E402
from mpm.rig import skin as SKN  # noqa: E402
from mpm.rig.export import parse_glb_json  # noqa: E402
import rig as RIGJOB  # noqa: E402  (engine/jobs/rig.py)
from test_markers import fx, load_normalised, load_truth  # noqa: E402

BLENDER = bpy.app.binary_path


def truth_markers(name):
    meshes, joints = load_normalised(name)
    editable = load_truth(name)["editable"]
    return meshes, joints, {k: joints[k].tolist() for k in editable}


def build_skinned(name):
    meshes, joints, markers = truth_markers(name)
    J = SK.derive_joints(markers)
    hands = SK.hand_frames(J)
    zs = [(o.matrix_world @ v.co).z for o in meshes for v in o.data.vertices]
    H = float(max(zs) - min(zs))
    arm = build.build_armature(J, hands)
    rep = SKN.skin(meshes, arm, J, H)
    return meshes, arm, J, hands, H, joints, rep


def weights(o, names):
    gi = {g.index: g.name for g in o.vertex_groups}
    out = []
    for v in o.data.vertices:
        out.append({gi[e.group]: e.weight for e in v.groups if gi.get(e.group) in names})
    return out


# ---------------------------------------------------------------------------------------------------

def test_derive_joints_matches_truth_apose():
    _m, joints, markers = truth_markers("apose")
    J = SK.derive_joints(markers)
    assert len(J) == 68
    worst = max(float(np.linalg.norm(J[k] - joints[k])) for k in joints)
    assert worst < 1e-6, "derived joints differ from truth by %.2e m" % worst


def test_skeleton_matches_ts_counts():
    assert len(SK.JOINTS) == 68 and len(SK.BONES) == 53
    assert [b["name"] for b in SK.BONES[:5]] == ["hips", "spine", "chest", "neck", "head"]
    assert SK.bone_index("upper_arm.L") < SK.bone_index("upper_arm.R")
    assert SK.mirror_name("thumb.01.L") == "thumb.01.R" and SK.mirror_name("hips") == "hips"


def test_build_and_skin_apose():
    t0 = time.time()
    meshes, arm, J, hands, H, joints, rep = build_skinned("apose")
    print("  build+skin %.1f s, blind vertices %d, hand vertices %d" % (time.time() - t0, rep["blind"], rep["hand_vertices"]))
    bones = arm.data.bones
    for b in SK.BONES:
        bb = bones[b["name"]]
        assert (Vector(J[b["head"]]) - bb.head_local).length < 1e-6, b["name"]
        assert (Vector(J[b["tail"]]) - bb.tail_local).length < 1e-6, b["name"]
        side = SK.side_of(b["name"])
        if side and (SK.is_finger_bone(b["name"]) or b["name"].startswith("grip.")):
            # contracts section 10 finger frame: z = normalize(n - d * dot(n, d))
            z = bb.matrix_local.to_3x3().col[2].normalized()
            d = (bb.tail_local - bb.head_local).normalized()
            n = Vector(hands[side]["palm_normal"])
            zf = (n - d * n.dot(d)).normalized()
            assert z.dot(zf) > 0.99, (b["name"], z.dot(zf))
    names = {b["name"] for b in SK.BONES if b["deform"]}
    for o in meshes:
        W = weights(o, names)
        for i, w in enumerate(W):
            assert 1 <= len(w) <= 4, (o.name, i, w)
            assert abs(sum(w.values()) - 1.0) < 1e-5, (o.name, i, w)
        tip = np.array(joints["index_tip_L"])
        near = [i for i, v in enumerate(o.data.vertices) if np.linalg.norm(np.array(v.co) - tip) < 0.01]
        assert near, "no vertices near index_tip_L"
        on = sum(1 for i in near if W[i].get("index.03.L", 0.0) > 0.5)
        assert on / len(near) > 0.8, (on, len(near))
        mods = [m for m in o.modifiers if m.type == 'ARMATURE']
        assert len(mods) == 1 and o.modifiers[0].type == 'ARMATURE'
        assert not mods[0].use_deform_preserve_volume and not mods[0].use_bone_envelopes
        assert o.data.attributes.get("_ORIG_INDEX") is not None


def test_pose_identity_and_head_rule():
    meshes, arm, J, hands, H, joints, rep = build_skinned("apose")
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
            p = bones.index(b.parent)
            Dp, hp = posed[p]
            exp = hp + Dp @ (b.head_local - b.parent.head_local)
            assert (pb.head - exp).length < 1e-5, b.name
        R = pb.matrix.to_3x3().normalized()
        Rexp = (Db @ b.matrix_local.to_3x3()).normalized()
        assert max(abs(R[r][c] - Rexp[r][c]) for r in range(3) for c in range(3)) < 1e-5, b.name


def _rig_in(name, project):
    meshes, joints, markers = truth_markers(name)
    return RIGJOB.build_auto_rig(project, markers)


def test_export_and_hash_stable():
    tmp = tempfile.mkdtemp(prefix="mpm_rig_")
    try:
        r1 = _rig_in("apose", os.path.join(tmp, "a"))
        print("  rig job (in-process) %.1f s, follow %s" % (r1["seconds"], r1["follow"]))
        assert r1["seconds"] < 60
        rig = json.load(open(os.path.join(tmp, "a", "rig", "rig.json"), encoding="utf-8"))
        assert rig["schema"] == "mpm.rig/1" and rig["kind"] == "auto" and len(rig["bones"]) == 53
        assert all(isinstance(b["gltf_node"], int) for b in rig["bones"])
        assert all((b["radius_m"] is not None) == SK.is_finger_bone(b["name"]) for b in rig["bones"])
        gj = parse_glb_json(os.path.join(tmp, "a", "rig", "rig.glb"))
        assert len(gj["skins"][0]["joints"]) == 53
        assert os.path.exists(os.path.join(tmp, "a", "rig", "rig.blend"))
        r2 = _rig_in("apose", os.path.join(tmp, "b"))
        assert r1["hash"] == r2["hash"], "rig hash not stable across runs"
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_other_fixtures_build():
    tmp = tempfile.mkdtemp(prefix="mpm_rig_")
    try:
        for name in ("tpose", "curled", "mitten"):
            r = _rig_in(name, os.path.join(tmp, name))
            print("  %s: %.1f s, follow %s" % (name, r["seconds"], r["follow"]))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _run_job(project, jtype, args):
    jp = os.path.join(project, "cache", "%s.job.json" % jtype)
    os.makedirs(os.path.dirname(jp), exist_ok=True)
    with open(jp, "w", encoding="utf-8") as fh:
        json.dump({"schema": "mpm.job/1", "id": jtype, "type": jtype, "project_dir": project, "args": args}, fh)
    p = subprocess.run([BLENDER, "-b", "--factory-startup", "--python-exit-code", "1", "-P",
                        os.path.join(REPO, "engine", "jobs", jtype + ".py"), "--", jp],
                       capture_output=True, text=True, timeout=600)
    res = [l for l in p.stdout.splitlines() if l.startswith("@@result")]
    errs = [l for l in p.stdout.splitlines() if l.startswith("@@error")]
    return p.returncode, res, errs, p


def test_rig_job_end_to_end():
    tmp = tempfile.mkdtemp(prefix="mpm_rigjob_")
    try:
        os.makedirs(os.path.join(tmp, "source"))
        shutil.copy(fx("apose"), os.path.join(tmp, "source", "apose.fbx"))
        for f in os.listdir(os.path.dirname(fx("apose"))):
            if f.endswith(".png"):
                shutil.copy(os.path.join(os.path.dirname(fx("apose")), f), os.path.join(tmp, "source", f))
        code, res, errs, p = _run_job(tmp, "import", {"file": "source/apose.fbx"})
        assert code == 0 and len(res) == 1 and not errs, p.stdout[-2000:] + p.stderr[-2000:]
        _m, _j, markers = truth_markers("apose")
        os.makedirs(os.path.join(tmp, "rig"), exist_ok=True)
        with open(os.path.join(tmp, "rig", "markers.json"), "w", encoding="utf-8") as fh:
            json.dump({"schema": "mpm.markers/1",
                       "markers": {k: {"p": v, "confidence": 1.0, "source": "user"} for k, v in markers.items()}}, fh)
        code, res, errs, p = _run_job(tmp, "rig", {})
        assert code == 0 and len(res) == 1 and not errs, p.stdout[-3000:] + p.stderr[-2000:]
        for f in ("rig.glb", "rig.json", "rig.blend"):
            assert os.path.exists(os.path.join(tmp, "rig", f)), f
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
