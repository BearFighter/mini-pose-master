# SPDX-License-Identifier: GPL-3.0-or-later
"""Import, orientation suggestion, normalisation, proxy creation and inspection of character models."""
import math
import os

import bpy
import numpy as np
from mathutils import Matrix, Vector

from . import detail
from .protocol import MpmError

UNIT_SCALE_CANDIDATES = (1.0, 0.01, 0.001, 0.0254, 100.0)
TARGET_HEIGHT_M = 1.8
_AXES = {"X": (1.0, 0.0, 0.0), "Y": (0.0, 1.0, 0.0), "Z": (0.0, 0.0, 1.0)}


# --------------------------------------------------------------------------
# import
# --------------------------------------------------------------------------

def import_model(path):
    """Import a model file and return the new objects. Raises E_IMPORT_FAILED / E_NO_MESH."""
    ext = os.path.splitext(path)[1].lower()
    if ext not in (".fbx", ".glb", ".gltf", ".obj", ".stl", ".ply"):
        raise MpmError("E_IMPORT_FAILED", "unsupported file type %r" % ext, {"path": path})
    if not os.path.isfile(path):
        raise MpmError("E_IMPORT_FAILED", "file not found", {"path": path})
    before = set(bpy.data.objects)
    try:
        if ext == ".fbx":
            bpy.ops.import_scene.fbx(filepath=path, use_anim=False, automatic_bone_orientation=False,
                                     ignore_leaf_bones=False, use_image_search=True)
        elif ext in (".glb", ".gltf"):
            bpy.ops.import_scene.gltf(filepath=path)
        elif ext == ".obj":
            bpy.ops.wm.obj_import(filepath=path)
        elif ext == ".stl":
            bpy.ops.wm.stl_import(filepath=path)
        elif ext == ".ply":
            bpy.ops.wm.ply_import(filepath=path)
    except MpmError:
        raise
    except Exception as e:  # noqa: BLE001
        raise MpmError("E_IMPORT_FAILED", "import failed: %s" % e, {"path": path})
    bpy.context.view_layer.update()
    new = [o for o in bpy.data.objects if o not in before]
    if not any(o.type == 'MESH' for o in new):
        raise MpmError("E_NO_MESH", "the file contains no mesh", {"path": path})
    return new


def select_objects(objs):
    """Split imported objects into (meshes, armature|None, warnings).

    Keeps only the armature with the most bones (others are deleted, with a warning). Every object keeps its
    world transform when parents are cleared; objects that are neither mesh nor armature (empties, cameras,
    lights) are deleted.
    """
    warnings = []
    objs = list(objs)
    bpy.context.view_layer.update()
    for o in objs:
        mw = o.matrix_world.copy()
        o.parent = None
        o.matrix_parent_inverse = Matrix.Identity(4)
        o.matrix_world = mw
    meshes = [o for o in objs if o.type == 'MESH']
    arms = sorted((o for o in objs if o.type == 'ARMATURE'), key=lambda a: -len(a.data.bones))
    armature = arms[0] if arms else None
    for extra in arms[1:]:
        warnings.append("extra armature %r removed (kept %r with %d bones)"
                        % (extra.name, armature.name, len(armature.data.bones)))
        data = extra.data
        bpy.data.objects.remove(extra, do_unlink=True)
        if data.users == 0:
            bpy.data.armatures.remove(data)
    for m in meshes:
        for mod in list(m.modifiers):
            if mod.type == 'ARMATURE' and mod.object is None:
                m.modifiers.remove(mod)
    for o in objs:
        if o.type not in ('MESH', 'ARMATURE'):
            bpy.data.objects.remove(o, do_unlink=True)
    return meshes, armature, warnings


# --------------------------------------------------------------------------
# character vs props
# --------------------------------------------------------------------------

PROP_GAP = 0.03       # an object farther than this fraction of the character's size from it is a prop
PROP_SAMPLES = 1500   # vertices tested per object


def _bvh_of(co, me):
    from mathutils import Vector
    from mathutils.bvhtree import BVHTree
    return BVHTree.FromPolygons([Vector(v) for v in co], [list(p.vertices) for p in me.polygons])


