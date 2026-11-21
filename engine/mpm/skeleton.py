# SPDX-License-Identifier: GPL-3.0-or-later
"""Canonical skeleton (resources/skeleton.json) and the derived-joint rules of contracts section 4.

Expansion matches src/shared/skeleton.ts exactly: entries with {s}/{S} are emitted as their L copy then
their R copy, in place, keeping list order.
"""

import json
import os

import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))


def _resources_dir():
    # <repo>/engine/mpm -> <repo>/resources ; packaged: <resources>/engine/mpm -> <resources>/resources
    for cand in (os.path.join(_HERE, "..", "..", "resources"), os.path.join(_HERE, "..", "..", "..", "resources")):
        p = os.path.abspath(os.path.join(cand, "skeleton.json"))
        if os.path.exists(p):
            return os.path.dirname(p)
    raise FileNotFoundError("resources/skeleton.json not found")


def _load():
    with open(os.path.join(_resources_dir(), "skeleton.json"), encoding="utf-8") as fh:
        return json.load(fh)


def _expand(entries, sides):
    out = []
    for e in entries:
        text = json.dumps(e)
        if "{s}" in text or "{S}" in text:
            for side in sides:
                out.append(json.loads(text.replace("{s}", side["s"]).replace("{S}", side["S"])))
        else:
            out.append(e)
    return out


_DATA = _load()
JOINTS = _expand(_DATA["joints"], _DATA["sides"])
BONES = _expand(_DATA["bones"], _DATA["sides"])
_INDEX = {b["name"]: i for i, b in enumerate(BONES)}
EDITABLE = [j["name"] for j in JOINTS if j["editable"]]
FINGERS = ("thumb", "index", "middle", "ring", "pinky")


def bone_index(name):
    return _INDEX.get(name, -1)


def mirror_name(name):
    for a, b in ((".L", ".R"), (".R", ".L"), ("_L", "_R"), ("_R", "_L")):
        if name.endswith(a):
            return name[: -len(a)] + b
    return name


def is_finger_bone(name):
    return name.split(".")[0] in FINGERS


def side_of(name):
    if name.endswith((".L", "_L")):
        return "L"
    if name.endswith((".R", "_R")):
        return "R"
    return None


# --------------------------------------------------------------------------------------------------
# contracts section 4
# --------------------------------------------------------------------------------------------------

def _v(p):
    if isinstance(p, dict):
        p = p["p"]
    return np.asarray(p, np.float64).reshape(3)


def _unit(v):
    n = float(np.linalg.norm(v))
    return v / n if n > 1e-12 else v


def _lerp(a, b, t):
    return a + t * (b - a)


def hand_frame(J, s):
    """Hand frame for side s from joints J (contracts section 4)."""
    wrist, m0 = J["wrist_" + s], J["middle_0_" + s]
    i0, p0 = J["index_0_" + s], J["pinky_0_" + s]
    ha = _unit(m0 - wrist)
    lat = _unit(i0 - p0)
    pn = _unit(np.cross(ha, lat)) if s == "L" else _unit(np.cross(lat, ha))
    ga = _unit(lat - ha * float(np.dot(lat, ha)))
    return {"hand_axis": ha, "lateral": lat, "palm_normal": pn,
            "hand_width": float(np.linalg.norm(i0 - p0)), "grip_axis": ga}


def derive_joints(markers):
    """All 68 canonical joints from editable markers (values: [x,y,z] or {"p": [...]}).

    Derived joints follow contracts section 4 exactly. Raises KeyError if an editable joint needed by
    a rule is missing.
    """
    J = {k: _v(v) for k, v in markers.items()}
    pel, chest, neck = J["pelvis"], J["chest"], J["neck"]
    J["spine0"] = _lerp(pel, chest, 0.30)
    for s, sign in (("L", 1.0), ("R", -1.0)):
        sh = J["shoulder_" + s]
        J["clav_" + s] = np.array([pel[0] + sign * 0.18 * abs(sh[0] - pel[0]), neck[1],
                                   neck[2] - 0.25 * (neck[2] - sh[2])])
        ank, toe = J["ankle_" + s], J["toe_" + s]
        b = _lerp(ank, toe, 0.68)
        b[2] = 0.35 * ank[2] + 0.65 * toe[2]
        J["ball_" + s] = b
        # The two middle joints of a finger lie on the straight line from knuckle to tip unless the
        # markers give them (optional knuckle points, for curved fingers and claws).
        for f in ("index", "middle", "ring", "pinky"):
            a, t = J["%s_0_%s" % (f, s)], J["%s_tip_%s" % (f, s)]
            J.setdefault("%s_1_%s" % (f, s), _lerp(a, t, 0.45))
            J.setdefault("%s_2_%s" % (f, s), _lerp(a, t, 0.75))
        a, t = J["thumb_0_" + s], J["thumb_tip_" + s]
        J.setdefault("thumb_1_" + s, _lerp(a, t, 0.40))
        J.setdefault("thumb_2_" + s, _lerp(a, t, 0.73))
        fr = hand_frame(J, s)
        centre = np.mean([J["index_0_" + s], J["middle_0_" + s], J["ring_0_" + s], J["pinky_0_" + s],
                          J["wrist_" + s]], axis=0)
        J["grip_" + s] = centre + fr["palm_normal"] * 0.35 * fr["hand_width"]
        J["grip_tip_" + s] = J["grip_" + s] + fr["grip_axis"] * 0.10
    missing = [j["name"] for j in JOINTS if j["name"] not in J]
    if missing:
        raise KeyError("joints missing after derivation: %s" % missing)
    return J


def hand_frames(J):
    return {s: hand_frame(J, s) for s in ("L", "R")}
