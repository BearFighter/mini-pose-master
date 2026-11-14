# SPDX-License-Identifier: GPL-3.0-or-later
"""Imported (pre-rigged) characters: bone-name mapping to the canonical skeleton and rig
normalisation/export (WP4d; contracts sections 7, 8 "Imported rigs", 16 suggest_mapping)."""

import math
import os
import re
import time

import bpy
import numpy as np
from mathutils import Matrix, Vector

from .. import pose as PO
from .. import protocol
from .. import skeleton as SK
from . import export
from . import skin as SKN

FINGER_KEYS = {"thumb": "thumb", "index": "index", "middle": "middle", "ring": "ring", "pinky": "pinky"}


def _depth(b):
    d = 0
    while b.parent is not None:
        d += 1
        b = b.parent
    return d


def detect_convention(names):
    base = {re.sub(r"^.*:", "", n) for n in names}
    if "Hips" in base and "LeftUpLeg" in base:
        return "mixamo"
    if "pelvis" in base and "upperarm_l" in base:
        return "ue"
    if any(re.match(r"^Bip0*1\b", n) for n in names):
        return "biped"
    if any(n.startswith("DEF-") for n in names):
        return "rigify"
    return "unknown"


# ---- per-convention parsers: base name -> canonical (without spine/chest resolution) ------------------

_MIXAMO_SIDE = {"Shoulder": "shoulder", "Arm": "upper_arm", "ForeArm": "forearm", "Hand": "hand",
                "UpLeg": "thigh", "Leg": "shin", "Foot": "foot", "ToeBase": "toe"}


def _mixamo(base):
    m = re.match(r"^(Left|Right)(.+)$", base)
    if m:
        s = "L" if m.group(1) == "Left" else "R"
        stem = m.group(2)
        if stem in _MIXAMO_SIDE:
            return "%s.%s" % (_MIXAMO_SIDE[stem], s)
        f = re.match(r"^Hand(Thumb|Index|Middle|Ring|Pinky)([1-3])$", stem)
        if f:
            return "%s.0%s.%s" % (f.group(1).lower(), f.group(2), s)
        return None
    return {"Hips": "hips", "Neck": "neck", "Head": "head"}.get(base)


_UE_SIDE = {"clavicle": "shoulder", "upperarm": "upper_arm", "lowerarm": "forearm", "hand": "hand",
            "thigh": "thigh", "calf": "shin", "foot": "foot", "ball": "toe"}


def _ue(base):
    if "twist" in base or base.startswith("ik_") or base == "root" or "metacarpal" in base:
        return None
    m = re.match(r"^(.+)_(l|r)$", base)
    if m:
        s = m.group(2).upper()
        stem = m.group(1)
        if stem in _UE_SIDE:
            return "%s.%s" % (_UE_SIDE[stem], s)
        f = re.match(r"^(thumb|index|middle|ring|pinky)_0([1-3])$", stem)
        if f:
            return "%s.0%s.%s" % (f.group(1), f.group(2), s)
        return None
    return {"pelvis": "hips", "neck_01": "neck", "head": "head"}.get(base)


_BIP_SIDE = {"Clavicle": "shoulder", "UpperArm": "upper_arm", "Forearm": "forearm", "Hand": "hand",
             "Thigh": "thigh", "Calf": "shin", "Foot": "foot", "Toe0": "toe"}
_BIP_FINGER = {"0": "thumb", "1": "index", "2": "middle", "3": "ring", "4": "pinky"}


def _biped(name):
    m = re.match(r"^Bip0*1(?:\s+(.*))?$", name)
    if not m or not m.group(1):
        return None
    rest = m.group(1)
    sm = re.match(r"^(L|R)\s+(.+)$", rest)
    if sm:
        s, stem = sm.group(1), sm.group(2)
        if stem in _BIP_SIDE:
            return "%s.%s" % (_BIP_SIDE[stem], s)
        f = re.match(r"^Finger([0-4])([12]?)$", stem)
        if f:
            k = {"": 1, "1": 2, "2": 3}[f.group(2)]
            return "%s.0%d.%s" % (_BIP_FINGER[f.group(1)], k, s)
        return None
    return {"Pelvis": "hips", "Neck": "neck", "Head": "head"}.get(rest)


