# SPDX-License-Identifier: GPL-3.0-or-later
"""WP7 converter acceptance on a synthetic BVH (no third-party mocap data in the repo).
Optional: MPM_BANDAI_DIR=<.../Bandai-Namco-Research-Motiondataset-1/data> also converts a real clip."""
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile

import numpy as np

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(REPO, "engine"))
from mpm.convert import clipio, convert  # noqa: E402

# (name, parent, offset cm) - T-pose rest, BVH Y up, faces +Z, figure's left = +X
SKEL = [
    ("Hips", None, (0, 0, 0)), ("Spine", "Hips", (0, 10, 0)), ("Chest", "Spine", (0, 25, 0)),
    ("Neck", "Chest", (0, 20, 0)), ("Head", "Neck", (0, 8, 0)),
    ("Shoulder_L", "Chest", (5, 18, 0)), ("UpperArm_L", "Shoulder_L", (12, 0, 0)),
    ("LowerArm_L", "UpperArm_L", (28, 0, 0)), ("Hand_L", "LowerArm_L", (25, 0, 0)),
    ("Shoulder_R", "Chest", (-5, 18, 0)), ("UpperArm_R", "Shoulder_R", (-12, 0, 0)),
    ("LowerArm_R", "UpperArm_R", (-28, 0, 0)), ("Hand_R", "LowerArm_R", (-25, 0, 0)),
    ("UpperLeg_L", "Hips", (9, -2, 0)), ("LowerLeg_L", "UpperLeg_L", (0, -43, 0)),
    ("Foot_L", "LowerLeg_L", (0, -42, 0)), ("Toes_L", "Foot_L", (0, -8, 12)),
    ("UpperLeg_R", "Hips", (-9, -2, 0)), ("LowerLeg_R", "UpperLeg_R", (0, -43, 0)),
    ("Foot_R", "LowerLeg_R", (0, -42, 0)), ("Toes_R", "Foot_R", (0, -8, 12)),
]
ENDS = {"Head": (0, 20, 0), "Hand_L": (9, 0, 0), "Hand_R": (-9, 0, 0), "Toes_L": (0, 0, 6), "Toes_R": (0, 0, 6)}
FPS, N = 30, 60


def write_bvh(path):
    kids = {}
    for n, p, _o in SKEL:
        kids.setdefault(p, []).append(n)
    off = {n: o for n, _p, o in SKEL}
    lines = ["HIERARCHY"]

    def emit(n, depth):
        pad = "  " * depth
        lines.append("%s%s %s" % (pad, "ROOT" if depth == 0 else "JOINT", n))
        lines.append(pad + "{")
        lines.append("%s  OFFSET %g %g %g" % ((pad,) + off[n]))
        ch = "CHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation" if depth == 0 \
            else "CHANNELS 3 Zrotation Xrotation Yrotation"
        lines.append(pad + "  " + ch)
        for k in kids.get(n, []):
            emit(k, depth + 1)
        if n in ENDS:
            lines.extend([pad + "  End Site", pad + "  {", "%s    OFFSET %g %g %g" % ((pad,) + ENDS[n]), pad + "  }"])
        lines.append(pad + "}")

    emit("Hips", 0)
    lines.extend(["MOTION", "Frames: %d" % N, "Frame Time: %.7f" % (1.0 / FPS)])
    order = []

    def walk(n):
        order.append(n)
        for k in kids.get(n, []):
            walk(k)

    walk("Hips")
    for f in range(N):
        t = max(0.0, (f - 20) / 39.0)
        vals = {n: [0.0, 0.0, 0.0] for n in order}          # Z, X, Y rotations
        vals["UpperArm_L"][0] = -80 + 140 * t               # neutral arm down, then raised
        vals["UpperArm_R"][0] = 80.0
        vals["Hips"][2] = 30.0 * t                          # turn 30 deg about Y
        if f >= 40:
            vals["UpperLeg_L"][1] = -40.0                   # lift the left leg
            vals["LowerLeg_L"][1] = 60.0
        row = [0.0, 95.0, 2.0 * f]                          # walk forward along +Z
        for n in order:
            row += vals[n]
        lines.append(" ".join("%.5f" % v for v in row))
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")


def q_apply(q, v):
    w, x, y, z = q
    u = np.array([x, y, z])
    v = np.asarray(v, float)
    return v + 2 * np.cross(u, np.cross(u, v) + w * v)


