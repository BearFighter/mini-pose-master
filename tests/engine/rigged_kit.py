# SPDX-License-Identifier: GPL-3.0-or-later
"""A real kit with a skeleton of its own, for the "use the model's own skeleton" path.

No kit ships a skeleton, so one is put on the real meshes: the joints of the kit's cached auto rig
(rig/rig.json) become an armature in a real exporter's naming convention (Mixamo, Unreal mannequin,
3ds Max Biped: their bone names, extra end / twist / IK / metacarpal bones, different spine chains and the
armature object transforms such exports have), the kit's meshes keep the weights of the auto rig under the
new bone names, and the result is exported as FBX the way that convention usually arrives:

  mixamo   "mixamorig:" names, end bones; armature object scale 0.01 and +90 degrees about X;
           FBX axis_up='Y', axis_forward='-Z', global_scale=100 (centimetres)
  ue       root / IK / twist / metacarpal bones, five spine bones, two neck bones; twist bones carry half
           of their parent's weights on the far half of the limb; FBX Z up, global_scale=100 (centimetres)
  biped    "Bip01 ..." names, no end bones; FBX Z up, metres

  rigged_variant(kit_name, convention) -> path of the FBX (cached in tests/local/cache/_variants)
  expected_mapping(kit_name, convention) -> {bone name: canonical bone or None}, the mapping built in
"""
import math
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import kit_variants  # noqa: E402
import kits  # noqa: E402

FINGERS = ["thumb", "index", "middle", "ring", "pinky"]


def nrm(v):
    v = np.asarray(v, dtype=np.float64)
    return v / np.linalg.norm(v)


def lerp(a, b, t):
    return a + t * (b - a)


def end_dir(a, b, length):
    return b + nrm(b - a) * length


# ---------------------------------------------------------------------------------------------------
# conventions: lists of (bone name, head, tail, parent name or None, canonical bone or None)

def mixamo_spec(J):
    P = "mixamorig:"
    B = []

    def add(n, h, t, p, c):
        B.append((P + n, np.asarray(h), np.asarray(t), (P + p) if p else None, c))

    m1 = lerp(J["spine0"], J["chest"], 0.5)
    add("Hips", J["pelvis"], J["spine0"], None, "hips")
    add("Spine", J["spine0"], m1, "Hips", "spine")
    add("Spine1", m1, J["chest"], "Spine", None)
    add("Spine2", J["chest"], J["neck"], "Spine1", "chest")
    add("Neck", J["neck"], J["head"], "Spine2", "neck")
    add("Head", J["head"], J["head_top"], "Neck", "head")
    add("HeadTop_End", J["head_top"], J["head_top"] + np.array([0, 0, 0.05]), "Head", None)
    for s, S in (("L", "Left"), ("R", "Right")):
        j = lambda n: J["%s_%s" % (n, s)]  # noqa: E731
        add(S + "Shoulder", j("clav"), j("shoulder"), "Spine2", "shoulder." + s)
        add(S + "Arm", j("shoulder"), j("elbow"), S + "Shoulder", "upper_arm." + s)
        add(S + "ForeArm", j("elbow"), j("wrist"), S + "Arm", "forearm." + s)
        add(S + "Hand", j("wrist"), j("middle_0"), S + "ForeArm", "hand." + s)
        for f in FINGERS:
            pts = [j(f + "_0"), j(f + "_1"), j(f + "_2"), j(f + "_tip")]
            prev = S + "Hand"
            for k in (1, 2, 3):
                nm_ = "%sHand%s%d" % (S, f.capitalize(), k)
                add(nm_, pts[k - 1], pts[k], prev, "%s.0%d.%s" % (f, k, s))
                prev = nm_
            add("%sHand%s4" % (S, f.capitalize()), pts[3], end_dir(pts[2], pts[3], 0.02), prev, None)
        add(S + "UpLeg", j("hip"), j("knee"), "Hips", "thigh." + s)
        add(S + "Leg", j("knee"), j("ankle"), S + "UpLeg", "shin." + s)
        add(S + "Foot", j("ankle"), j("ball"), S + "Leg", "foot." + s)
        add(S + "ToeBase", j("ball"), j("toe"), S + "Foot", "toe." + s)
        add(S + "Toe_End", j("toe"), end_dir(j("ball"), j("toe"), 0.04), S + "ToeBase", None)
    return B