_RIGIFY = {"DEF-spine": "hips", "DEF-spine.001": "spine", "DEF-spine.003": "chest",
           "DEF-spine.004": "neck", "DEF-spine.006": "head"}
_RIGIFY_SIDE = {"DEF-shoulder": "shoulder", "DEF-upper_arm": "upper_arm", "DEF-forearm": "forearm",
                "DEF-hand": "hand", "DEF-thigh": "thigh", "DEF-shin": "shin", "DEF-foot": "foot", "DEF-toe": "toe"}


def _rigify(name):
    if name in _RIGIFY:
        return _RIGIFY[name]
    m = re.match(r"^(DEF-[a-z_]+)\.(L|R)$", name)
    if m and m.group(1) in _RIGIFY_SIDE:
        return "%s.%s" % (_RIGIFY_SIDE[m.group(1)], m.group(2))
    f = re.match(r"^DEF-(?:f_)?(thumb|index|middle|ring|pinky)\.0([1-3])\.(L|R)$", name)
    if f:
        return "%s.0%s.%s" % (f.group(1), f.group(2), f.group(3))
    return None


def _spine_bones(bones, conv):
    """Bones forming the spine chain for 'spine'/'chest' resolution: (first -> spine, deepest -> chest)."""
    if conv == "mixamo":
        pat = r"^Spine\d*$"
        key = lambda b: re.sub(r"^.*:", "", b.name)
    elif conv == "ue":
        pat = r"^spine_0\d$"
        key = lambda b: b.name
    elif conv == "biped":
        pat = r"^Spine\d*$"
        key = lambda b: (re.match(r"^Bip0*1\s+(.*)$", b.name) or re.match("(.*)", "")).group(1)
    else:
        return []
    return [b for b in bones if re.match(pat, key(b) or "")]


def suggest_mapping(arm):
    """contracts section 16 suggest_mapping result for an armature object."""
    bones = list(arm.data.bones)
    names = [b.name for b in bones]
    conv = detect_convention(names)
    mapping = {n: None for n in names}
    if conv == "unknown":
        return {"convention": conv, "mapping": {}, "unmapped_canonical": [b["name"] for b in SK.BONES],
                "confidence": 0.0}
    for b in bones:
        base = re.sub(r"^.*:", "", b.name)
        if conv == "mixamo":
            mapping[b.name] = _mixamo(base)
        elif conv == "ue":
            mapping[b.name] = _ue(base)
        elif conv == "biped":
            mapping[b.name] = _biped(b.name)
        elif conv == "rigify":
            mapping[b.name] = _rigify(b.name) if b.name.startswith("DEF-") else None
    spine = _spine_bones(bones, conv)
    if spine:
        spine.sort(key=_depth)
        mapping[spine[0].name] = "spine"
        if len(spine) > 1:
            mapping[spine[-1].name] = "chest"
    # one bone per canonical name (keep the first, in bone order)
    seen = set()
    for n in names:
        c = mapping[n]
        if c is None:
            continue
        if c in seen:
            mapping[n] = None
        seen.add(c)
    canon = {b["name"] for b in SK.BONES}
    found = {c for c in mapping.values() if c}
    unmapped = [b["name"] for b in SK.BONES if b["name"] not in found and not b["name"].startswith("grip.")]
    return {"convention": conv, "mapping": mapping, "unmapped_canonical": unmapped,
            "confidence": round(len(found & canon) / float(len(SK.BONES)), 2)}


# ---------------------------------------------------------------------------------------------------