def split_props(meshes, armature=None, overrides=None):
    """Which meshes are the character and which are props shipped beside it (a gun on the floor, a stand).

    The character is the biggest object plus everything touching it (within PROP_GAP of its size), grown
    until nothing more joins; meshes skinned to the kept armature always belong to it. `overrides`
    {object name: bool} is the user's choice and wins. Returns (keep, props, auto) where `auto` is
    {name: True if the automatic rule calls it a prop}. Nothing is deleted here."""
    from mathutils import Vector
    meshes = [m for m in meshes if m.type == 'MESH' and len(m.data.vertices)]
    overrides = overrides or {}
    if len(meshes) <= 1:
        return list(meshes), [], {m.name: False for m in meshes}
    co = {m.name: _world_verts(m) for m in meshes}
    vol = {n: float(np.prod(np.maximum(c.max(0) - c.min(0), 1e-9))) for n, c in co.items()}
    seed = max(meshes, key=lambda m: vol[m.name])
    size = float((co[seed.name].max(0) - co[seed.name].min(0)).max())
    gap = PROP_GAP * size

    def skinned(m):
        return armature is not None and any(md.type == 'ARMATURE' and md.object == armature for md in m.modifiers)

    by_name = {m.name: m for m in meshes}
    group = {seed.name} | {m.name for m in meshes if skinned(m)}
    trees = {n: _bvh_of(co[n], by_name[n].data) for n in group}
    rng = np.random.default_rng(0)
    sample = {}
    for m in meshes:
        c = co[m.name]
        sample[m.name] = c if len(c) <= PROP_SAMPLES else c[rng.choice(len(c), PROP_SAMPLES, replace=False)]
    grew = True
    while grew:
        grew = False
        for m in meshes:
            if m.name in group:
                continue
            near = any(t.find_nearest(Vector(v), gap)[0] is not None
                       for v in sample[m.name] for t in trees.values())
            if not near:  # also the other way round: a big shell around a small piece of the character
                mt = _bvh_of(co[m.name], m.data)
                near = any(mt.find_nearest(Vector(v), gap)[0] is not None for n in group for v in sample[n][:300])
            if near:
                group.add(m.name)
                trees[m.name] = _bvh_of(co[m.name], m.data)
                grew = True
    auto = {m.name: m.name not in group for m in meshes}
    keep = [m for m in meshes if overrides.get(m.name, not auto[m.name])]
    props = [m for m in meshes if m not in keep]
    if not keep:
        raise MpmError("E_NO_MESH", "every object was left out; keep at least the body")
    return keep, props, auto


def prop_groups(props):
    """Props that touch each other form one prop (a gun made of several objects). Returns lists of objects."""
    from mathutils import Vector
    props = list(props)
    if not props:
        return []
    co = {m.name: _world_verts(m) for m in props}
    size = max(float((c.max(0) - c.min(0)).max()) for c in co.values())
    gap = 0.05 * size
    trees = {m.name: _bvh_of(co[m.name], m.data) for m in props}
    left, groups = list(props), []
    while left:
        grp = [left.pop(0)]
        grew = True
        while grew:
            grew = False
            for m in list(left):
                if any(trees[g.name].find_nearest(Vector(v), gap)[0] is not None
                       for g in grp for v in co[m.name][:PROP_SAMPLES]):
                    grp.append(m)
                    left.remove(m)
                    grew = True
        groups.append(grp)
    return groups


# --------------------------------------------------------------------------
# geometry helpers
# --------------------------------------------------------------------------

def _world_verts(obj):
    me = obj.data
    co = np.empty(len(me.vertices) * 3, np.float32)
    me.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3).astype(np.float64)
    M = np.array(obj.matrix_world, np.float64)
    return co @ M[:3, :3].T + M[:3, 3]


def _all_world_verts(meshes):
    arrs = [_world_verts(m) for m in meshes if len(m.data.vertices)]
    if not arrs:
        raise MpmError("E_NO_MESH", "the meshes have no vertices")
    return np.concatenate(arrs)


def _tri_count(me):
    lt = np.empty(len(me.polygons), np.int32)
    me.polygons.foreach_get("loop_total", lt)
    return int((lt - 2).sum())


def _snap_axis(v2, names):
    """Nearest of +-axis for a 2-vector; `names` are the two axis letters. 'Y' / '-Y' style strings."""
    i = 0 if abs(v2[0]) >= abs(v2[1]) else 1
    return ("-" if v2[i] < 0 else "") + names[i]


