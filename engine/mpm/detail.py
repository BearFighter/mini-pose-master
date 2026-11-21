# SPDX-License-Identifier: GPL-3.0-or-later
"""Recover sculpted surface detail from a baked normal map (port of prototype/detail.py).

Game models keep their fine detail (panel lines, trims, ridges) in a tangent-space normal map baked
from a high-poly sculpt. This turns that map back into a height field (slopes -> heights, solved with
an FFT Poisson integration), keeps only the small-scale relief, and displaces a subdivided copy of the
mesh with it. Runs inside Blender (needs bpy for image loading).
"""

import numpy as np


# --------------------------------------------------------------------------
# images
# --------------------------------------------------------------------------

def load_image_rgb(path):
    """Pixels as float32 (rows = +V, i.e. bottom row first), channels RGB."""
    import bpy
    img = bpy.data.images.load(path, check_existing=False)
    img.colorspace_settings.name = 'Non-Color'
    w, h = img.size
    px = np.empty(w * h * img.channels, np.float32)
    img.pixels.foreach_get(px)
    bpy.data.images.remove(img)
    return px.reshape(h, w, -1)[..., :3]


def image_rgb(img):
    """Pixels of an already loaded (possibly packed) image as float32 (h, w, 3), rows = +V.

    The image's colour space is forced to Non-Color so the values are the raw normal-map data.
    """
    img.colorspace_settings.name = 'Non-Color'
    w, h = img.size
    ch = img.channels
    px = np.empty(w * h * ch, np.float32)
    img.pixels.foreach_get(px)
    px = px.reshape(h, w, ch)
    if ch < 3:
        px = np.repeat(px[..., :1], 3, axis=2)
    return px[..., :3].copy()


def _image_ok(img):
    """False for an image whose file was not found (a kit that references a texture it does not ship)."""
    try:
        return img is not None and img.size[0] > 0 and img.size[1] > 0
    except Exception:  # noqa: BLE001
        return False


def find_normal_maps(obj, missing=None):
    """Tangent-space normal maps of an object's materials.

    One entry per NORMAL_MAP node whose Color input is linked from an image texture node:
    {"material": name, "slot": index, "image": bpy Image, "space": node.space}.
    Images whose file is missing are left out; pass a list as `missing` to collect their file names.
    """
    out = []
    for slot_index, slot in enumerate(obj.material_slots):
        mat = slot.material
        if mat is None or mat.node_tree is None:
            continue
        for node in mat.node_tree.nodes:
            if node.bl_idname != 'ShaderNodeNormalMap' or node.space != 'TANGENT':
                continue
            col = node.inputs.get("Color")
            if col is None:
                continue
            for link in col.links:
                src = link.from_node
                if src.bl_idname == 'ShaderNodeTexImage' and src.image is not None:
                    if not _image_ok(src.image):
                        if missing is not None:
                            name = (src.image.filepath or src.image.name).replace("\\", "/").split("/")[-1]
                            if name not in missing:
                                missing.append(name)
                        continue
                    out.append({"material": mat.name, "slot": slot_index, "image": src.image,
                                "space": node.space})
    return out


# --------------------------------------------------------------------------
# UV coverage mask
# --------------------------------------------------------------------------

def uv_triangles(me):
    """(T, 3, 2) UVs of the mesh's triangles, wrapped into the 0..1 tile."""
    me.calc_loop_triangles()
    lt = np.empty(len(me.loop_triangles) * 3, np.int32)
    me.loop_triangles.foreach_get("loops", lt)
    uv = np.empty(len(me.loops) * 2, np.float32)
    me.uv_layers.active.data.foreach_get("uv", uv)
    uv = uv.reshape(-1, 2)[lt].reshape(-1, 3, 2)
    # Mirrored halves are often offset by whole tiles; bring every triangle
    # back into tile 0 (by its own centroid so it isn't split).
    uv = uv - np.floor(uv.mean(axis=1, keepdims=True))
    return uv