def ue_spec(J):
    B = []

    def add(n, h, t, p, c):
        B.append((n, np.asarray(h), np.asarray(t), p, c))

    z = np.zeros(3)
    add("root", z, np.array([0, 0, 0.1]), None, None)
    add("pelvis", J["pelvis"], J["spine0"], "root", "hips")
    pts = [lerp(J["spine0"], J["chest"], k / 4.0) for k in range(5)] + [J["neck"]]
    prev = "pelvis"
    for k in range(5):
        nm_ = "spine_0%d" % (k + 1)
        add(nm_, pts[k], pts[k + 1], prev, "spine" if k == 0 else ("chest" if k == 4 else None))
        prev = nm_
    nm1 = lerp(J["neck"], J["head"], 0.5)
    add("neck_01", J["neck"], nm1, "spine_05", "neck")
    add("neck_02", nm1, J["head"], "neck_01", None)
    add("head", J["head"], J["head_top"], "neck_02", "head")
    add("ik_foot_root", z, np.array([0, 0, 0.1]), "root", None)
    add("ik_hand_root", z, np.array([0, 0, 0.1]), "root", None)
    add("ik_hand_gun", J["wrist_R"], J["middle_0_R"], "ik_hand_root", None)
    for s in ("l", "r"):
        S = s.upper()
        j = lambda n: J["%s_%s" % (n, S)]  # noqa: E731
        add("clavicle_" + s, j("clav"), j("shoulder"), "spine_05", "shoulder." + S)
        add("upperarm_" + s, j("shoulder"), j("elbow"), "clavicle_" + s, "upper_arm." + S)
        add("lowerarm_" + s, j("elbow"), j("wrist"), "upperarm_" + s, "forearm." + S)
        add("hand_" + s, j("wrist"), j("middle_0"), "lowerarm_" + s, "hand." + S)
        add("upperarm_twist_01_" + s, lerp(j("shoulder"), j("elbow"), 0.5), j("elbow"), "upperarm_" + s, None)
        add("lowerarm_twist_01_" + s, lerp(j("elbow"), j("wrist"), 0.5), j("wrist"), "lowerarm_" + s, None)
        for f in FINGERS:
            fp = [j(f + "_0"), j(f + "_1"), j(f + "_2"), j(f + "_tip")]
            prev = "hand_" + s
            if f != "thumb":
                nm_ = "%s_metacarpal_%s" % (f, s)
                add(nm_, j("wrist"), j(f + "_0"), prev, None)
                prev = nm_
            for k in (1, 2, 3):
                nm_ = "%s_0%d_%s" % (f, k, s)
                add(nm_, fp[k - 1], fp[k], prev, "%s.0%d.%s" % (f, k, S))
                prev = nm_
        add("thigh_" + s, j("hip"), j("knee"), "pelvis", "thigh." + S)
        add("calf_" + s, j("knee"), j("ankle"), "thigh_" + s, "shin." + S)
        add("foot_" + s, j("ankle"), j("ball"), "calf_" + s, "foot." + S)
        add("ball_" + s, j("ball"), j("toe"), "foot_" + s, "toe." + S)
        add("thigh_twist_01_" + s, lerp(j("hip"), j("knee"), 0.5), j("knee"), "thigh_" + s, None)
        add("calf_twist_01_" + s, lerp(j("knee"), j("ankle"), 0.5), j("ankle"), "calf_" + s, None)
        an, ba = j("ankle"), j("ball")
        add("ik_foot_" + s, np.array([an[0], an[1], 0.0]), np.array([ba[0], ba[1], 0.0]), "ik_foot_root", None)
        add("ik_hand_" + s, j("wrist"), j("middle_0"), "ik_hand_gun", None)
    return B


