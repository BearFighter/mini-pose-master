# SPDX-License-Identifier: GPL-3.0-or-later
"""Job `convert_weapon`: a weapon file -> `weapons/<name>.glb`, static, in Blender metres (contracts §12, §16).

args: {"file": project-relative weapon file (usually weapons/<stem>/<file>),
       "unit_scale": optional float (else the suggestion), "out": optional project-relative .glb}

The weapon keeps its own origin and axes (the renderer places it with the §12 offset). Armatures are
dropped after evaluating the meshes in their rest shape; modifiers and shape keys are applied.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Matrix  # noqa: E402

from mpm import detail, importer, protocol  # noqa: E402


def suggest_unit_scale(longest_m):
    """Weapons are 0.05-3 m long. A file far outside that was most likely authored in cm or mm."""
    if longest_m > 30.0:
        return 0.001 if longest_m > 300.0 else 0.01
    return 1.0


def out_path(project_dir, rel_file, out=None):
    if out:
        return out
    parts = rel_file.replace("\\", "/").split("/")
    stem = parts[1] if len(parts) >= 3 and parts[0] == "weapons" else os.path.splitext(parts[-1])[0]
    rel = "weapons/%s.glb" % stem
    if os.path.normcase(os.path.abspath(os.path.join(project_dir, rel))) == \
            os.path.normcase(os.path.abspath(os.path.join(project_dir, rel_file))):
        rel = "weapons/%s.mpm.glb" % stem   # never overwrite the user's own .glb
    return rel


def _inside(root, rel):
    p = os.path.abspath(os.path.join(root, rel))
    if os.path.commonpath([root, p]) != root:
        raise protocol.MpmError("E_ARGS", "the path must be inside the project folder", {"path": rel})
    return p


def static_meshes(objs):
    """World-space static copies of every mesh as evaluated (rest pose); the imported objects are removed."""
    dg = bpy.context.evaluated_depsgraph_get()
    made = []
    for o in objs:
        if o.type != 'MESH':
            continue
        me = bpy.data.meshes.new_from_object(o.evaluated_get(dg))
        me.transform(o.matrix_world)
        made.append((o.name, me))
    for o in objs:
        bpy.data.objects.remove(o, do_unlink=True)
    out = []
    for name, me in made:  # the originals are gone, so the copies keep their names
        ob = bpy.data.objects.new(name, me)
        bpy.context.scene.collection.objects.link(ob)
        out.append(ob)
    return out


def principal_axis(co):
    c = co - co.mean(0)
    w, v = np.linalg.eigh(c.T @ c)
    a = v[:, int(np.argmax(w))]
    i = int(np.argmax(np.abs(a)))
    return (a if a[i] > 0 else -a).tolist()


def main(job):
    pd = os.path.abspath(job["project_dir"])
    a = job.get("args") or {}
    if not isinstance(a.get("file"), str):
        raise protocol.MpmError("E_ARGS", "convert_weapon needs args.file")
    src = _inside(pd, a["file"])
    rel_out = out_path(pd, a["file"], a.get("out"))
    dst = _inside(pd, rel_out)

    protocol.progress("import", 0.1, "importing the weapon")
    bpy.ops.wm.read_factory_settings(use_empty=True)
    new = importer.import_model(src)
    warnings = []
    meshes = static_meshes(new)  # evaluated: shape-key mix and modifiers are kept
    co = np.vstack([np.array([v.co[:] for v in o.data.vertices]) for o in meshes])
    lo, hi = co.min(0), co.max(0)
    suggested = suggest_unit_scale(float((hi - lo).max()))
    unit = float(a.get("unit_scale") or suggested)
    if suggested != 1.0 and not a.get("unit_scale"):
        warnings.append("the weapon is %.1f units long; scaled by %g (looks like %s)"
                        % (float((hi - lo).max()), suggested, "cm" if suggested == 0.01 else "mm"))
    if unit != 1.0:
        S = Matrix.Diagonal((unit, unit, unit, 1.0))
        for o in meshes:
            o.data.transform(S)
        co = co * unit
        lo, hi = lo * unit, hi * unit

    protocol.progress("export", 0.7, "writing the weapon GLB")
    from mpm.rig import export as RX
    RX._downscale_images(meshes)
    bpy.context.view_layer.update()
    for o in bpy.data.objects:
        o.select_set(o in meshes)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    try:
        bpy.ops.export_scene.gltf(filepath=dst, export_format='GLB', use_selection=True, export_yup=True,
                                  export_apply=True, export_skins=False, export_animations=False,
                                  export_morph=False, export_materials='EXPORT', export_image_format='AUTO')
    except Exception as e:  # noqa: BLE001
        raise protocol.MpmError("E_EXPORT", "cannot write the weapon GLB: %s" % e)
    tris = sum(len(p.vertices) - 2 for o in meshes for p in o.data.polygons)
    return {"weapon_glb": rel_out.replace("\\", "/"), "objects": [o.name for o in meshes], "tri_count": int(tris),
            "bbox_m": [lo.tolist(), hi.tolist()], "dims_m": (hi - lo).tolist(), "principal_axis": principal_axis(co),
            "normal_maps": sorted({m["image"].name for o in meshes for m in detail.find_normal_maps(o)}),
            "unit_scale_used": unit, "suggested_unit_scale": suggested, "warnings": warnings}


if __name__ == "__main__":
    protocol.run(main)