def raster_mask(tris_uv, w, h):
    """Boolean texel mask of all UV triangles."""
    mask = np.zeros((h, w), bool)
    P = tris_uv * np.array([w, h], np.float32) - 0.5
    for t in P:
        x0, y0 = np.floor(t.min(0)).astype(int)
        x1, y1 = np.ceil(t.max(0)).astype(int)
        x0, y0 = max(x0, 0), max(y0, 0)
        x1, y1 = min(x1, w - 1), min(y1, h - 1)
        if x1 < x0 or y1 < y0:
            continue
        xs, ys = np.meshgrid(np.arange(x0, x1 + 1), np.arange(y0, y1 + 1))
        (ax, ay), (bx, by), (cx, cy) = t
        d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
        if abs(d) < 1e-12:
            continue
        l1 = ((by - cy) * (xs - cx) + (cx - bx) * (ys - cy)) / d
        l2 = ((cy - ay) * (xs - cx) + (ax - cx) * (ys - cy)) / d
        l3 = 1 - l1 - l2
        e = -0.75 / max(abs(d), 1.0) ** 0.5  # include texels touching edges
        inside = (l1 >= e) & (l2 >= e) & (l3 >= e)
        mask[y0:y1 + 1, x0:x1 + 1] |= inside
    return mask


# --------------------------------------------------------------------------
# normal map -> height
# --------------------------------------------------------------------------

def _gradients(nrm, green_up):
    n = nrm * 2.0 - 1.0
    nz = np.clip(n[..., 2], 0.25, 1.0)
    gx = -n[..., 0] / nz                    # dh/du (columns)
    gy = (-1.0 if green_up else 1.0) * n[..., 1] / nz   # dh/dv (rows, +V)
    return gx, gy


def _curl_energy(gx, gy, mask):
    c = (np.diff(gx, axis=0)[:, :-1] - np.diff(gy, axis=1)[:-1, :])
    m = mask[:-1, :-1] & mask[1:, :-1] & mask[:-1, 1:]
    return float(np.mean(c[m] ** 2))


def _integrate(gx, gy):
    """Least-squares height from gradients (Frankot-Chellappa, periodic)."""
    h, w = gx.shape
    wu = 2 * np.pi * np.fft.fftfreq(w)[None, :]
    wv = 2 * np.pi * np.fft.fftfreq(h)[:, None]
    # finite-difference-consistent frequencies
    su, sv = 2 * np.sin(wu / 2), 2 * np.sin(wv / 2)
    GX, GY = np.fft.fft2(gx), np.fft.fft2(gy)
    den = su ** 2 + sv ** 2
    den[0, 0] = 1.0
    H = (np.conj(1j * su) * GX + np.conj(1j * sv) * GY) / den
    H[0, 0] = 0.0
    return np.real(np.fft.ifft2(H))


def _blur(a, sigma):
    h, w = a.shape
    fu = np.fft.fftfreq(w)[None, :]
    fv = np.fft.fftfreq(h)[:, None]
    g = np.exp(-2 * (np.pi * sigma) ** 2 * (fu ** 2 + fv ** 2))
    return np.real(np.fft.ifft2(np.fft.fft2(a) * g))


def height_from_normal(nrm, mask, sigma_px=24.0, fade_px=0.0):
    """Small-scale relief (in texel units) from a tangent-space normal map.

    Returns (height, info). Height is zero-mean inside the UV islands and is
    smoothly extended a little past their edges so sampling at seams is safe.
    With `fade_px` > 0 the relief eases to zero over about 2 * fade_px texels at every island edge:
    each island is integrated on its own, so the two sides of a UV seam carry unrelated offsets and
    would otherwise meet in a step (a groove or ridge along every seam).
    """
    info = {}
    e_up = _curl_energy(*_gradients(nrm, True), mask)
    e_dn = _curl_energy(*_gradients(nrm, False), mask)
    green_up = e_up <= e_dn
    info["green"] = "OpenGL (+Y up)" if green_up else "DirectX (+Y down)"
    info["curl_ratio"] = round(max(e_up, e_dn) / max(min(e_up, e_dn), 1e-12), 2)
    gx, gy = _gradients(nrm, green_up)
    gx = np.where(mask, gx, 0.0)
    gy = np.where(mask, gy, 0.0)
    hgt = _integrate(gx, gy)
    # keep only detail: subtract a masked (normalized) Gaussian low-pass
    m = mask.astype(np.float64)
    low = _blur(hgt * m, sigma_px) / np.maximum(_blur(m, sigma_px), 1e-6)
    detail = (hgt - low) * m
    if fade_px > 0:
        # the blurred mask is 0.5 on a straight island edge and ~1 two sigmas inside
        detail *= np.clip(2.0 * _blur(m, fade_px) - 1.0, 0.0, 1.0)
    # extend past island edges so bilinear lookups at seams don't hit zeros
    num, den = detail.copy(), m.copy()
    for s in (2.0, 4.0, 8.0):
        num_b, den_b = _blur(detail, s), _blur(m, s)
        fill = (den == 0) & (den_b > 1e-3)
        num[fill] = num_b[fill] / den_b[fill]
        den[fill] = 1.0
    info["p01"], info["p99"] = (float(np.percentile(detail[mask], q)) for q in (1, 99))
    return num.astype(np.float32), info