def biped_spec(J):
    B = []

    def add(n, h, t, p, c):
        B.append((n, np.asarray(h), np.asarray(t), p, c))

    add("Bip01", J["pelvis"], J["pelvis"] + np.array([0, 0, -0.05]), None, None)
    add("Bip01 Pelvis", J["pelvis"], J["spine0"], "Bip01", "hips")
    add("Bip01 Spine", J["spine0"], J["chest"], "Bip01 Pelvis", "spine")
    add("Bip01 Spine1", J["chest"], J["neck"], "Bip01 Spine", "chest")
    add("Bip01 Neck", J["neck"], J["head"], "Bip01 Spine1", "neck")
    add("Bip01 Head", J["head"], J["head_top"], "Bip01 Neck", "head")
    fnum = {"thumb": 0, "index": 1, "middle": 2, "ring": 3, "pinky": 4}
    for s in ("L", "R"):
        j = lambda n: J["%s_%s" % (n, s)]  # noqa: E731
        pre = "Bip01 %s " % s
        add(pre + "Clavicle", j("clav"), j("shoulder"), "Bip01 Spine1", "shoulder." + s)
        add(pre + "UpperArm", j("shoulder"), j("elbow"), pre + "Clavicle", "upper_arm." + s)
        add(pre + "Forearm", j("elbow"), j("wrist"), pre + "UpperArm", "forearm." + s)
        add(pre + "Hand", j("wrist"), j("middle_0"), pre + "Forearm", "hand." + s)
        for f in FINGERS:
            fp = [j(f + "_0"), j(f + "_1"), j(f + "_2"), j(f + "_tip")]
            fn = fnum[f]
            names = ["%sFinger%d" % (pre, fn), "%sFinger%d1" % (pre, fn) if fn else "%sFinger01" % pre,
                     "%sFinger%d2" % (pre, fn) if fn else "%sFinger02" % pre]
            prev = pre + "Hand"
            for k in range(3):
                add(names[k], fp[k], fp[k + 1], prev, "%s.0%d.%s" % (f, k + 1, s))
                prev = names[k]
        add(pre + "Thigh", j("hip"), j("knee"), "Bip01 Pelvis", "thigh." + s)
        add(pre + "Calf", j("knee"), j("ankle"), pre + "Thigh", "shin." + s)
        add(pre + "Foot", j("ankle"), j("ball"), pre + "Calf", "foot." + s)
        add(pre + "Toe0", j("ball"), j("toe"), pre + "Foot", "toe." + s)
    return B


# convention -> spec, the FBX export settings and the armature object transform such files come with
CONVENTIONS = {
    "mixamo": {"spec": mixamo_spec, "up": "Y", "forward": "-Z", "unit_scale": 0.01,
               "arm_rot": (math.radians(90.0), 0.0, 0.0), "arm_scale": 0.01},
    "ue": {"spec": ue_spec, "up": "Z", "forward": "-Y", "unit_scale": 0.01},
    "biped": {"spec": biped_spec, "up": "Z", "forward": "-Y", "unit_scale": 1.0},
}


def spec_of(kit_name, convention):
    """The bone list of a convention on the kit's own joints (from its cached auto rig)."""
    J = {k: np.array(v, dtype=np.float64) for k, v in kits.project(kit_name, "rig").rig["joints"].items()}
    return CONVENTIONS[convention]["spec"](J)


def expected_mapping(kit_name, convention):
    """{bone name: canonical bone or None} for every bone of the variant: what suggest_mapping must find."""
    return {n: c for n, _h, _t, _p, c in spec_of(kit_name, convention)}


def rigged_variant(kit_name, convention):
    """The kit with a skeleton in the given convention ("mixamo", "ue", "biped") as an FBX with its textures
    embedded. Built once from the kit's cached auto rig; returns the path."""
    assert convention in CONVENTIONS, convention
    kits.project(kit_name, "rig")
    out = os.path.join(kit_variants.cache_dir(kit_name), "%s_rigged_%s.fbx" % (kit_name, convention))
    return kit_variants.build("rigged_kit.py", out, kit_name, convention)


# ---------------------------------------------------------------------------------------------------
# the build (inside its own Blender)