def _normalise_armature(arm):
    """contracts section 7.2 for imported rigs."""
    arm.animation_data_clear()
    for pb in arm.pose.bones:
        for c in list(pb.constraints):
            pb.constraints.remove(c)
        pb.rotation_mode = 'QUATERNION'
        pb.matrix_basis = Matrix.Identity(4)
    if not np.allclose(np.array(arm.matrix_world), np.eye(4), atol=1e-6):
        raise protocol.MpmError("E_INTERNAL", "imported armature is not at identity after import normalisation")
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode='EDIT')
    for e in arm.data.edit_bones:
        e.use_inherit_rotation = True
        e.inherit_scale = 'FULL'
        e.bbone_segments = 1
    bpy.ops.object.mode_set(mode='OBJECT')
    bpy.context.view_layer.update()


def joints_from_mapping(arm, mapping):
    """Canonical joints from mapped bones (heads; tails for end joints), then section 4 rules."""
    by_canon = {c: arm.data.bones[n] for n, c in mapping.items() if c and n in arm.data.bones}
    heads = {b["head"] for b in SK.BONES}
    J = {}
    for b in SK.BONES:
        bone = by_canon.get(b["name"])
        if bone is None:
            continue
        J[b["head"]] = np.array(bone.head_local)
        if b["tail"] not in heads:  # end joint: head_top, *_tip, toe, grip_tip
            J[b["tail"]] = np.array(bone.tail_local)
    # section 4 derived joints where inputs exist
    if "spine0" not in J and "pelvis" in J and "chest" in J:
        J["spine0"] = J["pelvis"] + 0.30 * (J["chest"] - J["pelvis"])
    hands = {}
    for s, sign in (("L", 1.0), ("R", -1.0)):
        if all(k in J for k in ("pelvis", "neck", "shoulder_" + s)) and "clav_" + s not in J:
            sh, pel, neck = J["shoulder_" + s], J["pelvis"], J["neck"]
            J["clav_" + s] = np.array([pel[0] + sign * 0.18 * abs(sh[0] - pel[0]), neck[1],
                                       neck[2] - 0.25 * (neck[2] - sh[2])])
        if all(k in J for k in ("ankle_" + s, "toe_" + s)) and "ball_" + s not in J:
            a, t = J["ankle_" + s], J["toe_" + s]
            bl = a + 0.68 * (t - a)
            bl[2] = 0.35 * a[2] + 0.65 * t[2]
            J["ball_" + s] = bl
        need = ["wrist_" + s] + ["%s_0_%s" % (f, s) for f in ("index", "middle", "ring", "pinky", "thumb")]
        if all(k in J for k in need):
            fr = SK.hand_frame(J, s)
            centre = np.mean([J["index_0_" + s], J["middle_0_" + s], J["ring_0_" + s], J["pinky_0_" + s],
                              J["wrist_" + s]], axis=0)
            J["grip_" + s] = centre + fr["palm_normal"] * 0.35 * fr["hand_width"]
            J["grip_tip_" + s] = J["grip_" + s] + fr["grip_axis"] * 0.10
            hands[s] = fr
        else:
            hands[s] = None
    return J, hands


def _add_grip_bones(arm, mapping, J, hands):
    """Non-deform mpm_grip.L/R under the mapped hand bones (only with all five .01 fingers mapped)."""
    added = {}
    canon_to_name = {c: n for n, c in mapping.items() if c}
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode='EDIT')
    for s in ("L", "R"):
        if hands.get(s) is None or "hand." + s not in canon_to_name:
            continue
        if not all(("%s.01.%s" % (f, s)) in canon_to_name for f in SK.FINGERS):
            continue
        e = arm.data.edit_bones.new("mpm_grip." + s)
        e.head = Vector(J["grip_" + s])
        e.tail = Vector(J["grip_tip_" + s])
        e.align_roll(Vector(hands[s]["palm_normal"]))
        e.use_deform = False
        e.bbone_segments = 1
        e.parent = arm.data.edit_bones[canon_to_name["hand." + s]]
        e.use_connect = False
        added["mpm_grip." + s] = "grip." + s
    bpy.ops.object.mode_set(mode='OBJECT')
    for pb in arm.pose.bones:
        pb.rotation_mode = 'QUATERNION'
    return added


