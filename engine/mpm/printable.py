# SPDX-License-Identifier: GPL-3.0-or-later
"""Printable pipeline: turn game-style character meshes into one watertight STL (port of
prototype/make_printable.py, without the Blender UI and the command line).

  gather -> normalise to mm -> weld/clean -> flatten soles -> cap holes / thicken sheets
  -> voxel remesh -> drop voids and debris -> decimate -> thin-wall check -> binary STL
"""
import math
import os
import time

import bmesh
import bpy
import numpy as np
from mathutils import Matrix
from mathutils.bvhtree import BVHTree

from . import protocol

WELD_MM = 0.002  # seam-weld distance, in mm at final size
VOXEL_BUDGET = 60_000_000  # contracts section 14: estimated voxels = surface area / voxel^2

STAGE_FRACTION = {"gather": 0.05, "clean": 0.10, "thicken": 0.15, "remesh": 0.20, "cleanup": 0.70,
                  "decimate": 0.75, "thin_check": 0.85, "write": 0.95}


def log(*args, stage=None):
    print("[make_printable]", *args, flush=True)
    if stage is not None:
        protocol.progress(stage, STAGE_FRACTION[stage], " ".join(str(a) for a in args))


class Settings:
    def __init__(self, height=40.0, base_diameter=0.0, base_height=3.0,
                 min_thickness=0.6, voxel=None, max_tris=1_000_000,
                 hole_ratio=0.3, min_part_volume=0.5, flatten=0.5, unit_mm=None):
        self.height = float(height)
        # Fixed scale (mm per model unit) instead of fitting to `height`;
        # used for posed models, so a crouch comes out smaller, not stretched.
        self.unit_mm = float(unit_mm) if unit_mm else None
        # Slice this many mm off the soles so the feet stand on flat pads.
        self.flatten = max(0.0, float(flatten))
        # 0 = no base (default; users glue minis to their own bases), None = automatic
        self.base_diameter = (round(self.height * 0.625, 1)
                              if base_diameter is None else float(base_diameter))
        self.base_height = float(base_height)
        self.min_thickness = float(min_thickness)
        self.voxel = float(voxel) if voxel else max(0.025, self.height / 1000.0)
        self.max_tris = int(max_tris)
        # A hole is capped only if its cap is smaller than this fraction of
        # the part's surface (a neck hole yes, the outline of a cape no).
        self.hole_ratio = float(hole_ratio)
        # Separate floating bits smaller than this (mm^3) are deleted.
        self.min_part_volume = float(min_part_volume)


# --------------------------------------------------------------------------
# small Blender helpers
# --------------------------------------------------------------------------

def _new_object(name, me, coll=None):
    ob = bpy.data.objects.new(name, me)
    (coll or bpy.context.scene.collection).objects.link(ob)
    return ob


def _remove_object(ob):
    me = ob.data
    bpy.data.objects.remove(ob, do_unlink=True)
    if me is not None and me.users == 0:
        bpy.data.meshes.remove(me)


def _apply_modifier(ob, mtype, **props):
    mod = ob.modifiers.new("mp_tmp", mtype)
    for k, v in props.items():
        setattr(mod, k, v)
    dg = bpy.context.evaluated_depsgraph_get()
    new = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
    ob.modifiers.remove(mod)
    old = ob.data
    ob.data = new
    if old.users == 0:
        bpy.data.meshes.remove(old)


def _np_verts(me):
    co = np.empty(len(me.vertices) * 3, np.float32)
    me.vertices.foreach_get("co", co)
    return co.reshape(-1, 3).astype(np.float64)


def _np_tris(me):
    me.calc_loop_triangles()
    tri = np.empty(len(me.loop_triangles) * 3, np.int32)
    me.loop_triangles.foreach_get("vertices", tri)
    return tri.reshape(-1, 3)


def _material(name, rgba):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.diffuse_color = rgba
    return m


# --------------------------------------------------------------------------
# geometry steps
# --------------------------------------------------------------------------

def _gather(objects):
    """Copy every object's evaluated mesh (pose + modifiers) into one bmesh."""
    dg = bpy.context.evaluated_depsgraph_get()
    bm = bmesh.new()
    for ob in objects:
        ev = ob.evaluated_get(dg)
        me = bpy.data.meshes.new_from_object(ev)
        me.transform(ev.matrix_world)
        bm.from_mesh(me)
        bpy.data.meshes.remove(me)
    return bm


