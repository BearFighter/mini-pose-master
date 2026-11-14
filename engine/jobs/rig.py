# SPDX-License-Identifier: GPL-3.0-or-later
"""Job `rig`: build the canonical rig from markers (or map an imported rig), weight, self-check,
export rig.glb / rig.json / rig.blend (contracts sections 7, 8, 16)."""
import json
import math
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import bpy  # noqa: E402
from mathutils import Matrix  # noqa: E402

from mpm import pose as PO  # noqa: E402
from mpm import protocol  # noqa: E402
from mpm import skeleton as SK  # noqa: E402
from mpm.rig import build, export  # noqa: E402
from mpm.rig import skin as SKN  # noqa: E402


def _markers(job):
    m = job["args"].get("markers")
    if m is None:
        path = os.path.join(job["project_dir"], "rig", "markers.json")
        if not os.path.exists(path):
            raise protocol.MpmError("E_MARKERS_INCOMPLETE", "no markers given and rig/markers.json is missing")
        with open(path, encoding="utf-8") as fh:
            m = json.load(fh).get("markers", {})
    return {k: (v["p"] if isinstance(v, dict) else v) for k, v in m.items()}


def rig_meshes():
    """Meshes to rig: the proxies when the model was decimated for editing, else all meshes."""
    objs = [o for o in bpy.data.objects if o.type == 'MESH']
    prox = [o for o in objs if "mpm_proxy_of" in o]
    return prox or objs


def self_test_deltas(arm):
    """upper_arm.L +40 deg and thigh.R -30 deg about each bone's local X, as armature-space deltas."""
    out = {}
    for name, ang in (("upper_arm.L", 40.0), ("thigh.R", -30.0)):
        b = arm.data.bones[name]
        R = b.matrix_local.to_3x3()
        q = (R @ Matrix.Rotation(math.radians(ang), 3, 'X') @ R.transposed()).to_quaternion()
        out[arm.data.bones.find(name)] = [q.w, q.x, q.y, q.z]
    return out


def build_auto_rig(project_dir, markers):
    """Shared by the job and the tests: build + skin + self-check + export. Returns the result dict."""
    t0 = time.time()
    for o in list(bpy.data.objects):  # auto-rigging replaces any rig the model came with
        if o.type == 'ARMATURE':
            bpy.data.objects.remove(o, do_unlink=True)
    meshes = rig_meshes()
    for o in meshes:
        for m in list(o.modifiers):
            if m.type == 'ARMATURE':
                o.modifiers.remove(m)
    try:
        J = SK.derive_joints(markers)
    except KeyError as e:
        raise protocol.MpmError("E_MARKERS_INCOMPLETE", str(e))
    hands = SK.hand_frames(J)
    zs = [(o.matrix_world @ v.co).z for o in meshes for v in o.data.vertices]
    H = float(max(zs) - min(zs))
    protocol.progress("build", 0.10, "building the armature")
    arm = build.build_armature(J, hands)
    protocol.progress("skin", 0.20, "weighting")
    rep = SKN.skin(meshes, arm, J, H)
    protocol.progress("self_check", 0.75, "checking the mesh follows the skeleton")
    PO.apply_pose_state(arm, self_test_deltas(arm))
    chk = PO.follow_check(arm, meshes, H)
    PO.gate(chk)
    PO.rest_pose(arm)
    protocol.progress("export", 0.85, "exporting rig.glb")
    rig = export.export_rig(arm, meshes, project_dir, J, hands, "auto")
    return {"rig_json": "rig/rig.json", "rig_glb": "rig/rig.glb", "follow": chk,
            "bones": len(rig["bones"]), "blind_vertices": rep["blind"],
            "hand_vertices": rep["hand_vertices"], "hash": rig["hash"],
            "seconds": round(time.time() - t0, 1)}


def main(job):
    pd = os.path.abspath(job["project_dir"])
    scene = os.path.join(pd, "rig", "scene.blend")
    if not os.path.exists(scene):
        raise protocol.MpmError("E_ARGS", "rig/scene.blend is missing; run the import job first")
    bpy.ops.wm.open_mainfile(filepath=scene)
    if job["args"].get("mapping") is not None:
        try:
            from mpm.rig import imported
        except ImportError:
            raise protocol.MpmError("E_ARGS", "imported rigs not available yet")
        return imported.rig_imported_job(job)
    return build_auto_rig(pd, _markers(job))


if __name__ == "__main__":
    protocol.run(main)