def _synth():
    d = tempfile.mkdtemp(prefix="mpm_bvh_")
    p = os.path.join(d, "dataset-1_raise-arm_normal_001.bvh")
    write_bvh(p)
    return d, p


def test_convert_synthetic():
    d, p = _synth()
    try:
        c = convert.convert_bvh(p, "bandai")
        names, fr, ct = c["names"], c["frames"], c["contacts"]
        J = {n: i for i, n in enumerate(names)}
        assert len(names) == 26 and fr.shape == (30, 26, 7), fr.shape
        assert c["meta"] == {"move": "raise-arm", "style": "normal", "take": 1}
        assert np.abs(fr[:, J["pelvis"], :2]).max() < 1e-4                    # pelvis xy at 0
        assert np.all(fr[:, J["hip_L"], 0] > fr[:, J["hip_R"], 0])              # left hip at +X
        assert np.abs(fr[:, J["hip_L"], 1] - fr[:, J["hip_R"], 1]).max() < 1e-4  # hip line along X
        assert abs(float(fr[:5, [J["ball_L"], J["toe_L"]], 2].min())) < 0.02     # floor at the feet
        assert all(int(b) == 3 for b in ct[:9]), ct[:12]                        # both feet down early
        assert all(int(b) & 1 == 0 for b in ct[22:]), ct[20:]                    # left foot lifted late
        for i in range(8):                                                      # neutral frames
            fwd = q_apply(fr[i, J["head"], 3:], (0, -1, 0))
            assert fwd @ np.array([0, -1, 0]) > math.cos(math.radians(2)), (i, fwd)
            palm = q_apply(fr[i, J["wrist_L"], 3:], (0, 0, -1))
            assert palm[0] < -0.9, (i, palm)                                    # left palm faces the thigh
        arm = fr[-1, J["wrist_L"], :3] - fr[-1, J["shoulder_L"], :3]
        assert arm[2] > 0.3, arm                                                # left arm raised at the end
        assert max(c["key_frames"]) >= 20, c["key_frames"]
        # files: clip + index merge, and a copy for the TS reader test
        pack = os.path.join(d, "pack")
        meta = {"pack": "synth", "title": "Synthetic", "license": "GPL-3.0-or-later", "exportable": True}
        clipio.add_to_pack(pack, meta, c)
        c2 = dict(c, id="dataset-1_raise-arm_normal_002")
        clipio.add_to_pack(pack, meta, c2)
        idx = json.load(open(os.path.join(pack, "index.json"), encoding="utf-8"))
        assert [e["id"] for e in idx["clips"]] == ["dataset-1_raise-arm_normal_001", "dataset-1_raise-arm_normal_002"]
        body, cont = clipio.read_clip(os.path.join(pack, "clips", "dataset-1_raise-arm_normal_001.f32"))
        assert np.array_equal(body, fr) and np.array_equal(cont, ct)
        g = os.path.join(REPO, "tests", "golden", "convert")
        os.makedirs(g, exist_ok=True)
        shutil.copy(os.path.join(pack, "clips", "dataset-1_raise-arm_normal_001.f32"), os.path.join(g, "synth.f32"))
        json.dump({"joints": names, "frames": int(fr.shape[0]), "frame5_head": [float(x) for x in fr[5, J["head"]]],
                   "contacts": [int(x) for x in ct]}, open(os.path.join(g, "synth.json"), "w"))
    finally:
        shutil.rmtree(d, ignore_errors=True)


def test_convert_job_subprocess():
    import bpy
    d, p = _synth()
    try:
        jp = os.path.join(d, "job.json")
        json.dump({"schema": "mpm.job/1", "id": "c", "type": "convert_clip", "project_dir": d,
                   "args": {"source": None, "files": [p, os.path.join(d, "missing.bvh")], "pack_dir": os.path.join(d, "pack"),
                            "pack": {"pack": "synth", "title": "Synthetic", "license": "x"}}}, open(jp, "w"))
        r = subprocess.run([bpy.app.binary_path, "-b", "--factory-startup", "--python-exit-code", "1", "-P",
                            os.path.join(REPO, "engine", "jobs", "convert_clip.py"), "--", jp],
                           capture_output=True, text=True, timeout=300)
        res = [l for l in r.stdout.splitlines() if l.startswith("@@result")]
        assert r.returncode == 0 and len(res) == 1, r.stdout[-2000:] + r.stderr[-1000:]
        out = json.loads(res[0][len("@@result"):])
        assert out["clips"] == ["dataset-1_raise-arm_normal_001"] and len(out["failed"]) == 1
    finally:
        shutil.rmtree(d, ignore_errors=True)


