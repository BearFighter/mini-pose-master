# SPDX-License-Identifier: GPL-3.0-or-later
"""Job `bake`: pose state + weapons + bake settings -> exports/<name>.stl, separate weapon STLs, a preview
GLB and exports/report.json (contracts sections 12-16). Opens rig/rig.blend; never re-imports or re-rigs.

Order (section 14): pose -> follow-check gate -> weapons -> detail (face budget) -> printable (voxel
budget, remesh) -> preview."""
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import bpy  # noqa: E402

from mpm import bake as BK  # noqa: E402
from mpm import pose as PO  # noqa: E402
from mpm import printable, protocol  # noqa: E402
from mpm.dump import hips_index  # noqa: E402

DEFAULT_BAKE = {"schema": "mpm.bake/1", "scale": {"mode": "height_mm", "height_mm": 40}, "detail": 2.0,
                "flatten_mm": 0.5, "base_mm": 0, "min_wall_mm": 0.6, "thicken_thin": True, "weapons_separate": False,
                "max_tris": 2_000_000}


def _safe(name, fallback):
    return re.sub(r"[^\w\-]+", "_", str(name or "")).strip("_") or fallback


def main(job):
    t0 = time.time()
    pd = os.path.abspath(job["project_dir"])
    a = job.get("args") or {}
    blend, rjson = os.path.join(pd, "rig", "rig.blend"), os.path.join(pd, "rig", "rig.json")
    if not (os.path.exists(blend) and os.path.exists(rjson)):
        raise protocol.MpmError("E_ARGS", "the project has no rig yet; build the rig first")
    pose = a.get("pose") or {}
    bake = dict(DEFAULT_BAKE, **(a.get("bake") or {}))
    with open(rjson, encoding="utf-8") as fh:
        rig = json.load(fh)
    if pose.get("rig_hash") and pose["rig_hash"] != rig["hash"]:
        raise protocol.MpmError("E_ARGS", "the pose was made for a different rig; re-apply it first",
                                {"pose_rig": pose["rig_hash"], "rig": rig["hash"]})
    unit, standing_mm = BK.unit_mm(rig, bake)

    bpy.ops.wm.open_mainfile(filepath=blend)
    arm = next((o for o in bpy.data.objects if o.type == 'ARMATURE'), None)
    if arm is None:
        raise protocol.MpmError("E_ARGS", "rig.blend has no armature; rebuild the rig")

    protocol.progress("pose", 0.02, "posing")
    BK.hide_all_meshes()
    deltas = pose.get("deltas") or {}
    PO.apply_pose_state(arm, deltas, pose.get("root_offset") or (0.0, 0.0, 0.0), hips_index=hips_index(rig))
    posed_any = any(abs(abs(float(q[0])) - 1.0) > 1e-9 for q in deltas.values())

    protocol.progress("pose", 0.05, "preparing the meshes")
    meshes, transferred = BK.bake_meshes(rig, arm)
    protocol.progress("follow_check", 0.08, "checking the mesh follows the skeleton")
    chk = PO.follow_check(arm, meshes, float(rig["height_m"]))
    PO.gate(chk, posed_any=posed_any)

    protocol.progress("weapons", 0.10, "placing weapons")
    placed = BK.place_weapons(pd, arm, rig, a.get("weapons"))
    weapon_objs = [o for _w, objs in placed for o in objs]

    protocol.progress("detail", 0.12, "baking surface detail")
    baked, dinfo = BK.bake_detail(meshes + weapon_objs, unit, float(bake.get("detail", 2.0)), standing_mm)
    by_src = dict(zip([o.name for o in meshes + weapon_objs], baked))
    for o in meshes + weapon_objs:
        o.hide_viewport = True

    name = _safe(a.get("name") or os.path.basename(pd), "mini")
    out_dir = os.path.join(pd, "exports")
    os.makedirs(out_dir, exist_ok=True)
    settings = printable.Settings(height=standing_mm, base_diameter=float(bake.get("base_mm") or 0),
                                  min_thickness=float(bake.get("min_wall_mm", 0.6)),
                                  flatten=float(bake.get("flatten_mm", 0.5)), unit_mm=unit,
                                  max_tris=int(bake.get("max_tris", 2_000_000)),
                                  thicken=bool(bake.get("thicken_thin", True)))
    merged = [by_src[o.name] for o in meshes]
    separate = []
    for w, objs in placed:
        parts = [by_src[o.name] for o in objs]
        if bake.get("weapons_separate") or not w.get("merge", True):
            separate.append((w, parts))
        else:
            merged.extend(parts)

    stl = os.path.join(out_dir, name + ".stl")
    ob, rep = printable.make_printable(merged, settings, stl, name)
    rep["summary"] = printable.summarize(rep)
    rel = lambda p: os.path.relpath(p, pd).replace("\\", "/")  # noqa: E731
    rep["stl"] = rel(stl)
    result = {"stl": rel(stl), "report": rep, "weapons": [],
              "gates": {"follow": chk, "posed": posed_any, "faces": dinfo["faces"],
                        "levels_lowered": dinfo["levels_lowered"],
                        "voxel_coarsened_to": rep.get("voxel_coarsened_to")},
              "detail": dinfo, "unit_mm": unit, "standing_mm": standing_mm, "weights_transferred": transferred}

    for n, (w, parts) in enumerate(separate):
        protocol.progress("weapons", 0.90, "baking weapon %d of %d" % (n + 1, len(separate)))
        wname = "%s_%s" % (name, _safe(w.get("id"), "weapon%d" % (n + 1)))
        ws = printable.Settings(height=standing_mm, base_diameter=0, min_thickness=settings.min_thickness,
                                flatten=0.0, unit_mm=unit, max_tris=settings.max_tris, thicken=settings.thicken)
        wstl = os.path.join(out_dir, wname + ".stl")
        _wob, wrep = printable.make_printable(parts, ws, wstl, wname)
        wrep["summary"] = printable.summarize(wrep)
        wrep["stl"] = rel(wstl)
        result["weapons"].append({"id": w.get("id"), "stl": rel(wstl), "report": wrep})

    protocol.progress("preview", 0.96, "exporting the preview")
    prev = os.path.join(out_dir, name + "_preview.glb")
    BK.export_preview(ob, prev)
    result["preview_glb"] = rel(prev)
    result["seconds"] = round(time.time() - t0, 1)
    with open(os.path.join(out_dir, "report.json"), "w", encoding="utf-8") as fh:
        json.dump(result, fh, indent=1)
    return result


if __name__ == "__main__":
    protocol.run(main)