def suggest_orientation(meshes):
    bpy.context.view_layer.update()
    pts = _all_world_verts(meshes)
    ext = pts.max(0) - pts.min(0)
    vert = 2
    up = "Z"
    reason = None
    if ext[1] > 1.6 * ext[2]:
        up, vert = "Y", 1
        reason = "model appears to lie along Y"
    height = float(ext[vert])
    unit = min(UNIT_SCALE_CANDIDATES,
               key=lambda s: abs(math.log(max(height * s, 1e-12) / TARGET_HEIGHT_M)))
    horiz = [i for i in range(3) if i != vert]
    names = ["XYZ"[i] for i in horiz]
    z = pts[:, vert]
    zmin = z.min()
    feet = pts[z <= zmin + 0.04 * height]
    ankles = pts[(z > zmin + 0.04 * height) & (z <= zmin + 0.10 * height)]
    forward = "-Y" if up == "Z" else "-Z"
    if len(feet) and len(ankles):
        v = feet[:, horiz].mean(0) - ankles[:, horiz].mean(0)
        if np.linalg.norm(v) < 0.01 * height:
            reason = reason or "no clear toe direction"
        else:
            forward = _snap_axis(v, names)
            reason = reason or "toes point %s; height %.4g units -> unit scale %g" % (forward, height, unit)
    else:
        reason = reason or "no clear toe direction"
    return {"up": up, "forward": forward, "unit_scale": float(unit), "reason": reason}


def _axis_vec(s):
    s = str(s).strip().upper()
    sign = -1.0 if s.startswith("-") else 1.0
    letter = s.lstrip("+-")
    if letter not in _AXES:
        raise MpmError("E_ORIENTATION", "bad axis %r" % s)
    return np.array(_AXES[letter]) * sign


def orientation_matrix(orientation):
    """4x4 matrix mapping the given up to +Z and the given forward to -Y, times the uniform unit scale."""
    up = _axis_vec(orientation.get("up", "Z"))
    fwd = _axis_vec(orientation.get("forward", "-Y"))
    if abs(float(np.dot(up, fwd))) > 1e-6:
        raise MpmError("E_ORIENTATION", "up and forward must be perpendicular", dict(orientation))
    scale = float(orientation.get("unit_scale", 1.0))
    if scale <= 0:
        raise MpmError("E_ORIENTATION", "unit_scale must be positive", dict(orientation))
    zs = up
    ys = -fwd
    xs = np.cross(ys, zs)
    R = np.stack([xs, ys, zs], axis=0)  # rows: maps x_s->X, y_s->Y, z_s->Z
    M = np.eye(4)
    M[:3, :3] = R * scale
    return Matrix(M.tolist())


# --------------------------------------------------------------------------
# normalise
# --------------------------------------------------------------------------

def _override(objs, active=None):
    objs = list(objs)
    active = active or objs[0]
    return bpy.context.temp_override(active_object=active, object=active, selected_objects=objs,
                                     selected_editable_objects=objs)


def _apply_transforms(objs, location=True, rotation=True, scale=True):
    with _override(objs):
        bpy.ops.object.transform_apply(location=location, rotation=rotation, scale=scale,
                                       properties=False, isolate_users=True)


def _identity_error(o):
    return max(abs(a - b) for ra, rb in zip(o.matrix_world, Matrix.Identity(4)) for a, b in zip(ra, rb))


