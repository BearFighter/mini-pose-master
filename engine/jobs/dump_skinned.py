# SPDX-License-Identifier: GPL-3.0-or-later
"""Job `dump_skinned`: posed bones and skinned vertex positions from rig/rig.blend (contracts s16)."""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import bpy  # noqa: E402

from mpm import dump, protocol  # noqa: E402


def main(job):
    pd = os.path.abspath(job["project_dir"])
    blend, rjson = os.path.join(pd, "rig", "rig.blend"), os.path.join(pd, "rig", "rig.json")
    if not (os.path.exists(blend) and os.path.exists(rjson)):
        raise protocol.MpmError("E_ARGS", "rig/rig.blend or rig/rig.json is missing; run the rig job first")
    args = job["args"]
    if not isinstance(args.get("pose"), dict):
        raise protocol.MpmError("E_ARGS", "dump_skinned needs args.pose (mpm.pose/1)")
    with open(rjson, encoding="utf-8") as fh:
        rig = json.load(fh)
    bpy.ops.wm.open_mainfile(filepath=blend)
    arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
    names = {m["name"] for m in rig["meshes"]}
    meshes = [o for o in bpy.data.objects if o.type == 'MESH' and o.name in names]
    return dump.dump(arm, meshes, rig, args["pose"], args.get("sample", "all"))


if __name__ == "__main__":
    protocol.run(main)
