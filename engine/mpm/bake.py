# SPDX-License-Identifier: GPL-3.0-or-later
"""Bake (WP10): posed rig + weapons -> detail displacement -> watertight print STL + preview
(contracts sections 12, 14, 16). Ports the prototype's bake_detail, adding the section 14 budgets."""

import math
import os

import bpy
import numpy as np
from mathutils import Matrix, Quaternion, Vector
from mathutils.bvhtree import BVHTree

from . import detail as D
from . import protocol
from .rig import skin as SKN

FACE_BUDGET = 8_000_000   # contracts section 14: subdivided faces in total
MAX_EDGE_MM = 0.06        # subdivide until the median edge is at most this long at print size
MAX_LEVEL = 4
PREVIEW_TRIS = 300_000
CHUNK = 100_000           # vertices per block in the weight transfer (bounds memory on dense meshes)


# --------------------------------------------------------------------------
# scale
# --------------------------------------------------------------------------

def unit_mm(rig, bake):
    """(mm per model metre, standing height in mm) from the bake scale (contracts section 14)."""
    sc = bake.get("scale") or {"mode": "height_mm", "height_mm": 40}
    H = float(rig["height_m"])
    if sc.get("mode") == "heroic":
        j = rig.get("joints") or {}
        if "head" not in j or "head_top" not in j:
            raise protocol.MpmError("E_ARGS", "heroic scale needs the head and head_top joints")
        eye = float(j["head"][2] + 0.4 * (j["head_top"][2] - j["head"][2]) - rig.get("floor_z", 0.0))
        u = float(sc["size_mm"]) / max(eye, 1e-9)
        return u, u * H
    h = float(sc.get("height_mm", 40))
    return h / max(H, 1e-9), h


# --------------------------------------------------------------------------
# meshes to bake (full-detail originals of decimated proxies get their weights here)
# --------------------------------------------------------------------------

def transfer_weights(proxy, dst, arm):
    """Skin `dst` from its rigged `proxy`: the nearest point on the proxy surface, the barycentric blend
    of that triangle's weights, then the section 7 parity rules. Adds the Armature modifier."""
    pme = proxy.data
    pme.calc_loop_triangles()
    tri = np.empty(len(pme.loop_triangles) * 3, np.int32)
    pme.loop_triangles.foreach_get("vertices", tri)
    tri = tri.reshape(-1, 3)
    pco = SKN._world_co(proxy)
    names = [g.name for g in proxy.vertex_groups]
    if not names or not len(tri):
        raise protocol.MpmError("E_WEIGHTS_EMPTY", "the proxy %s has no weights" % proxy.name)
    W = np.zeros((len(pco), len(names)), np.float32)
    for v in pme.vertices:
        for g in v.groups:
            W[v.index, g.group] = g.weight
    tree = BVHTree.FromPolygons(pco.tolist(), tri.tolist(), all_triangles=True)
    dco = SKN._world_co(dst)
    groups = {j: ([], []) for j in range(len(names))}
    for s in range(0, len(dco), CHUNK):
        P = dco[s:s + CHUNK]
        loc = np.empty_like(P)
        fi = np.empty(len(P), np.int64)
        for i, p in enumerate(P):
            hit = tree.find_nearest(Vector(p))
            loc[i], fi[i] = hit[0], hit[2]
        T = pco[tri[fi]]
        e0, e1, e2 = T[:, 1] - T[:, 0], T[:, 2] - T[:, 0], loc - T[:, 0]
        d00, d01, d11 = (e0 * e0).sum(1), (e0 * e1).sum(1), (e1 * e1).sum(1)
        d20, d21 = (e2 * e0).sum(1), (e2 * e1).sum(1)
        den = d00 * d11 - d01 * d01
        ok = np.abs(den) > 1e-20
        safe = np.where(ok, den, 1.0)
        b1 = np.where(ok, (d11 * d20 - d01 * d21) / safe, 0.0)
        b2 = np.where(ok, (d00 * d21 - d01 * d20) / safe, 0.0)
        B = np.clip(np.stack([1.0 - b1 - b2, b1, b2], 1), 0.0, None)
        B /= np.maximum(B.sum(1, keepdims=True), 1e-12)
        t = tri[fi]
        Wc = (B[:, 0:1] * W[t[:, 0]] + B[:, 1:2] * W[t[:, 1]] + B[:, 2:3] * W[t[:, 2]]).astype(np.float64)
        Wc = SKN.parity(Wc, P)
        for j in np.nonzero(Wc.any(0))[0]:
            idx = np.nonzero(Wc[:, j] > 0)[0]
            groups[j][0].append(idx + s)
            groups[j][1].append(Wc[idx, j])
    for g in list(dst.vertex_groups):
        dst.vertex_groups.remove(g)
    for j, (idx, w) in groups.items():
        if not idx:
            continue
        vg = dst.vertex_groups.new(name=names[j])
        for i, x in zip(np.concatenate(idx).tolist(), np.concatenate(w).tolist()):
            vg.add([i], x, 'REPLACE')
    SKN.setup_modifier(dst, arm)