def _reweight(meshes, arm):
    """Keep the asset's own weights; apply the section 7 parity rules (reusing WP4c's functions)."""
    bones = list(arm.data.bones)
    names = [b.name for b in bones]
    deform = np.array([bool(b.use_deform) for b in bones])
    col = {n: i for i, n in enumerate(names)}
    for o in meshes:
        gi = {g.index: g.name for g in o.vertex_groups}
        W = np.zeros((len(o.data.vertices), len(names)))
        for v in o.data.vertices:
            for e in v.groups:
                n = gi.get(e.group)
                if n in col and deform[col[n]]:
                    W[v.index, col[n]] = e.weight
        co = SKN._world_co(o)
        W = SKN.parity(W, co)
        SKN._write_groups(o, W, names, deform)
        SKN.setup_modifier(o, arm)
        SKN.add_orig_index(o)


def rig_imported(arm, meshes, project_dir, mapping):
    """Normalise an imported rig, add grip sockets, enforce weight parity, self-check, export."""
    t0 = time.time()
    _normalise_armature(arm)
    mapping = {n: mapping.get(n) for n in [b.name for b in arm.data.bones]}
    J, hands = joints_from_mapping(arm, mapping)
    added = _add_grip_bones(arm, mapping, J, hands)
    mapping.update(added)
    for o in meshes:
        for m in list(o.modifiers):
            if m.type == 'ARMATURE' and m.object is not arm:
                o.modifiers.remove(m)
    _reweight(meshes, arm)
    zs = [(o.matrix_world @ v.co).z for o in meshes for v in o.data.vertices]
    H = float(max(zs) - min(zs))
    bones = list(arm.data.bones)
    names = [b.name for b in bones]
    canon_to_idx = {c: names.index(n) for n, c in mapping.items() if c}
    deltas = {}
    for c, ang in (("upper_arm.L", 40.0), ("thigh.R", -30.0)):
        if c in canon_to_idx:
            b = bones[canon_to_idx[c]]
            R = b.matrix_local.to_3x3()
            q = (R @ Matrix.Rotation(math.radians(ang), 3, 'X') @ R.transposed()).to_quaternion()
            deltas[canon_to_idx[c]] = [q.w, q.x, q.y, q.z]
    PO.apply_pose_state(arm, deltas, hips_index=canon_to_idx.get("hips"))
    chk = PO.follow_check(arm, meshes, H)
    PO.gate(chk, posed_any=bool(deltas))
    PO.rest_pose(arm)
    finger_bones = {n for n, c in mapping.items() if c and SK.is_finger_bone(c)}
    rig = export.export_rig(arm, meshes, project_dir, J, hands, "imported", canonical=mapping,
                            finger_bones=finger_bones)
    return rig, chk, round(time.time() - t0, 1)


def find_armature():
    arms = [o for o in bpy.data.objects if o.type == 'ARMATURE']
    if not arms:
        raise protocol.MpmError("E_ARGS", "the model has no armature")
    return max(arms, key=lambda a: len(a.data.bones))


def rig_imported_job(job):
    """Called by engine/jobs/rig.py when args.mapping is given ({} = use the suggested mapping)."""
    arm = find_armature()
    mapping = job["args"].get("mapping") or suggest_mapping(arm)["mapping"]
    if not mapping:
        raise protocol.MpmError("E_ARGS", "no bone mapping (unknown skeleton convention); map the bones manually")
    meshes = [o for o in bpy.data.objects if o.type == 'MESH' and "mpm_proxy_of" not in o]
    rig, chk, secs = rig_imported(arm, meshes, os.path.abspath(job["project_dir"]), mapping)
    return {"rig_json": "rig/rig.json", "rig_glb": "rig/rig.glb", "follow": chk,
            "bones": len(rig["bones"]), "hash": rig["hash"], "seconds": secs}
