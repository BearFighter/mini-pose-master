# SPDX-License-Identifier: GPL-3.0-or-later
"""rig.glb + rig.json + rig.blend export (WP4c; contracts sections 7 and 8)."""

import hashlib
import json
import os
import struct

import bpy
import numpy as np

from .. import detail
from ..protocol import MpmError

MAX_IMAGE_PX = 2048


def _downscale_images(meshes):
    """Scaled copies of images over MAX_IMAGE_PX, swapped into the meshes' materials."""
    done = {}
    for o in meshes:
        for slot in o.material_slots:
            m = slot.material
            if not m or not m.node_tree:
                continue
            for n in m.node_tree.nodes:
                img = getattr(n, "image", None)
                if n.type != 'TEX_IMAGE' or img is None:
                    continue
                w, h = img.size
                if max(w, h) <= MAX_IMAGE_PX:
                    continue
                if img.name not in done:
                    k = MAX_IMAGE_PX / float(max(w, h))
                    cp = img.copy()
                    cp.name = img.name + "_2k"
                    cp.scale(max(1, int(round(w * k))), max(1, int(round(h * k))))
                    done[img.name] = cp
                n.image = done[img.name]
    return len(done)


def parse_glb_json(path):
    """The JSON chunk of a .glb file."""
    with open(path, "rb") as fh:
        magic, version, _length = struct.unpack("<4sII", fh.read(12))
        if magic != b"glTF":
            raise MpmError("E_EXPORT", "not a GLB file: %s" % path)
        clen, ctype = struct.unpack("<II", fh.read(8))
        if ctype != 0x4E4F534A:  # 'JSON'
            raise MpmError("E_EXPORT", "GLB chunk 0 is not JSON")
        return json.loads(fh.read(clen).decode("utf-8"))


def export_glb(arm, meshes, path, images=True):
    """The pinned contracts section 7 export call. images=False only for golden test files."""
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    for o in [arm] + list(meshes):
        o.select_set(True)
    bpy.context.view_layer.objects.active = arm
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=path, export_format='GLB', use_selection=True,
        export_yup=True, export_apply=False, export_skins=True, export_def_bones=False,
        export_rest_position_armature=True, export_influence_nb=4, export_all_influences=False,
        export_animations=False, export_morph=False, export_extras=True, export_attributes=True,
        export_materials='EXPORT' if images else 'NONE',
        export_image_format='AUTO' if images else 'NONE')


def _rest_q(bone):
    q = bone.matrix_local.to_quaternion().normalized()
    v = [q.w, q.x, q.y, q.z]
    if v[0] < 0:
        v = [-x for x in v]
    return [round(float(x), 9) for x in v]


def _finger_radius(bone_name, meshes, bone):
    a, b = np.array(bone.head_local), np.array(bone.tail_local)
    ab = b - a
    ds = []
    for o in meshes:
        g = o.vertex_groups.get(bone_name)
        if g is None:
            continue
        gi = g.index
        for v in o.data.vertices:
            for e in v.groups:
                if e.group == gi and e.weight > 0.5:
                    p = np.array(v.co)
                    t = float(np.clip(np.dot(p - a, ab) / max(float(np.dot(ab, ab)), 1e-12), 0.0, 1.0))
                    ds.append(float(np.linalg.norm(p - (a + t * ab))))
    return round(float(np.mean(ds)), 6) if ds else None


def _weight_sums(meshes, names):
    sums = {n: 0.0 for n in names}
    for o in meshes:
        gi = {g.index: g.name for g in o.vertex_groups}
        for v in o.data.vertices:
            for e in v.groups:
                n = gi.get(e.group)
                if n in sums:
                    sums[n] += e.weight
    return {n: round(s, 4) for n, s in sums.items()}


def export_rig(arm, meshes, project_dir, joints, hands, kind, canonical=None, finger_bones=None):
    """Write rig/rig.glb, rig/rig.json, rig/rig.blend. Returns the rig.json dict.

    canonical: {bone name: canonical name | None}; defaults to identity (auto rigs).
    finger_bones: names that get radius_m; defaults to canonical finger bones.
    """
    from .. import skeleton as SK
    rig_dir = os.path.join(project_dir, "rig")
    os.makedirs(rig_dir, exist_ok=True)
    _downscale_images(meshes)
    glb = os.path.join(rig_dir, "rig.glb")
    export_glb(arm, meshes, glb)
    gj = parse_glb_json(glb)
    node_index = {}
    for i, n in enumerate(gj.get("nodes", [])):
        node_index.setdefault(n.get("name"), i)
    bones = list(arm.data.bones)
    names = [b.name for b in bones]
    index = {n: i for i, n in enumerate(names)}
    canon = canonical if canonical is not None else {n: n for n in names}
    missing = [n for n in names if n not in node_index] + [o.name for o in meshes if o.name not in node_index]
    if missing:
        raise MpmError("E_EXPORT", "nodes missing from rig.glb: %s" % missing[:10])
    out_bones = []
    for i, b in enumerate(bones):
        cn = canon.get(b.name)
        is_finger = (finger_bones is not None and b.name in finger_bones) or \
                    (finger_bones is None and cn is not None and SK.is_finger_bone(cn))
        out_bones.append({
            "index": i, "name": b.name, "canonical": cn,
            "parent": index[b.parent.name] if b.parent else -1,
            "head": [round(float(x), 7) for x in b.head_local],
            "tail": [round(float(x), 7) for x in b.tail_local],
            "rest_q": _rest_q(b), "deform": bool(b.use_deform),
            "gltf_node": node_index[b.name],
            "radius_m": _finger_radius(b.name, meshes, b) if is_finger else None,
        })
    zs = [ (o.matrix_world @ v.co).z for o in meshes for v in o.data.vertices ]
    sums = _weight_sums(meshes, names)
    key = json.dumps([(b["name"], b["parent"], b["head"], b["tail"], b["rest_q"]) for b in out_bones]
                     + [sorted(sums.items())], separators=(",", ":"))
    rig = {
        "schema": "mpm.rig/1",
        "hash": hashlib.sha1(key.encode("utf-8")).hexdigest(),
        "kind": kind,
        "height_m": round(float(max(zs) - min(zs)), 6),
        "floor_z": round(float(min(zs)), 6),
        "bones": out_bones,
        "meshes": [{"name": o.name, "gltf_node": node_index[o.name], "vertices": len(o.data.vertices),
                    "normal_map": bool(detail.find_normal_maps(o))} for o in meshes],
        "joints": {k: [round(float(x), 7) for x in v] for k, v in joints.items()},
        "hands": {s: (None if hands.get(s) is None else
                      {k: ([round(float(x), 7) for x in v] if hasattr(v, "__len__") else round(float(v), 7))
                       for k, v in hands[s].items()}) for s in ("L", "R")},
    }
    with open(os.path.join(rig_dir, "rig.json"), "w", encoding="utf-8") as fh:
        json.dump(rig, fh, indent=1)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(rig_dir, "rig.blend"), compress=True)
    return rig