def bake_meshes(rig, arm):
    """The meshes to bake, visible so they evaluate. Proxies (`mpm_proxy_of`) are swapped for their
    full-detail originals, skinned from the proxy. Returns (meshes, names of originals skinned here)."""
    names = {m["name"] for m in rig["meshes"]}
    rigged = [o for o in bpy.data.objects if o.type == 'MESH' and o.name in names]
    out, transferred = [], []
    for o in rigged:
        src = bpy.data.objects.get(o["mpm_proxy_of"]) if "mpm_proxy_of" in o else None
        if src is None or src.type != 'MESH':
            out.append(o)
            continue
        transfer_weights(o, src, arm)
        out.append(src)
        transferred.append(src.name)
    for o in out:
        o.hide_viewport = False
        o.hide_set(False)
    return out, transferred


def hide_all_meshes():
    """Objects hidden with hide_viewport are not evaluated: posing bone by bone stays fast."""
    for o in bpy.data.objects:
        if o.type == 'MESH':
            o.hide_viewport = True


# --------------------------------------------------------------------------
# detail
# --------------------------------------------------------------------------

def normal_map_for(o):
    maps = D.find_normal_maps(o)
    return maps[0]["image"] if maps else None


def _height_maps(objs, unit):
    by_img = {}
    for o in objs:
        img = normal_map_for(o)
        if img is not None and o.data.uv_layers:
            by_img.setdefault(img.name, (img, []))[1].append(o)
    out, notes = {}, []
    for name, (img, users) in by_img.items():
        nrm = D.image_rgb(img)
        h, w = nrm.shape[:2]
        tris = np.concatenate([D.uv_triangles(o.data) for o in users])
        mask = D.raster_mask(tris, w, h)
        sizes = [(D.texel_size(o.data, w, h, o.matrix_world), len(o.data.polygons)) for o in users]
        texel = sum(a * n for a, n in sizes) / max(sum(n for _, n in sizes), 1)
        sigma = max(8.0, 0.5 / max(texel * unit, 1e-12))  # keep relief finer than about 0.5 mm
        hm, info = D.height_from_normal(nrm, mask, sigma_px=sigma)
        out[name] = (hm, texel)
        notes.append({"image": name, "green": info["green"], "texel_um": round(texel * unit * 1000, 1),
                      "relief_um": [round(info["p01"] * texel * unit * 1000), round(info["p99"] * texel * unit * 1000)]})
    return out, notes


def faces_at(me, level):
    """Face count after `level` Catmull-Clark steps: n-gons split into n quads, then 4 each."""
    return len(me.polygons) if level == 0 else len(me.loops) * 4 ** (level - 1)