def _normalize(bm, height, unit_mm=None):
    """Scale so the model is `height` mm tall (or by a fixed `unit_mm`),
    centred, feet on z=0."""
    co = np.array([v.co[:] for v in bm.verts])
    lo, hi = co.min(0), co.max(0)
    src_h = hi[2] - lo[2]
    if src_h <= 0:
        raise RuntimeError("The model has no height (is it flat?)")
    s = unit_mm if unit_mm else height / src_h
    cx, cy = (lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2
    m = Matrix.Diagonal((s, s, s, 1.0)) @ Matrix.Translation((-cx, -cy, -lo[2]))
    bmesh.ops.transform(bm, matrix=m, verts=bm.verts[:])
    return s, (hi - lo)


def _clean(bm, dist):
    """Weld split seams, drop duplicate (double-sided) faces and loose bits."""
    n0 = len(bm.verts)
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=dist)
    welded = n0 - len(bm.verts)
    bmesh.ops.dissolve_degenerate(bm, dist=dist * 0.1, edges=bm.edges[:])
    bm.verts.index_update()
    seen, dups = set(), []
    for f in bm.faces:
        key = tuple(sorted(v.index for v in f.verts))
        if key in seen:
            dups.append(f)
        else:
            seen.add(key)
    if dups:
        bmesh.ops.delete(bm, geom=dups, context='FACES_ONLY')
    loose_e = [e for e in bm.edges if not e.link_faces]
    if loose_e:
        bmesh.ops.delete(bm, geom=loose_e, context='EDGES')
    loose_v = [v for v in bm.verts if not v.link_faces]
    if loose_v:
        bmesh.ops.delete(bm, geom=loose_v, context='VERTS')
    return welded, len(dups)


def _flatten_soles(bm, cut):
    """Slice off everything below z=cut and cap the cuts, so each foot ends
    in a flat pad that glues well to a base."""
    if cut <= 0:
        return 0.0
    bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], dist=1e-5,
                           plane_co=(0.0, 0.0, cut), plane_no=(0.0, 0.0, 1.0),
                           clear_inner=True)
    tol = 1e-4
    rim = [e for e in bm.edges if e.is_boundary
           and abs(e.verts[0].co.z - cut) < tol and abs(e.verts[1].co.z - cut) < tol]
    area = 0.0
    for grp in _edge_groups(rim):
        for f in bmesh.ops.holes_fill(bm, edges=grp, sides=0)["faces"]:
            area += f.calc_area()
    return area


def _face_islands(bm):
    for f in bm.faces:
        f.tag = False
    islands = []
    for f in bm.faces:
        if f.tag:
            continue
        f.tag = True
        stack, isl = [f], []
        while stack:
            cur = stack.pop()
            isl.append(cur)
            for e in cur.edges:
                for nf in e.link_faces:
                    if not nf.tag:
                        nf.tag = True
                        stack.append(nf)
        islands.append(isl)
    return islands


def _edge_groups(edges):
    edges = set(edges)
    groups = []
    while edges:
        e = edges.pop()
        grp, stack = [e], [e]
        while stack:
            cur = stack.pop()
            for v in cur.verts:
                for ne in v.link_edges:
                    if ne in edges:
                        edges.remove(ne)
                        grp.append(ne)
                        stack.append(ne)
        groups.append(grp)
    return groups


def _fix_open_parts(bm, s):
    """Cap small holes; tag parts that are still open as sheets to thicken."""
    sheet = bm.faces.layers.int.new("mp_sheet")
    st = {"parts": 0, "closed": 0, "capped": 0, "holes_capped": 0, "sheets": 0}
    for isl in _face_islands(bm):
        st["parts"] += 1
        boundary = {e for f in isl for e in f.edges if e.is_boundary}
        if not boundary:
            st["closed"] += 1
            continue
        area = sum(f.calc_area() for f in isl)
        caps = []
        for grp in _edge_groups(boundary):
            new = bmesh.ops.holes_fill(bm, edges=grp, sides=0)["faces"]
            if not new:
                continue
            if sum(f.calc_area() for f in new) > s.hole_ratio * area:
                bmesh.ops.delete(bm, geom=new, context='FACES_ONLY')
            else:
                caps += new
                st["holes_capped"] += 1
        faces = [f for f in isl + caps if f.is_valid]
        if any(e.is_boundary for f in faces for e in f.edges):
            for f in faces:
                f[sheet] = 1
            st["sheets"] += 1
        else:
            st["capped"] += 1
    return st


