# SPDX-License-Identifier: GPL-3.0-or-later
"""Build the canonical armature from derived joints (WP4c)."""

import bpy
from mathutils import Matrix, Vector

from .. import skeleton as SK


def build_armature(joints, hands, name="Armature"):
    """Create the canonical armature at identity, bones in skeleton order.

    Roll: finger and grip bones align local Z with the side's palm normal (contracts section 3);
    other bones align Z with -Y, or +Z when the bone itself runs along Y.
    """
    arm = bpy.data.armatures.new(name)
    ob = bpy.data.objects.new(name, arm)
    bpy.context.scene.collection.objects.link(ob)
    ob.matrix_world = Matrix.Identity(4)
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.mode_set(mode='EDIT')
    eb = arm.edit_bones
    for b in SK.BONES:
        e = eb.new(b["name"])
        e.head = Vector(joints[b["head"]])
        e.tail = Vector(joints[b["tail"]])
        d = (e.tail - e.head).normalized()
        side = SK.side_of(b["name"])
        if side and (SK.is_finger_bone(b["name"]) or b["name"].startswith("grip.")):
            e.align_roll(Vector(hands[side]["palm_normal"]))
        else:
            e.align_roll(Vector((0, 0, 1)) if abs(d.y) > 0.9 else Vector((0, -1, 0)))
        e.use_deform = bool(b["deform"])
        e.bbone_segments = 1
        if b["parent"]:
            e.parent = eb[b["parent"]]
            e.use_connect = bool(b["connected"])
    bpy.ops.object.mode_set(mode='OBJECT')
    for pb in ob.pose.bones:
        pb.rotation_mode = 'QUATERNION'
    return ob
