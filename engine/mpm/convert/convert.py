# SPDX-License-Identifier: GPL-3.0-or-later
"""BVH clip -> canonical clip arrays (contracts section 9). Pure Python + numpy."""

import os
import re

import numpy as np

from .bvh import Bvh
from .sources import SECONDARY, SOURCES, detect

CB = np.array([[1.0, 0, 0], [0, 0, -1.0], [0, 1.0, 0]])  # BVH (Y up, faces +Z) -> Blender (Z up, faces -Y)
REST_HEIGHT = 1.75
CONTACT_M = 0.035


def _base(B, spec):
    """Source joint whose rotation a spec follows."""
    if isinstance(spec, str):
        return spec if spec in B.index else None
    if spec[0] == "first":
        for s in spec[1:]:
            b = _base(B, s)
            if b:
                return b
        return None
    return spec[1] if spec[1] in B.index else None


def _positions(B, W, spec, unit):
    if isinstance(spec, str):
        return W[:, B.index[spec], :3, 3]
    if spec[0] == "first":
        for s in spec[1:]:
            if _base(B, s):
                return _positions(B, W, s, unit)
        raise KeyError(spec)
    _kind, name, length = spec
    j = B.index[name]
    e = B.end_of.get(name)
    if e is not None and np.linalg.norm(B.offsets[e]) > 1e-6:
        return W[:, e, :3, 3]
    off = np.asarray(B.offsets[j], float)
    n = np.linalg.norm(off)
    u = off / n if n > 1e-9 else np.array([0.0, 1.0, 0.0])
    return W[:, j, :3, 3] + np.einsum("fij,j->fi", W[:, j, :3, :3], u) * (length / unit)


def _rot_between(a, B):
    """Quaternions [w,x,y,z] (F,4) taking unit vector a onto each row of B (F,3)."""
    a = a / np.linalg.norm(a)
    B = B / np.maximum(np.linalg.norm(B, axis=1, keepdims=True), 1e-12)
    w = 1.0 + B @ a
    xyz = np.cross(np.broadcast_to(a, B.shape), B)
    q = np.concatenate([w[:, None], xyz], axis=1)
    bad = w < 1e-8  # opposite: 180 deg about any axis perpendicular to a
    if bad.any():
        perp = np.cross(a, [1.0, 0, 0] if abs(a[0]) < 0.9 else [0, 1.0, 0])
        perp /= np.linalg.norm(perp)
        q[bad] = [0.0, perp[0], perp[1], perp[2]]
    q /= np.linalg.norm(q, axis=1, keepdims=True)
    q[q[:, 0] < 0] *= -1
    return q


def meta_from_name(name):
    m = re.match(r"^dataset-\d+_(.+)_([a-z-]+)_(\d+)$", name)
    if m:
        return {"move": m.group(1), "style": m.group(2), "take": int(m.group(3))}
    return {"move": name, "style": "", "take": 0}


def key_frames(P, fps, k):
    """The k most expressive, well-separated frames (largest change from the opening stance)."""
    rest = P[: min(10, len(P))].mean(axis=0)
    score = np.linalg.norm(P - rest, axis=-1).sum(axis=1)
    gap = max(3, int(round(0.6 * fps)))
    picked = []
    for f in np.argsort(-score):
        if all(abs(int(f) - g) >= gap for g in picked):
            picked.append(int(f))
        if len(picked) == k:
            break
    return sorted(picked)