def _thicken_sheets(bm, thickness):
    """Move sheet-tagged faces out, solidify them, and merge them back."""
    layer = bm.faces.layers.int.get("mp_sheet")
    sheet_faces = [f for f in bm.faces if f[layer] == 1]
    if not sheet_faces:
        return
    sbm = bm.copy()
    slayer = sbm.faces.layers.int.get("mp_sheet")
    bmesh.ops.delete(sbm, geom=[f for f in sbm.faces if f[slayer] == 0], context='FACES')
    bmesh.ops.recalc_face_normals(sbm, faces=sbm.faces[:])
    bmesh.ops.delete(bm, geom=sheet_faces, context='FACES')
    me = bpy.data.meshes.new("mp_sheets")
    sbm.to_mesh(me)
    sbm.free()
    ob = _new_object("mp_sheets", me)
    _apply_modifier(ob, 'SOLIDIFY', thickness=thickness, offset=0.0,
                    use_even_offset=True, use_rim=True, use_quality_normals=True)
    bm.from_mesh(ob.data)
    _remove_object(ob)


def _feet(bm, height):
    """Centre (x, y) and reach of the lowest 3% of the model."""
    cut = height * 0.03
    pts = np.array([v.co[:2] for v in bm.verts if v.co.z <= cut])
    lo, hi = pts.min(0), pts.max(0)
    c = (lo + hi) / 2
    return c, float(np.linalg.norm(pts - c, axis=1).max())


def _add_base(bm, cxy, diameter, height, sink):
    r = diameter / 2
    bmesh.ops.create_cone(
        bm, cap_ends=True, cap_tris=False, segments=128,
        radius1=r, radius2=max(r - 0.8, r * 0.9), depth=height,
        matrix=Matrix.Translation((cxy[0], cxy[1], sink - height / 2)))


def _components(me):
    """Connected-component label per vertex (numpy union-find)."""
    ed = np.empty(len(me.edges) * 2, np.int32)
    me.edges.foreach_get("vertices", ed)
    a, b = ed[0::2], ed[1::2]
    lab = np.arange(len(me.vertices))
    while True:
        la, lb = lab[a], lab[b]
        if np.array_equal(la, lb):
            return lab
        mn = np.minimum(la, lb)
        np.minimum.at(lab, la, mn)
        np.minimum.at(lab, lb, mn)
        while True:
            nl = lab[lab]
            if np.array_equal(nl, lab):
                break
            lab = nl


def _drop_voids_and_debris(ob, min_volume):
    me = ob.data
    lab = _components(me)
    co = _np_verts(me)
    tri = _np_tris(me)
    v0, v1, v2 = co[tri[:, 0]], co[tri[:, 1]], co[tri[:, 2]]
    vol = np.einsum("ij,ij->i", v0, np.cross(v1, v2)) / 6.0
    labels, inv = np.unique(lab[tri[:, 0]], return_inverse=True)
    cvol = np.bincount(inv, weights=vol)
    kill = labels[cvol < min_volume]
    voids = int((cvol < 0).sum())
    debris = int(((cvol >= 0) & (cvol < min_volume)).sum())
    if len(kill):
        idx = np.nonzero(np.isin(lab, kill))[0]
        bm = bmesh.new()
        bm.from_mesh(me)
        bm.verts.ensure_lookup_table()
        bmesh.ops.delete(bm, geom=[bm.verts[i] for i in idx], context='VERTS')
        bm.to_mesh(me)
        bm.free()
    keep = cvol[cvol >= min_volume]
    return {"voids_filled": voids, "debris_removed": debris,
            "pieces": int(len(keep)), "volume_mm3": float(keep.sum())}


def _thin_check(me, min_t, eps):
    """Flag faces whose wall (measured straight inward) is thinner than min_t."""
    n = len(me.polygons)
    verts = _np_verts(me).tolist()
    lt = np.empty(n, np.int32)
    me.polygons.foreach_get("loop_total", lt)
    lv = np.empty(len(me.loops), np.int32)
    me.loops.foreach_get("vertex_index", lv)
    if (lt == 3).all():
        polys = lv.reshape(-1, 3).tolist()
    else:
        ls = np.empty(n, np.int32)
        me.polygons.foreach_get("loop_start", ls)
        polys = [lv[s:s + t].tolist() for s, t in zip(ls, lt)]
    tree = BVHTree.FromPolygons(verts, polys, all_triangles=bool((lt == 3).all()))
    cen = np.empty(n * 3, np.float32)
    nor = np.empty(n * 3, np.float32)
    area = np.empty(n, np.float32)
    me.polygons.foreach_get("center", cen)
    me.polygons.foreach_get("normal", nor)
    me.polygons.foreach_get("area", area)
    cen, nor = cen.reshape(-1, 3), nor.reshape(-1, 3)
    origins = (cen - nor * eps).tolist()
    dirs = (-nor).tolist()
    rc = tree.ray_cast

    def is_thin(o, d):
        # Only count the far wall if it faces back at us (a real thin wall),
        # not the neighbouring face of a sharp outside corner.
        loc, hn, _i, _dist = rc(o, d, min_t)
        return loc is not None and hn[0] * d[0] + hn[1] * d[1] + hn[2] * d[2] > 0.5

    thin = np.fromiter((is_thin(o, d) for o, d in zip(origins, dirs)), dtype=bool, count=n)
    total = float(area.sum()) or 1.0
    return thin, float(area[thin].sum()) / total * 100.0


