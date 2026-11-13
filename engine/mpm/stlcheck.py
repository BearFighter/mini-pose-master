# SPDX-License-Identifier: GPL-3.0-or-later
"""numpy-only binary STL checker (no bpy).

Usage: python engine/mpm/stlcheck.py <file.stl>   (prints the check() result as JSON)
"""
import json
import sys

import numpy as np


def read_stl(path):
    """Read a binary STL. Returns (tris, normals): float64 arrays of shape (n, 3, 3) and (n, 3)."""
    with open(path, "rb") as f:
        data = f.read()
    if len(data) < 84:
        raise ValueError("STL too short")
    n = int(np.frombuffer(data, dtype="<u4", count=1, offset=80)[0])
    if len(data) < 84 + 50 * n:
        raise ValueError("STL truncated: header says %d triangles" % n)
    rec = np.dtype([("n", "<f4", (3,)), ("v", "<f4", (3, 3)), ("attr", "<u2")])
    arr = np.frombuffer(data, dtype=rec, count=n, offset=84)
    return arr["v"].astype(np.float64), arr["n"].astype(np.float64)


def check(path):
    tris, _file_normals = read_stl(path)
    n = int(tris.shape[0])
    if n == 0:
        return {"tris": 0, "dims": [0.0, 0.0, 0.0], "floor_z": 0.0, "open_edges": 0,
                "nonmanifold_edges": 0, "volume": 0.0, "sole_contact": {"L": 0.0, "R": 0.0}}

    # Merge vertices by exact coordinate.
    flat = tris.reshape(-1, 3)
    uniq, inv = np.unique(flat, axis=0, return_inverse=True)
    faces = inv.reshape(-1, 3)

    # Edge use counts.
    e = np.concatenate([faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]], axis=0)
    e = np.sort(e, axis=1)
    _edges, counts = np.unique(e, axis=0, return_counts=True)
    open_edges = int(np.count_nonzero(counts == 1))
    nonmanifold_edges = int(np.count_nonzero(counts > 2))

    # Signed volume (divergence theorem).
    v0, v1, v2 = tris[:, 0], tris[:, 1], tris[:, 2]
    volume = float(np.sum(np.einsum("ij,ij->i", v0, np.cross(v1, v2))) / 6.0)

    # Bounding box and floor.
    mn = flat.min(axis=0)
    mx = flat.max(axis=0)
    dims = (mx - mn).tolist()
    floor_z = float(mn[2])

    # Sole contact area (file units squared).
    cr = np.cross(v1 - v0, v2 - v0)
    area2 = np.linalg.norm(cr, axis=1)
    area = 0.5 * area2
    with np.errstate(invalid="ignore", divide="ignore"):
        nz = np.where(area2 > 0, cr[:, 2] / area2, 0.0)
    maxz = tris[:, :, 2].max(axis=1)
    cx = tris[:, :, 0].mean(axis=1)
    sole = (maxz < floor_z + 0.1) & (nz < -0.95)
    contact = {"L": float(area[sole & (cx >= 0)].sum()), "R": float(area[sole & (cx < 0)].sum())}

    return {"tris": n, "dims": dims, "floor_z": floor_z, "open_edges": open_edges,
            "nonmanifold_edges": nonmanifold_edges, "volume": volume, "sole_contact": contact}


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: stlcheck.py <file.stl>", file=sys.stderr)
        sys.exit(2)
    print(json.dumps(check(sys.argv[1]), indent=2))
