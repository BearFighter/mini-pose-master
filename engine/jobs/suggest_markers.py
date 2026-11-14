# SPDX-License-Identifier: GPL-3.0-or-later
"""Job `suggest_markers`: measure the normalised model in rig/scene.blend and write rig/markers.json."""
import importlib
import importlib.util
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import bpy  # noqa: E402

from mpm import protocol  # noqa: E402
from mpm.rig import markers as body  # noqa: E402


def main(job):
    project_dir = os.path.abspath(job["project_dir"])
    rig_dir = os.path.join(project_dir, "rig")
    scene = os.path.join(rig_dir, "scene.blend")
    if not os.path.isfile(scene):
        raise protocol.MpmError("E_IO", "rig/scene.blend not found (run the import job first)", {"path": scene})
    protocol.progress("open", 0.05, "opening scene.blend")
    try:
        bpy.ops.wm.open_mainfile(filepath=scene)
    except Exception as e:  # noqa: BLE001
        raise protocol.MpmError("E_IO", "cannot open scene.blend: %s" % e, {"path": scene})

    protocol.progress("body", 0.2, "measuring the body")
    objs = body.select_meshes(list(bpy.data.objects))
    res = body.analyse_body_markers(objs)
    markers, warnings = res["markers"], list(res["warnings"])

    if importlib.util.find_spec("mpm.rig.fingers") is not None:
        protocol.progress("fingers", 0.7, "measuring the hands")
        fingers = importlib.import_module("mpm.rig.fingers")
        fm, fw, _hand_info = fingers.suggest_finger_markers(objs, markers, res["H"])
        markers.update(fm)
        warnings += list(fw)
    else:
        warnings.append("finger markers not available")

    protocol.progress("save", 0.95, "writing markers.json")
    os.makedirs(rig_dir, exist_ok=True)
    try:
        with open(os.path.join(rig_dir, "markers.json"), "w", encoding="utf-8") as f:
            json.dump({"schema": "mpm.markers/1", "markers": markers}, f, indent=1)
    except OSError as e:
        raise protocol.MpmError("E_IO", "cannot write markers.json: %s" % e)
    return {"markers": markers, "warnings": warnings}


protocol.run(main)