def write_stl(me, path):
    """Binary STL, coordinates as-is (mm)."""
    co = _np_verts(me).astype(np.float32)
    tri = _np_tris(me)
    v = co[tri]
    nrm = np.cross(v[:, 1] - v[:, 0], v[:, 2] - v[:, 0])
    ln = np.linalg.norm(nrm, axis=1, keepdims=True)
    ln[ln == 0] = 1.0
    rec = np.zeros(len(tri), dtype=[("n", "<f4", (3,)), ("v", "<f4", (3, 3)), ("a", "<u2")])
    rec["n"] = nrm / ln
    rec["v"] = v
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(b"binary STL from make_printable.py, units mm".ljust(80, b" "))
        fh.write(np.uint32(len(tri)).tobytes())
        rec.tofile(fh)
    return len(tri)


# --------------------------------------------------------------------------
# the pipeline
# --------------------------------------------------------------------------

def make_printable(objects, s, out_path, name="model", collection=None):
    """Build a printable copy of `objects`, write it to `out_path`.

    Returns (result_object, report_dict). The source objects are not changed.
    """
    t0 = time.time()
    objs = [o for o in objects if o.type == 'MESH']
    if not objs:
        raise RuntimeError("No mesh objects to process")
    rep = {"name": name, "objects": len(objs), "height_mm": s.height,
           "voxel_mm": s.voxel, "min_thickness_mm": s.min_thickness}
    log(f"{name}: {len(objs)} mesh object(s), target height {s.height} mm, "
        f"voxel {s.voxel:.3f} mm")

    log("  gathering meshes", stage="gather")
    bm = _gather(objs)
    rep["source_tris"] = sum(len(f.verts) - 2 for f in bm.faces)
    # Scale a little taller than asked, then slice the soles flat, so the
    # finished figure is exactly s.height.
    scale, src_dims = _normalize(bm, s.height + s.flatten, s.unit_mm)
    rep["source_dims"] = [round(float(d), 4) for d in src_dims]
    log("  cleaning", stage="clean")
    rep["welded_verts"], rep["duplicate_faces"] = _clean(bm, WELD_MM)
    rep["flatten_mm"] = s.flatten
    rep["sole_pad_mm2"] = round(_flatten_soles(bm, s.flatten), 1)
    rep.update(_fix_open_parts(bm, s))
    log(f"  parts: {rep['parts']} ({rep['closed']} closed, {rep['capped']} capped, "
        f"{rep['sheets']} thin sheets to thicken)")
    log("  thickening sheets", stage="thicken")
    _thicken_sheets(bm, s.min_thickness * 1.25)

    feet_c, feet_reach = _feet(bm, s.height)
    centre = feet_c
    rep["base_mm"] = 0.0
    if s.base_diameter > 0:
        sink = min(0.4, s.base_height * 0.5)
        _add_base(bm, feet_c, s.base_diameter, s.base_height, sink)
        rep["base_mm"] = s.base_diameter
        if feet_reach > s.base_diameter / 2:
            rep["warn_base"] = (f"feet reach {feet_reach * 2:.1f} mm across, wider "
                                f"than the {s.base_diameter} mm base")

    # Voxel budget (contracts section 14): coarsen the voxel up to 2x, else fail.
    voxel = s.voxel
    area = sum(f.calc_area() for f in bm.faces)
    est = area / (voxel * voxel)
    rep["voxel_estimate"] = int(est)
    if est > VOXEL_BUDGET:
        coarse = math.sqrt(area / VOXEL_BUDGET)
        if coarse > 2.0 * s.voxel:
            bm.free()
            raise protocol.MpmError(
                "E_BUDGET", "voxel budget exceeded: about %d voxels at %.4f mm, would need %.4f mm (more than 2x)"
                % (est, s.voxel, coarse), {"estimated_voxels": int(est), "voxel_mm": s.voxel,
                                           "needed_voxel_mm": coarse, "surface_area_mm2": area})
        voxel = coarse
        rep["voxel_coarsened_to"] = voxel
        log(f"  voxel coarsened {s.voxel:.4f} -> {voxel:.4f} mm to stay within the voxel budget")

    me = bpy.data.meshes.new(name + "_printable")
    bm.to_mesh(me)
    bm.free()
    old = bpy.data.objects.get(name + "_printable")
    if old is not None:
        _remove_object(old)
    ob = _new_object(name + "_printable", me, collection)

    log("  voxel remeshing (this is the slow part)...", stage="remesh")
    # Flat faces lying exactly on the voxel grid (the base's top and bottom)
    # make the remesher emit pinched, non-manifold edges. Shift off-grid by
    # an odd fraction of a voxel while remeshing, then shift back.
    off = Matrix.Translation((0.317 * voxel, 0.271 * voxel, 0.229 * voxel))
    ob.data.transform(off)
    _apply_modifier(ob, 'REMESH', mode='VOXEL', voxel_size=voxel,
                    adaptivity=0.0, use_smooth_shade=True)
    ob.data.transform(off.inverted())
    log("  removing voids and debris", stage="cleanup")
    rep.update(_drop_voids_and_debris(ob, s.min_part_volume))

    tris = len(_np_tris(ob.data))
    protocol.progress("decimate", STAGE_FRACTION["decimate"], "trimming triangle count")
    if tris > s.max_tris:
        log(f"  decimating {tris:,} -> {s.max_tris:,} triangles...")
        _apply_modifier(ob, 'DECIMATE', decimate_type='COLLAPSE',
                        ratio=s.max_tris / tris, use_collapse_triangulate=True)

    co = _np_verts(ob.data)
    ob.data.transform(Matrix.Translation((-centre[0], -centre[1], -co[:, 2].min())))
    co = _np_verts(ob.data)
    dims = co.max(0) - co.min(0)
    rep["final_dims_mm"] = [round(float(d), 2) for d in dims]

    log("  checking wall thickness...", stage="thin_check")
    thin, pct = _thin_check(ob.data, s.min_thickness, voxel * 0.05)
    rep["thin_area_pct"] = round(pct, 2)
    ob.data.materials.clear()
    ob.data.materials.append(_material("MP_Printable", (0.7, 0.7, 0.72, 1.0)))
    ob.data.materials.append(_material("MP_TooThin", (0.9, 0.1, 0.1, 1.0)))
    ob.data.polygons.foreach_set("material_index", thin.astype(np.int32))
    ob.data.update()

    protocol.progress("write", STAGE_FRACTION["write"], "writing STL")
    rep["tris"] = write_stl(ob.data, out_path)
    rep["stl"] = os.path.abspath(out_path)
    rep["stl_mb"] = round(os.path.getsize(out_path) / 1e6, 1)
    rep["seconds"] = round(time.time() - t0, 1)
    return ob, rep