def build_armature(name, spec, arm_loc=(0, 0, 0), arm_rot=(0, 0, 0), arm_scale=1.0):
    """An armature object with the given transform whose bones sit at the spec's world-space heads/tails."""
    import bpy
    from mathutils import Vector
    ad = bpy.data.armatures.new(name)
    arm = bpy.data.objects.new(name, ad)
    bpy.context.scene.collection.objects.link(arm)
    arm.location = arm_loc
    arm.rotation_euler = arm_rot
    arm.scale = (arm_scale,) * 3
    bpy.context.view_layer.update()
    inv = arm.matrix_world.inverted()
    bpy.context.view_layer.objects.active = arm
    for o in bpy.context.view_layer.objects:
        o.select_set(o == arm)
    with bpy.context.temp_override(active_object=arm, object=arm, selected_objects=[arm],
                                   selected_editable_objects=[arm]):
        bpy.ops.object.mode_set(mode="EDIT")
        ebs = {}
        for n, h, t, _p, _c in spec:
            eb = ad.edit_bones.new(n)
            eb.head = inv @ Vector(tuple(float(x) for x in h))
            eb.tail = inv @ Vector(tuple(float(x) for x in t))
            ebs[n] = eb
        for n, _h, _t, p, _c in spec:
            if p:
                ebs[n].parent = ebs[p]
        bpy.ops.object.mode_set(mode="OBJECT")
    return arm


def rename_weights(meshes, spec):
    """The auto rig's vertex groups (canonical bone names) become the convention's bones; others go."""
    to = {c: n for n, _h, _t, _p, c in spec if c}
    for o in meshes:
        for m in list(o.modifiers):
            if m.type == 'ARMATURE':
                o.modifiers.remove(m)
        for g in list(o.vertex_groups):
            if g.name in to:
                g.name = "__mpm_tmp__" + g.name    # two steps: a new name may equal another old name
            else:
                o.vertex_groups.remove(g)
        for g in o.vertex_groups:
            g.name = to[g.name[len("__mpm_tmp__"):]]


def share_with_twist_bones(meshes, spec):
    """Twist bones take half of their parent's weight on the vertices beside them (the far half of the
    limb), as exported twist bones carry real weights although they map to no canonical bone."""
    by_name = {n: (h, t) for n, h, t, _p, _c in spec}
    for n, h, _t, p, c in spec:
        if c is not None or "twist" not in n or p is None:
            continue
        a, b = by_name[p]
        ab = b - a
        for o in meshes:
            gp = o.vertex_groups.get(p)
            if gp is None:
                continue
            gt = o.vertex_groups.get(n) or o.vertex_groups.new(name=n)
            for v in o.data.vertices:
                w = next((e.weight for e in v.groups if e.group == gp.index), 0.0)
                if w <= 0.0:
                    continue
                if float(np.dot(np.array(v.co) - a, ab) / np.dot(ab, ab)) > 0.5:
                    gp.add([v.index], w * 0.5, 'REPLACE')
                    gt.add([v.index], w * 0.5, 'REPLACE')


def _main(argv):
    import bpy
    out, kit_name, convention = argv[0], argv[1], argv[2]
    cv = CONVENTIONS[convention]
    old_arm, meshes, rig = kits.open_rig(kit_name)
    J = {k: np.array(v, dtype=np.float64) for k, v in rig["joints"].items()}
    spec = cv["spec"](J)
    rename_weights(meshes, spec)
    bpy.data.objects.remove(old_arm, do_unlink=True)
    share_with_twist_bones(meshes, spec)
    arm = build_armature("Armature", spec, arm_rot=cv.get("arm_rot", (0, 0, 0)), arm_scale=cv.get("arm_scale", 1.0))
    for o in meshes:
        mod = o.modifiers.new("Armature", 'ARMATURE')
        mod.object = arm
        o.parent = arm
        o.matrix_parent_inverse = arm.matrix_world.inverted()
    bpy.context.view_layer.update()
    kit_variants.export_fbx(out, [arm] + meshes, up=cv["up"], forward=cv["forward"],
                            scale=1.0 / cv["unit_scale"], textures=True)
    print("RIGGED", kit_name, convention, "bones", len(spec), "meshes", len(meshes))


if __name__ == "__main__":
    _main(sys.argv[sys.argv.index("--") + 1:])