def test_pack_ids_unique_and_mixed_joints():
    """Same-named takes from two folders get distinct ids; re-converting a file keeps its id; a clip
    whose joint list differs from the pack's carries its own `joints`."""
    d, p = _synth()
    try:
        pack = os.path.join(d, "pack")
        meta = {"pack": "mine", "title": "My clips", "license": "Your own"}
        conv = convert.convert_bvh(p, "bandai")
        a = clipio.add_to_pack(pack, meta, conv, "subject1/take.bvh")
        b = clipio.add_to_pack(pack, meta, conv, "subject2/take.bvh")
        a2 = clipio.add_to_pack(pack, meta, conv, "subject1/take.bvh")
        c = clipio.add_to_pack(pack, meta, conv, "x/subject2/take.bvh")
        assert a == conv["id"] and b == "subject2_" + conv["id"] and a2 == a, (a, b, a2)
        assert c == "subject2_%s_2" % conv["id"], c
        other = dict(conv, id="cmu_take", names=conv["names"][:-1], frames=conv["frames"][:, :-1])
        e = clipio.add_to_pack(pack, meta, other, "cmu_take.bvh")
        index = json.load(open(os.path.join(pack, "index.json"), encoding="utf-8"))
        by = {x["id"]: x for x in index["clips"]}
        assert len(by) == 4 and "joints" not in by[a] and by[e]["joints"] == conv["names"][:-1], by[e].get("joints")
        body, _ct = clipio.read_clip(os.path.join(pack, "clips", e + ".f32"))
        assert body.shape[1] == len(conv["names"]) - 1
    finally:
        shutil.rmtree(d, ignore_errors=True)


def test_convert_archive_extract():
    """Zip input (LaFAN1 / CMU are user-supplied archives): .bvh members only, filtered, no path escapes."""
    import zipfile
    sys.path.insert(0, os.path.join(REPO, "engine", "jobs"))
    import convert_clip as CJ
    d, p = _synth()
    try:
        z = os.path.join(d, "pack.zip")
        data = open(p, "rb").read()
        with zipfile.ZipFile(z, "w") as zf:
            zf.writestr("lafan1/aiming1_subject1.bvh", data)
            zf.writestr("lafan1/walk1_subject1.bvh", data)
            zf.writestr("../escape_aiming.bvh", data)
            zf.writestr("lafan1/readme.txt", "x")
        out = CJ.extract_bvh([z], os.path.join(d, "raw"), include=["aiming"])
        rel = sorted(os.path.relpath(f, os.path.join(d, "raw")).replace("\\", "/") for f in out)
        assert rel == ["escape_aiming.bvh", "lafan1/aiming1_subject1.bvh"], rel
        assert not os.path.exists(os.path.join(d, "escape_aiming.bvh"))
        bad = os.path.join(d, "bad.zip")
        open(bad, "wb").write(b"not a zip")
        try:
            CJ.extract_bvh([bad], os.path.join(d, "raw2"))
        except Exception as e:  # noqa: BLE001
            assert getattr(e, "code", None) == "E_IMPORT_FAILED", e
        else:
            raise AssertionError("a bad zip was accepted")
    finally:
        shutil.rmtree(d, ignore_errors=True)


def test_convert_real_bandai_optional():
    root = os.environ.get("MPM_BANDAI_DIR")
    if not root:
        print("  (skipped: set MPM_BANDAI_DIR to check a real Bandai Namco clip)")
        return
    c = convert.convert_bvh(os.path.join(root, "dataset-1_kick_normal_001.bvh"), None)
    assert c["source"] == "bandai" and len(c["names"]) == 26 and c["frames"].shape[0] == 179, c["frames"].shape
    J = {n: i for i, n in enumerate(c["names"])}
    fr = c["frames"]
    palm = q_apply(fr[0, J["wrist_L"], 3:], (0, 0, -1))
    print("  real kick: frames %d, key frames %s, contacts first/last %s/%s, frame-0 L palm %s" % (
        fr.shape[0], c["key_frames"], int(c["contacts"][0]), int(c["contacts"][-1]), np.round(palm, 2)))
    assert palm[0] < -0.7, palm