def convert_bvh(path, source=None, fps_out=15):
    """Returns {"source", "names", "frames" (N,J,7) float32, "contacts" (N,) uint32, "fps", "key_frames", "meta"}."""
    B = Bvh(path)
    sid = source or detect(B.joints)
    if sid not in SOURCES:
        raise ValueError("unknown or undetectable mocap source for %s" % os.path.basename(path))
    src = SOURCES[sid]
    F = B.n_frames
    if F == 0:
        raise ValueError("clip has no frames")
    W = B.world()
    unit = src["unit"]
    if unit is None:
        Wr = B.world([0], rest=True)[0]
        ys = Wr[:, 1, 3]
        unit = REST_HEIGHT / max(float(ys.max() - ys.min()), 1e-9)
    names = [n for n, spec in src["joints"].items() if _base(B, spec)]
    for need in ("pelvis", "hip_L", "hip_R"):
        if need not in names:
            raise ValueError("clip lacks joint %s for source %s" % (need, sid))
    P = np.stack([_positions(B, W, src["joints"][n], unit) for n in names], axis=1)
    P = (P @ CB.T) * unit
    # per-frame normalisation: pelvis xy to 0, hip line to +X (figure faces -Y)
    ip, iL, iR = names.index("pelvis"), names.index("hip_L"), names.index("hip_R")
    P[..., :2] -= P[:, ip:ip + 1, :2]
    side = P[:, iL] - P[:, iR]
    yaw = np.arctan2(side[:, 1], side[:, 0])
    c, s = np.cos(-yaw), np.sin(-yaw)
    Rz = np.zeros((F, 3, 3))
    Rz[:, 0, 0], Rz[:, 0, 1], Rz[:, 1, 0], Rz[:, 1, 1], Rz[:, 2, 2] = c, -s, s, c, 1.0
    P = np.einsum("fij,fkj->fki", Rz, P)
    feet = [names.index(k) for k in ("ankle_L", "ankle_R", "ball_L", "ball_R", "toe_L", "toe_R") if k in names]
    floor = float(np.percentile(P[:, feet, 2].min(axis=1), 2))
    P[..., 2] -= floor
    # rotations for the secondary joints, in the normalised Blender frame
    Rn = {}
    for n in SECONDARY:
        if n in names:
            j = B.index[_base(B, src["joints"][n])]
            Rn[n] = np.einsum("fij,fjk->fik", Rz, CB @ W[:, j, :3, :3] @ CB.T)
    axes = {}
    if src["calibration"] == "neutral_first_frames":
        k = min(10, F)
        for n, R in Rn.items():
            acc = np.zeros(3)
            for i in range(k):
                if n == "head":
                    t = np.array([0.0, -1.0, 0.0])
                elif n.startswith("wrist_"):
                    sd = n[-1]
                    f = P[i, names.index("wrist_" + sd)] - P[i, names.index("elbow_" + sd)]
                    f /= max(np.linalg.norm(f), 1e-9)
                    inward = np.array([-1.0 if sd == "L" else 1.0, 0.0, 0.0])
                    t = inward - f * float(inward @ f)
                    t /= max(np.linalg.norm(t), 1e-9)
                else:
                    t = np.array([0.0, 0.0, 1.0])
                acc += R[i].T @ t
            axes[n] = acc / max(np.linalg.norm(acc), 1e-9)
    else:  # rest_tpose
        Wr = B.world([0], rest=True)[0]
        for n in Rn:
            j = B.index[_base(B, src["joints"][n])]
            Rr = CB @ Wr[j, :3, :3] @ CB.T
            axes[n] = Rr.T @ np.array(SECONDARY[n][1])
    Q = np.zeros((F, len(names), 4))
    Q[..., 0] = 1.0
    for n, a in axes.items():
        vec = np.einsum("fij,j->fi", Rn[n], a)
        Q[:, names.index(n)] = _rot_between(np.array(SECONDARY[n][1]), vec)
    bits = np.zeros(F, np.uint32)
    for bit, sd in ((1, "L"), (2, "R")):
        idx = [names.index(k) for k in ("ball_" + sd, "toe_" + sd) if k in names]
        if idx:
            bits |= np.where(P[:, idx, 2].min(axis=1) < CONTACT_M, bit, 0).astype(np.uint32)
    # resample by picking frames (never interpolating: that would shorten bones)
    n_out = int(np.floor((F - 1) * B.frame_time * fps_out + 1e-9)) + 1
    pick = np.clip(np.round(np.arange(n_out) / fps_out / B.frame_time).astype(int), 0, F - 1)
    frames = np.concatenate([P, Q], axis=2)[pick].astype(np.float32)
    k = max(1, min(10, n_out // 45 + 1))
    return {"source": sid, "names": names, "frames": frames, "contacts": bits[pick], "fps": fps_out,
            "key_frames": key_frames(P[pick], fps_out, k), "meta": meta_from_name(B.name),
            "id": B.name}