def plan_levels(objs, unit, has_map):
    """Subdivision level per object from its median edge at print size; lower the most expensive
    levels until the total is within FACE_BUDGET. Objects without a normal map use level 0."""
    levels = {}
    for o in objs:
        if not has_map[o.name]:
            levels[o.name] = 0
            continue
        me = o.data
        co = SKN._world_co(o)
        ed = np.array([e.vertices[:] for e in me.edges], np.int64).reshape(-1, 2)
        edge_mm = float(np.median(np.linalg.norm(co[ed[:, 0]] - co[ed[:, 1]], axis=1))) * unit if len(ed) else 0.0
        levels[o.name] = int(min(MAX_LEVEL, max(1, math.ceil(math.log2(max(edge_mm / MAX_EDGE_MM, 1.0))))))
    by = {o.name: o.data for o in objs}

    def total():
        return sum(faces_at(by[n], levels[n]) for n in levels)

    lowered = False
    while total() > FACE_BUDGET and any(v > 0 for v in levels.values()):
        worst = max((n for n in levels if levels[n] > 0), key=lambda n: faces_at(by[n], levels[n]))
        levels[worst] -= 1
        lowered = True
    return levels, total(), lowered


def bake_detail(objs, unit, strength):
    """Static, world-space copies of `objs` as currently evaluated (posed), subdivided after the
    armature and displaced along the normal by the relief recovered from each normal map."""
    hmaps, notes = _height_maps(objs, unit) if strength > 0 else ({}, [])
    has_map = {}
    for o in objs:
        img = normal_map_for(o)
        has_map[o.name] = img is not None and img.name in hmaps
    levels, est, lowered = plan_levels(objs, unit, has_map)
    info = {"height_maps": notes, "levels": levels, "faces": est, "levels_lowered": lowered, "displaced_um": {}}
    out = []
    for o in objs:
        lvl = levels[o.name]
        sub = None
        if lvl > 0:
            sub = o.modifiers.new("mpm_subdiv", 'SUBSURF')
            sub.levels = sub.render_levels = lvl
            sub.uv_smooth = 'NONE'
        dg = bpy.context.evaluated_depsgraph_get()
        me = bpy.data.meshes.new_from_object(o.evaluated_get(dg))
        if sub is not None:
            o.modifiers.remove(sub)
        me.transform(o.matrix_world)
        ob = bpy.data.objects.new(o.name + "_baked", me)
        bpy.context.scene.collection.objects.link(ob)
        if has_map[o.name] and me.uv_layers:
            hm, texel = hmaps[normal_map_for(o).name]
            hv = D.displace_mesh(me, hm, texel * strength)
            k = texel * strength * unit * 1000
            info["displaced_um"][o.name] = [round(float(np.percentile(hv, 1)) * k),
                                            round(float(np.percentile(hv, 99)) * k)]
        out.append(ob)
    return out, info


# --------------------------------------------------------------------------
# weapons (contracts section 12)
# --------------------------------------------------------------------------

def import_weapon(path):
    """Static world-space mesh copies of a weapon file's meshes (identity object matrices)."""
    before = set(bpy.data.objects)
    ext = os.path.splitext(path)[1].lower()
    try:
        if ext in (".glb", ".gltf"):
            bpy.ops.import_scene.gltf(filepath=path)
        elif ext == ".fbx":
            bpy.ops.import_scene.fbx(filepath=path, use_anim=False)
        elif ext == ".obj":
            bpy.ops.wm.obj_import(filepath=path)
        elif ext == ".stl":
            bpy.ops.wm.stl_import(filepath=path)
        else:
            raise protocol.MpmError("E_IMPORT_FAILED", "unsupported weapon file: %s" % os.path.basename(path))
    except RuntimeError as e:
        raise protocol.MpmError("E_IMPORT_FAILED", "could not import %s" % os.path.basename(path), {"error": str(e)})
    new = [o for o in bpy.data.objects if o not in before]
    out = []
    dg = bpy.context.evaluated_depsgraph_get()
    for o in new:
        if o.type != 'MESH':
            continue
        me = bpy.data.meshes.new_from_object(o.evaluated_get(dg))
        me.transform(o.matrix_world)
        ob = bpy.data.objects.new(o.name + "_weapon", me)
        bpy.context.scene.collection.objects.link(ob)
        out.append(ob)
    for o in new:
        bpy.data.objects.remove(o, do_unlink=True)
    if not out:
        raise protocol.MpmError("E_NO_MESH", "the weapon file has no mesh: %s" % os.path.basename(path))
    return out


