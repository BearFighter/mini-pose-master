# SPDX-License-Identifier: GPL-3.0-or-later
"""BVH reader + forward kinematics (port of the prototype mocap_poses.Clip, generalised).

Pure Python + numpy. Position channels on a joint replace its OFFSET (Bandai stores them on every
joint, standard BVH only on the root). Rotation channels compose in channel order.
"""

import os

import numpy as np


class Bvh:
    def __init__(self, path):
        self.path = path
        self.name = os.path.splitext(os.path.basename(path))[0]
        self.joints, self.parents, self.offsets, self.channels = [], [], [], []
        with open(path, encoding="utf-8", errors="replace") as fh:
            text = fh.read()
        if "MOTION" not in text:
            raise ValueError("not a BVH file (no MOTION section)")
        head, motion = text.split("MOTION", 1)
        stack, pending = [], None
        for line in head.splitlines():
            t = line.split()
            if not t:
                continue
            if t[0] in ("ROOT", "JOINT"):
                self.joints.append(t[1])
                self.parents.append(stack[-1] if stack else -1)
                self.offsets.append([0.0, 0.0, 0.0])
                self.channels.append([])
                pending = len(self.joints) - 1
            elif t[0] == "End":
                self.joints.append(None)          # end site
                self.parents.append(stack[-1])
                self.offsets.append([0.0, 0.0, 0.0])
                self.channels.append([])
                pending = len(self.joints) - 1
            elif t[0] == "{":
                stack.append(pending)
            elif t[0] == "}":
                stack.pop()
            elif t[0] == "OFFSET":
                self.offsets[pending] = [float(x) for x in t[1:4]]
            elif t[0] == "CHANNELS":
                self.channels[pending] = t[2:2 + int(t[1])]
        lines = [l for l in motion.strip().splitlines() if l.strip()]
        self.n_frames = int(lines[0].split()[1])
        self.frame_time = float(lines[1].split()[2])
        rows = [l.split() for l in lines[2:2 + self.n_frames]]
        self.data = np.array(rows, dtype=np.float64) if rows else np.zeros((0, 0))
        self.n_frames = len(self.data)
        self.index = {n: i for i, n in enumerate(self.joints) if n}
        # end site of joint j (first end-site child), if any
        self.end_of = {}
        for i, (n, p) in enumerate(zip(self.joints, self.parents)):
            if n is None and p >= 0 and self.joints[p] not in self.end_of:
                self.end_of[self.joints[p]] = i
        cols, c = [], 0
        for ch in self.channels:
            cols.append(list(range(c, c + len(ch))))
            c += len(ch)
        self._cols = cols

    def world(self, frames=None, rest=False):
        """World matrices (F, J, 4, 4) in BVH space. rest=True zeroes every rotation channel
        (position channels still apply, so the rest pose keeps its proportions)."""
        frames = np.arange(self.n_frames) if frames is None else np.atleast_1d(frames)
        F, J = len(frames), len(self.joints)
        W = np.zeros((F, J, 4, 4))
        vals = self.data[frames] if self.n_frames else np.zeros((F, 0))
        for j in range(J):
            L = np.tile(np.eye(4), (F, 1, 1))
            L[:, :3, 3] = self.offsets[j]
            R = np.tile(np.eye(3), (F, 1, 1))
            for name, col in zip(self.channels[j], self._cols[j]):
                v = vals[:, col]
                if name.endswith("position"):
                    if self.parents[j] < 0 and rest:
                        continue  # rest pose at the origin
                    L[:, "XYZ".index(name[0]), 3] = v
                elif not rest:
                    a = np.radians(v)
                    ca, sa = np.cos(a), np.sin(a)
                    M = np.tile(np.eye(3), (F, 1, 1))
                    i, k = {"X": (1, 2), "Y": (2, 0), "Z": (0, 1)}[name[0]]
                    M[:, i, i], M[:, i, k], M[:, k, i], M[:, k, k] = ca, -sa, sa, ca
                    R = R @ M
            L[:, :3, :3] = R
            p = self.parents[j]
            W[:, j] = L if p < 0 else W[:, p] @ L
        return W
