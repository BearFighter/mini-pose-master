# SPDX-License-Identifier: GPL-3.0-or-later
"""Surface sampling and 2D connected-piece clustering (ported from prototype/rig.py)."""
import numpy as np


def surface_samples(objs, n, seed=0):
    """`n` area-weighted random points on the world-space surface of the mesh objects `objs`."""
    rng = np.random.default_rng(seed)
    tris = []
    for o in objs:
        me = o.data
        me.calc_loop_triangles()
        if len(me.loop_triangles) == 0:
            continue
        vi = np.empty(len(me.loop_triangles) * 3, np.int32)
        me.loop_triangles.foreach_get("vertices", vi)
        co = np.empty(len(me.vertices) * 3, np.float32)
        me.vertices.foreach_get("co", co)
        co = co.reshape(-1, 3).astype(np.float64)
        M = np.array(o.matrix_world)
        co = co @ M[:3, :3].T + M[:3, 3]
        tris.append(co[vi].reshape(-1, 3, 3))
    if not tris:
        raise ValueError("no triangles to sample")
    t = np.concatenate(tris)
    a = 0.5 * np.linalg.norm(np.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0]), axis=1)
    if a.sum() <= 0:
        raise ValueError("meshes have zero area")
    k = rng.choice(len(t), n, p=a / a.sum())
    r1, r2 = rng.random(n), rng.random(n)
    s = np.sqrt(r1)
    return (t[k, 0] * (1 - s)[:, None] + t[k, 1] * (s * (1 - r2))[:, None]
            + t[k, 2] * (s * r2)[:, None])


def clusters2d(points_xy, gap):
    """Split points already projected to 2D into separate connected pieces.

    Points are binned into square cells of size 0.7*gap; occupied cells touching (8-neighbourhood) are one
    piece. Returns a list of index arrays into `points_xy` (pieces with fewer than 4 points are dropped),
    each sorted by the first coordinate.
    """
    pts = np.asarray(points_xy, dtype=np.float64)
    if len(pts) == 0:
        return []
    cell = gap * 0.7
    ij = np.floor(pts[:, :2] / cell).astype(np.int64)
    uniq, inv = np.unique(ij, axis=0, return_inverse=True)
    inv = inv.ravel()
    where = {(int(a), int(b)): k for k, (a, b) in enumerate(uniq)}
    label = -np.ones(len(uniq), int)
    n = 0
    for k in range(len(uniq)):
        if label[k] >= 0:
            continue
        label[k] = n
        stack = [k]
        while stack:
            i, j = uniq[stack.pop()]
            for di in (-1, 0, 1):
                for dj in (-1, 0, 1):
                    m = where.get((int(i) + di, int(j) + dj))
                    if m is not None and label[m] < 0:
                        label[m] = n
                        stack.append(m)
        n += 1
    pl = label[inv]
    out = []
    for c in range(n):
        idx = np.nonzero(pl == c)[0]
        if len(idx) >= 4:
            out.append(idx[np.argsort(pts[idx, 0], kind="stable")])
    return out