def attach_frame(arm, rig, canonical):
    """Contracts section 12: A = Translation(posed head) * (D_b * R(rest_q_b)), i.e. pose_bone.matrix."""
    b = next((x for x in rig["bones"] if x.get("canonical") == canonical), None)
    if b is None:
        raise protocol.MpmError("E_ARGS", "the rig has no %s socket" % canonical)
    return arm.matrix_world @ arm.pose.bones[b["name"]].matrix


def offset_matrix(off):
    off = off or {}
    t = Vector(off.get("t", (0.0, 0.0, 0.0)))
    q = Quaternion(off.get("q", (1.0, 0.0, 0.0, 0.0))).normalized()
    s = float(off.get("s", 1.0))
    return Matrix.Translation(t) @ q.to_matrix().to_4x4() @ Matrix.Diagonal((s, s, s, 1.0))


def place_weapons(project_dir, arm, rig, weapons):
    """Import and place every weapon on its posed socket. Returns [(entry, [objects])]."""
    root = os.path.realpath(project_dir)
    out = []
    for w in weapons or []:
        path = os.path.realpath(os.path.join(root, w["file"]))
        if os.path.commonpath([root, path]) != root:
            raise protocol.MpmError("E_ARGS", "the weapon file must be inside the project: %s" % w["file"])
        if not os.path.exists(path):
            raise protocol.MpmError("E_IO", "the weapon file is missing: %s" % w["file"])
        objs = import_weapon(path)
        M = attach_frame(arm, rig, w.get("attach_bone", "grip.R")) @ offset_matrix(w.get("offset"))
        for o in objs:
            o.data.transform(M)
            o.data.update()
        out.append((w, objs))
    return out


# --------------------------------------------------------------------------
# preview
# --------------------------------------------------------------------------

def _show_colour(mat):
    """glTF exports the node tree's base colour, not the viewport colour: copy it across."""
    if mat is None:
        return
    if mat.node_tree is None:
        try:
            mat.use_nodes = True
        except (AttributeError, TypeError):
            return
    for n in (mat.node_tree.nodes if mat.node_tree else []):
        if n.bl_idname == 'ShaderNodeBsdfPrincipled':
            n.inputs["Base Color"].default_value = tuple(mat.diffuse_color)


def export_preview(ob, path):
    """Decimated copy of the printable result as a GLB in metres (thin areas keep the red material)."""
    tmp = bpy.data.objects.new(ob.name + "_preview", ob.data.copy())
    bpy.context.scene.collection.objects.link(tmp)
    for m in tmp.data.materials:
        _show_colour(m)
    tris = sum(len(p.vertices) - 2 for p in tmp.data.polygons)
    if tris > PREVIEW_TRIS:
        mod = tmp.modifiers.new("mpm_preview_decimate", 'DECIMATE')
        mod.ratio = PREVIEW_TRIS / float(tris)
    tmp.scale = (0.001, 0.001, 0.001)  # the STL is in mm; the viewer works in metres
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    tmp.select_set(True)
    bpy.context.view_layer.objects.active = tmp
    try:
        bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_yup=True,
                                  export_apply=True, export_skins=False, export_animations=False,
                                  export_materials='EXPORT', export_image_format='NONE')
    except RuntimeError as e:
        raise protocol.MpmError("E_EXPORT", "could not write the preview", {"error": str(e)})
    finally:
        bpy.data.objects.remove(tmp, do_unlink=True)