def normalise(meshes, armature, orientation):
    """Apply the orientation, bake all transforms into the data, centre on the origin, feet on z = 0.

    Applies every modifier except ARMATURE and removes shape keys (keeping the current mix). Returns a list of
    warning strings.
    """
    warnings = []
    meshes = [m for m in meshes if m.type == 'MESH']
    objs = list(meshes) + ([armature] if armature is not None else [])
    if not meshes:
        raise MpmError("E_NO_MESH", "nothing to normalise")
    M = orientation_matrix(orientation)
    bpy.context.view_layer.update()
    for o in objs:
        mw = o.matrix_world.copy()
        o.parent = None
        o.matrix_parent_inverse = Matrix.Identity(4)
        o.matrix_world = M @ mw
    bpy.context.view_layer.update()
    _apply_transforms(objs)
    bpy.context.view_layer.update()
    for o in objs:
        err = _identity_error(o)
        assert err < 1e-6, "%s: matrix_world is not identity after normalise (err %g)" % (o.name, err)

    pts = _all_world_verts(meshes)
    lo, hi = pts.min(0), pts.max(0)
    t = Vector((-(lo[0] + hi[0]) / 2, -(lo[1] + hi[1]) / 2, -lo[2]))
    for o in objs:
        o.location = t
    bpy.context.view_layer.update()
    _apply_transforms(objs, location=True, rotation=False, scale=False)
    bpy.context.view_layer.update()

    for m in meshes:
        if m.data.users > 1:
            m.data = m.data.copy()
        if m.data.shape_keys is not None:
            with _override([m]):
                bpy.ops.object.shape_key_remove(all=True, apply_mix=True)
        for mod in list(m.modifiers):
            if mod.type == 'ARMATURE':
                continue
            with _override([m]):
                bpy.ops.object.modifier_apply(modifier=mod.name)
    bpy.context.view_layer.update()
    for o in objs:
        err = _identity_error(o)
        assert err < 1e-6, "%s: matrix_world is not identity (err %g)" % (o.name, err)
    return warnings


# --------------------------------------------------------------------------
# proxy
# --------------------------------------------------------------------------

def make_proxy(meshes, max_tris=300_000):
    """Make decimated, hidden `<name>__proxy` copies when the model is too dense. Returns True if made."""
    meshes = [m for m in meshes if m.type == 'MESH']
    total = sum(_tri_count(m.data) for m in meshes)
    if total <= max_tris:
        return False
    ratio = max_tris / total
    for m in meshes:
        p = m.copy()
        p.data = m.data.copy()
        p.name = m.name + "__proxy"
        p.data.name = m.data.name + "__proxy"
        for c in (m.users_collection or [bpy.context.scene.collection]):
            c.objects.link(p)
        mod = p.modifiers.new("mpm_proxy_decimate", 'DECIMATE')
        mod.decimate_type = 'COLLAPSE'
        mod.ratio = ratio
        mod.use_collapse_triangulate = True
        dg = bpy.context.evaluated_depsgraph_get()
        new = bpy.data.meshes.new_from_object(p.evaluated_get(dg))
        p.modifiers.remove(mod)
        old = p.data
        p.data = new
        if old.users == 0:
            bpy.data.meshes.remove(old)
        p["mpm_proxy_of"] = m.name
        p.hide_viewport = True
        p.hide_render = True
        p.hide_set(True)
    return True


# --------------------------------------------------------------------------
# inspect
# --------------------------------------------------------------------------

def inspect(meshes, armature, suggested_orientation=None, proxy=False, warnings=None):
    """The contracts section 16 `import` result fields.

    `suggested_orientation`, `proxy` and `warnings` are optional: the import job passes the suggestion it made
    before normalising; when omitted the suggestion is computed from the current state.
    """
    meshes = [m for m in meshes if m.type == 'MESH']
    objects, mats, nmaps = [], [], []
    missing_maps = []
    tri_total = 0
    for m in meshes:
        me = m.data
        names = [s.material.name for s in m.material_slots if s.material is not None]
        tris = _tri_count(me)
        tri_total += tris
        objects.append({"name": m.name, "verts": len(me.vertices), "tris": tris, "materials": names})
        for n in names:
            if n not in mats:
                mats.append(n)
        for nm in detail.find_normal_maps(m, missing_maps):
            img = nm["image"]
            nmaps.append({"object": m.name, "material": nm["material"], "image": img.name,
                          "size": [int(img.size[0]), int(img.size[1])]})
    pts = _all_world_verts(meshes)
    bones = []
    if armature is not None:
        for b in armature.data.bones:
            bones.append({"name": b.name, "parent": b.parent.name if b.parent else None,
                          "head": [float(x) for x in b.head_local], "tail": [float(x) for x in b.tail_local]})
    return {
        "objects": objects,
        "materials": mats,
        "normal_maps": nmaps,
        "has_armature": armature is not None,
        "armature_bones": bones,
        "tri_count": tri_total,
        "height_m": float(pts[:, 2].max() - pts[:, 2].min()),
        "suggested_orientation": suggested_orientation or suggest_orientation(meshes),
        "proxy": bool(proxy),
        "warnings": list(warnings or []) + (
            ["normal map file(s) not found: %s. Put them beside the model and import again to bake their "
             "surface detail." % ", ".join(missing_maps)] if missing_maps else []),
    }