def texel_size(me, tex_w, tex_h, matrix=None):
    """Average world length per texel (object units), from 3D vs UV area."""
    me.calc_loop_triangles()
    n = len(me.loop_triangles)
    vi = np.empty(n * 3, np.int32)
    me.loop_triangles.foreach_get("vertices", vi)
    co = np.empty(len(me.vertices) * 3, np.float32)
    me.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3).astype(np.float64)
    if matrix is not None:
        M = np.array(matrix, np.float64)
        co = co @ M[:3, :3].T + M[:3, 3]
    v = co[vi].reshape(-1, 3, 3)
    a3 = 0.5 * np.linalg.norm(np.cross(v[:, 1] - v[:, 0], v[:, 2] - v[:, 0]), axis=1)
    uv = uv_triangles(me) * np.array([tex_w, tex_h])
    a2 = 0.5 * np.abs(np.cross(uv[:, 1] - uv[:, 0], uv[:, 2] - uv[:, 0]))
    return float(np.sqrt(a3.sum() / max(a2.sum(), 1e-12)))


# --------------------------------------------------------------------------
# sampling and displacement
# --------------------------------------------------------------------------

def sample_bilinear(hmap, uv):
    """Sample a height map (rows = +V) at UVs (N, 2), wrapping into tile 0."""
    h, w = hmap.shape
    u = (uv[:, 0] - np.floor(uv[:, 0])) * w - 0.5
    v = (uv[:, 1] - np.floor(uv[:, 1])) * h - 0.5
    x0 = np.clip(np.floor(u).astype(int), 0, w - 1)
    y0 = np.clip(np.floor(v).astype(int), 0, h - 1)
    x1, y1 = np.clip(x0 + 1, 0, w - 1), np.clip(y0 + 1, 0, h - 1)
    fx, fy = np.clip(u - x0, 0, 1), np.clip(v - y0, 0, 1)
    return ((hmap[y0, x0] * (1 - fx) + hmap[y0, x1] * fx) * (1 - fy)
            + (hmap[y1, x0] * (1 - fx) + hmap[y1, x1] * fx) * fy)


def displace_mesh(me, hmap, amount, cap=None):
    """Move each vertex along its normal by height * amount (object units).

    Vertices on UV seams get the average of their loops' samples. With `cap` (object units) the move
    is soft-limited to cap * tanh(d / cap): small relief is unchanged, tall spikes flatten out at cap.
    Returns the per-vertex move in object units.
    """
    nv, nl = len(me.vertices), len(me.loops)
    uv = np.empty(nl * 2, np.float32)
    me.uv_layers.active.data.foreach_get("uv", uv)
    lv = np.empty(nl, np.int32)
    me.loops.foreach_get("vertex_index", lv)
    s = sample_bilinear(hmap, uv.reshape(-1, 2))
    acc = np.bincount(lv, weights=s, minlength=nv)
    cnt = np.bincount(lv, minlength=nv)
    d = acc / np.maximum(cnt, 1) * amount
    if cap is not None and cap > 0:
        d = cap * np.tanh(d / cap)
    co = np.empty(nv * 3, np.float32)
    me.vertices.foreach_get("co", co)
    nrm = np.empty(nv * 3, np.float32)
    me.vertices.foreach_get("normal", nrm)
    co = co.reshape(-1, 3) + nrm.reshape(-1, 3) * d[:, None]
    me.vertices.foreach_set("co", co.astype(np.float32).ravel())
    me.update()
    return d
