# SPDX-License-Identifier: GPL-3.0-or-later
"""Job `import`: import a model, normalise it, make a proxy if dense, save rig/scene.blend."""
import json
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

    # Kits often ship props beside the character (a weapon on the floor): they must not take part in
    # finding the facing or the joints. args.objects {name: bool} is the user's own choice.
    protocol.progress("import", 0.25, "separating the character from props")
    all_objects = [{"name": m.name, "verts": len(m.data.vertices), "tris": importer._tri_count(m.data)} for m in meshes]
    meshes, props, auto = importer.split_props(meshes, armature, args.get("objects"))
    kept = {m.name for m in meshes}
    for o in all_objects:
        o["included"] = o["name"] in kept
        o["prop"] = bool(auto.get(o["name"], False))
    if props:
        warnings.append("left out as props: %s" % ", ".join(sorted(p.name for p in props)))
    groups = importer.prop_groups(props)

    suggested = importer.suggest_orientation(meshes)
    orientation = args.get("orientation") or suggested
    orientation = {"up": orientation.get("up", "Z"), "forward": orientation.get("forward", "-Y"),
                   "unit_scale": float(orientation.get("unit_scale", 1.0))}

    protocol.progress("normalise", 0.4, "normalising")
    prop_files = export_props(project_dir, groups, importer.orientation_matrix(orientation))
    warnings += importer.normalise(meshes, armature, orientation)
    protocol.progress("proxy", 0.7, "checking density")
    proxy = importer.make_proxy(meshes)
    info = importer.inspect(meshes, armature, suggested_orientation=suggested, proxy=proxy, warnings=warnings)
    info["orientation_used"] = orientation
    info["all_objects"] = all_objects
    info["props"] = prop_files

    protocol.progress("save", 0.9, "saving scene.blend")
    rig_dir = os.path.join(project_dir, "rig")
    os.makedirs(rig_dir, exist_ok=True)
    try:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.join(rig_dir, "scene.blend"), compress=True)
    except Exception as e:  # noqa: BLE001
        raise protocol.MpmError("E_IO", "cannot save scene.blend: %s" % e)
    protocol.progress("preview", 0.95, "exporting the preview")
    info["preview_glb"] = export_preview(rig_dir, proxy)
    info["source_file"] = args["file"]
    # Kept so a reopened project can show the summary (skeleton or not) without re-importing.
    with open(os.path.join(rig_dir, "import.json"), "w", encoding="utf-8") as fh:
        json.dump(info, fh, indent=1)
    return info


def export_props(project_dir, groups, M):
    """Each left-out prop is saved as props/<name>.glb (oriented and scaled like the character, in metres,
    its own position kept) so it can be added as a weapon, then removed from the scene."""
    import numpy as np
    from mathutils import Matrix
    out = []
    if not groups:
        return out
    pdir = os.path.join(project_dir, "props")
    os.makedirs(pdir, exist_ok=True)
    used = set()
    for grp in groups:
        base = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in grp[0].name.split(":")[-1]) or "prop"
        name, n = base, 2
        while name in used:
            name, n = "%s_%d" % (base, n), n + 1
        used.add(name)
        for o in grp:
            if o.data.users > 1:
                o.data = o.data.copy()
            o.data.transform(Matrix(M) @ o.matrix_world)
            o.matrix_world = Matrix.Identity(4)
        bpy.context.view_layer.update()
        for o in bpy.data.objects:
            o.select_set(o in grp)
        path = os.path.join(pdir, name + ".glb")
        try:
            bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_yup=True,
                                      export_apply=True, export_skins=False, export_animations=False,
                                      export_morph=False, export_materials='EXPORT', export_image_format='AUTO')
        except Exception as e:  # noqa: BLE001
            raise protocol.MpmError("E_EXPORT", "cannot export the prop %s: %s" % (name, e))
        co = np.vstack([np.array([v.co[:] for v in o.data.vertices]) for o in grp])
        out.append({"file": "props/%s.glb" % name, "objects": [o.name for o in grp],
                    "dims_m": [float(x) for x in (co.max(0) - co.min(0))]})
        for o in grp:
            bpy.data.objects.remove(o, do_unlink=True)
    return out


def export_preview(rig_dir, proxy):
    """Static rest-pose GLB of the meshes (their proxies for dense models) for the Import/Rig steps.
    Runs after scene.blend is saved, so the image downscaling here is never persisted."""
    from mpm.rig import export as RX
    objs = [o for o in bpy.data.objects if o.type == 'MESH']
    show = [o for o in objs if ("mpm_proxy_of" in o)] if proxy else [o for o in objs if "mpm_proxy_of" not in o]
    for o in objs:
        o.hide_set(o not in show)
        o.hide_viewport = o not in show
        o.select_set(o in show)
    RX._downscale_images(show)
    path = os.path.join(rig_dir, "preview.glb")
    try:
        bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_yup=True,
                                  export_apply=True, export_skins=False, export_animations=False,
                                  export_morph=False, export_materials='EXPORT', export_image_format='AUTO')
    except Exception as e:  # noqa: BLE001
        raise protocol.MpmError("E_EXPORT", "cannot export the preview: %s" % e)
    return "rig/preview.glb"


protocol.run(main)
