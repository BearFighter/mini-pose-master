# SPDX-License-Identifier: GPL-3.0-or-later
"""Per-source settings for clip conversion: joint maps, units, end-site handling, rotation calibration.

Joint specs (canonical joint -> source):
  "Name"                      the source joint's position
  ("end_or_dir", "Name", L)   the joint's End Site if it has non-zero length, else the joint position
                              plus L metres along the joint's own offset axis (rotated by its world
                              rotation) - Bandai's End Sites have zero length
  ("first", "A", "B")         the first of the named joints that exists

Calibration (how each joint's local forward / palm / up axes are found):
  "neutral_first_frames"  clips open in a neutral stance (head forward, arms down with palms toward the
                          thighs, feet flat); learn the local axes from frames 0..9 (Bandai)
  "rest_tpose"            the zero-rotation pose is a T-pose facing +Z (BVH) with palms down
"""

SIDES = (("L", "Left", "_L"), ("R", "Right", "_R"))


def _sided(fn):
    out = {}
    for s, word, suf in SIDES:
        out.update(fn(s, word, suf))
    return out


BANDAI = {
    "unit": 0.01,
    "calibration": "neutral_first_frames",
    "joints": {
        "pelvis": "Hips", "spine0": "Spine", "chest": "Chest", "neck": "Neck", "head": "Head",
        "head_top": ("end_or_dir", "Head", 0.20),
        **_sided(lambda s, w, suf: {
            "clav_" + s: "Shoulder" + suf, "shoulder_" + s: "UpperArm" + suf, "elbow_" + s: "LowerArm" + suf,
            "wrist_" + s: "Hand" + suf, "middle_0_" + s: ("end_or_dir", "Hand" + suf, 0.09),
            "hip_" + s: "UpperLeg" + suf, "knee_" + s: "LowerLeg" + suf, "ankle_" + s: "Foot" + suf,
            "ball_" + s: "Toes" + suf, "toe_" + s: ("end_or_dir", "Toes" + suf, 0.06)}),
    },
}

LAFAN1 = {
    "unit": 0.01,
    "calibration": "rest_tpose",
    "joints": {
        "pelvis": "Hips", "spine0": "Spine", "chest": "Spine2", "neck": "Neck", "head": "Head",
        "head_top": ("end_or_dir", "Head", 0.20),
        **_sided(lambda s, w, suf: {
            "clav_" + s: w + "Shoulder", "shoulder_" + s: w + "Arm", "elbow_" + s: w + "ForeArm",
            "wrist_" + s: w + "Hand", "middle_0_" + s: ("end_or_dir", w + "Hand", 0.09),
            "hip_" + s: w + "UpLeg", "knee_" + s: w + "Leg", "ankle_" + s: w + "Foot",
            "ball_" + s: w + "Toe", "toe_" + s: ("end_or_dir", w + "Toe", 0.06)}),
    },
}

CMU = {
    "unit": None,  # auto: scale the rest pose to 1.75 m
    "calibration": "rest_tpose",
    "joints": {
        "pelvis": "Hips", "spine0": "LowerBack", "chest": "Spine1", "neck": "Neck", "head": "Head",
        "head_top": ("end_or_dir", "Head", 0.20),
        **_sided(lambda s, w, suf: {
            "clav_" + s: w + "Shoulder", "shoulder_" + s: w + "Arm", "elbow_" + s: w + "ForeArm",
            "wrist_" + s: w + "Hand",
            "middle_0_" + s: ("first", w + "FingerBase", ("end_or_dir", w + "Hand", 0.09)),
            "hip_" + s: w + "UpLeg", "knee_" + s: w + "Leg", "ankle_" + s: w + "Foot",
            "ball_" + s: w + "ToeBase", "toe_" + s: ("end_or_dir", w + "ToeBase", 0.06)}),
    },
}

SOURCES = {"bandai": BANDAI, "lafan1": LAFAN1, "cmu": CMU}

# canonical joint -> the joint whose rotation drives the retarget secondary vector, and that vector
SECONDARY = {
    "head": ("head", (0.0, -1.0, 0.0)),        # forward
    "wrist_L": ("wrist_L", (0.0, 0.0, -1.0)),  # palm normal (palms down in the reference T-pose)
    "wrist_R": ("wrist_R", (0.0, 0.0, -1.0)),
    "ankle_L": ("ankle_L", (0.0, 0.0, 1.0)),   # foot up
    "ankle_R": ("ankle_R", (0.0, 0.0, 1.0)),
}


def detect(bvh_joint_names):
    """Best-matching source id for a BVH by joint-name coverage."""
    names = set(n for n in bvh_joint_names if n)
    best, score = None, 0
    for sid, src in SOURCES.items():
        hits = 0
        for spec in src["joints"].values():
            base = spec if isinstance(spec, str) else (spec[1] if spec[0] != "first" else spec[1])
            if isinstance(base, str) and base in names:
                hits += 1
        if hits > score:
            best, score = sid, hits
    return best if score >= 12 else None
