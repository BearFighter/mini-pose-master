# SPDX-License-Identifier: GPL-3.0-or-later
"""Pure synthetic test data that involves no figure: a known height field and the tangent-space normal map
made from it (both green conventions), a flat UV-mapped grid carrying that map, plain boxes and a unit-cube
STL. Model behaviour is never tested on these; see kits.py for the real kits."""
import struct

import numpy as np

TEX_N = 1024
NORMAL_K = 2.0


def smoothstep(t):
    t = np.clip(t, 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def height_field(n=TEX_N, seed=1234):
    """A deterministic relief: engraved grid lines every 64 texels (-1) and 40 round bumps (+1).
    float32 (n, n); row 0 is v = 0 (the bottom of the image, as Blender stores pixels)."""
    rng = np.random.default_rng(seed)
    idx = np.arange(n)
    g = (idx % 64) < 3
    H = np.zeros((n, n), dtype=np.float64)
    H[g[:, None] | g[None, :]] = -1.0
    yy, xx = np.mgrid[0:n, 0:n]
    cx = rng.integers(16, n - 16, size=40)
    cy = rng.integers(16, n - 16, size=40)
    S = np.zeros((n, n), dtype=np.float64)
    for x0, y0 in zip(cx, cy):
        d = np.hypot(xx - x0, yy - y0)
        S = np.maximum(S, np.where(d < 10.0, smoothstep((10.0 - d) / 3.0), 0.0))
    return (H + S).astype(np.float32)


def normals_from_height(H, k=NORMAL_K, green="opengl"):
    """Unit tangent-space normals (n, n, 3) of the height field H (rows = +v).
    green: "opengl" (+Y up) or "directx" (green flipped)."""
    assert green in ("opengl", "directx"), green
    H = np.asarray(H, dtype=np.float64)
    du = np.gradient(H, axis=1)
    dv = np.gradient(H, axis=0)
    n = np.stack([-k * du, -k * dv, np.ones_like(H)], axis=-1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    if green == "directx":
        n[..., 1] *= -1.0
    return n


def normal_image(name, normals):
    """An 8-bit Non-Color Blender image holding the encoded normals (n * 0.5 + 0.5)."""
    import bpy
    h, w = normals.shape[:2]
    img = bpy.data.images.new(name, w, h, alpha=False, is_data=True)
    img.colorspace_settings.name = "Non-Color"
    px = np.ones((h, w, 4), np.float32)
    px[..., :3] = np.clip(np.rint((normals * 0.5 + 0.5) * 255.0), 0, 255) / 255.0
    img.pixels.foreach_set(px.ravel())
    img.pack()   # a packed PNG, like a kit's embedded texture: the pixels survive a reload of the image
    return img


def flat_grid(name, image=None, segments=16, size=1.0):
    """A flat grid in the XY plane whose UVs cover the whole 0..1 tile; with `image`, a material whose
    Normal Map node (tangent space) reads it."""
    import bmesh
    import bpy
    bm = bmesh.new()
    bm.loops.layers.uv.new("UVMap")
    bmesh.ops.create_grid(bm, x_segments=segments, y_segments=segments, size=size / 2.0, calc_uvs=True)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    if image is not None:
        mat = bpy.data.materials.new(name + "_mat")
        mat.use_nodes = True
        nt = mat.node_tree
        nt.nodes.clear()
        out = nt.nodes.new("ShaderNodeOutputMaterial")
        bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
        tex = nt.nodes.new("ShaderNodeTexImage")
        nm = nt.nodes.new("ShaderNodeNormalMap")
        tex.image = image
        nt.links.new(tex.outputs["Color"], nm.inputs["Color"])
        nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])
        nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
        me.materials.append(mat)
    return ob


def box(name, centre=(0.0, 0.0, 0.0), size=(1.0, 1.0, 1.0), cuts=0):
    """An axis-aligned box object; `cuts` subdivides every edge (more vertices on the faces)."""
    import bmesh
    import bpy
    from mathutils import Matrix
    if not hasattr(size, "__len__"):
        size = (size,) * 3
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0, matrix=Matrix.Translation(centre) @ Matrix.Diagonal((*size, 1.0)))
    if cuts:
        bmesh.ops.subdivide_edges(bm, edges=bm.edges[:], cuts=cuts, use_grid_fill=True)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    bpy.context.view_layer.update()
    return ob


def write_cube_stl(path, drop_face=False):
    """A binary STL of the unit cube 0..1 (12 outward triangles); drop_face leaves the bottom open."""
    v = np.array([[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], float)
    quads = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    tris = []
    for q in quads:
        tris += [(q[0], q[1], q[2]), (q[0], q[2], q[3])]
    if drop_face:
        tris = tris[2:]
    with open(path, "wb") as f:
        f.write(b"\0" * 80)
        f.write(struct.pack("<I", len(tris)))
        for t in tris:
            a, b, c = v[t[0]], v[t[1]], v[t[2]]
            n = np.cross(b - a, c - a)
            n = n / np.linalg.norm(n)
            f.write(struct.pack("<12fH", *n, *a, *b, *c, 0))
