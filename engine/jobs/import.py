# SPDX-License-Identifier: GPL-3.0-or-later
"""Job `import`: import a model, normalise it, make a proxy if dense, save rig/scene.blend."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import bpy  # noqa: E402

from mpm import importer, protocol  # noqa: E402


def main(job):
    args = job["args"]
    if not isinstance(args, dict) or not isinstance(args.get("file"), str):
        raise protocol.MpmError("E_ARGS", "import needs args.file")
    project_dir = os.path.abspath(job["project_dir"])
    path = os.path.abspath(os.path.join(project_dir, args["file"]))
    if os.path.commonpath([project_dir, path]) != project_dir:
        raise protocol.MpmError("E_ARGS", "args.file must be inside the project folder", {"file": args["file"]})

    protocol.progress("import", 0.05, "importing")
    bpy.ops.wm.read_factory_settings(use_empty=True)
    new = importer.import_model(path)
    meshes, armature, warnings = importer.select_objects(new)

    suggested = importer.suggest_orientation(meshes)
    orientation = args.get("orientation") or suggested
    orientation = {"up": orientation.get("up", "Z"), "forward": orientation.get("forward", "-Y"),
                   "unit_scale": float(orientation.get("unit_scale", 1.0))}

    protocol.progress("normalise", 0.4, "normalising")
    warnings += importer.normalise(meshes, armature, orientation)
    protocol.progress("proxy", 0.7, "checking density")
    proxy = importer.make_proxy(meshes)
    info = importer.inspect(meshes, armature, suggested_orientation=suggested, proxy=proxy, warnings=warnings)
    info["orientation_used"] = orientation

    protocol.progress("save", 0.9, "saving scene.blend")
    rig_dir = os.path.join(project_dir, "rig")
    os.makedirs(rig_dir, exist_ok=True)
    try:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.join(rig_dir, "scene.blend"), compress=True)
    except Exception as e:  # noqa: BLE001
        raise protocol.MpmError("E_IO", "cannot save scene.blend: %s" % e)
    return info


protocol.run(main)