def summarize(rep):
    d = rep["final_dims_mm"]
    lines = [
        f"{rep['name']}: {d[0]} x {d[1]} x {d[2]} mm, {rep['tris']:,} triangles, "
        f"{rep['stl_mb']} MB",
        f"  source: {rep['objects']} object(s), {rep['source_tris']:,} triangles, "
        f"{rep['parts']} parts ({rep['closed']} closed, {rep['capped']} capped, "
        f"{rep['sheets']} sheets thickened)",
        f"  fixes: {rep['welded_verts']:,} seam verts welded, "
        f"{rep['duplicate_faces']:,} duplicate faces, {rep['holes_capped']} holes capped, "
        f"{rep['voids_filled']} internal voids filled, {rep['debris_removed']} debris removed",
        f"  result: {rep['pieces']} separate piece(s), "
        f"{rep['thin_area_pct']}% of surface thinner than {rep['min_thickness_mm']:.2g} mm "
        f"(red in Blender)",
    ]
    if rep.get("flatten_mm"):
        lines.append(f"  soles: {rep['flatten_mm']:g} mm sliced off, "
                     f"{rep['sole_pad_mm2']} mm2 of flat pad to glue down")
    if rep["pieces"] > 1:
        lines.append("  note: more than one piece - something is floating (check in Blender)")
    if "warn_base" in rep:
        lines.append("  note: " + rep["warn_base"])
    lines.append(f"  saved {rep['stl']}  ({rep['seconds']} s)")
    return "\n".join(lines)
