# SPDX-License-Identifier: GPL-3.0-or-later
"""Variants of a real kit for the import tests: the kit's own normalised geometry written out again in
another authoring convention (Y up, centimetres), and the .obj a kit ships beside its .fbx.

Nothing here invents geometry. Files are built once in a separate headless Blender (the caller's scene is
left alone) and cached in tests/local/cache/_variants, keyed like the kit's cached project (model file +
engine source) and by this folder's helper sources. See kits.py; rigged_kit.py builds the rigged variants.

How the re-exported files differ from the kit's own file (reexported()):
  yup       the vertices are turned -90 degrees about X in the mesh data, so the figure stands along +Y and
            faces +Z (the usual Y-up convention), and the FBX is written with Blender's own axes
            (axis_up='Z', axis_forward='-Y'): the file does NOT say it is Y up, as when a Y-up tool exports
            without converting. Blender's importer leaves it lying along Y; the engine has to notice.
  cm        the vertices are multiplied by 100 in the mesh data and the FBX is written at global_scale 1:
            a figure 184 units tall in a file that claims metres.
  declared  nothing is baked: the FBX exporter is asked for axis_up='Y', axis_forward='-Z',
            global_scale=100 (apply_scale_options='FBX_SCALE_NONE'). The file declares Y up, which Blender's
            importer undoes, but every object keeps a node scale of 100, so it still arrives 100x too big.
"""
import glob
import hashlib
import math
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import kits  # noqa: E402

VARIANTS = os.path.join(kits.CACHE, "_variants")
_SOURCES = ("kit_variants.py", "rigged_kit.py")


def _source_hash():
    h = hashlib.sha1()
    for f in _SOURCES:
        with open(os.path.join(HERE, f), "rb") as fh:
            h.update(fh.read().replace(b"\r\n", b"\n"))
    return h.hexdigest()[:8]


def cache_dir(name):
    """The folder holding the current variants of a kit; variants of older engine/helper sources are removed."""
    path = os.path.join(VARIANTS, "%s-%s-%s" % (name, kits._key(name), _source_hash()))
    for old in glob.glob(os.path.join(VARIANTS, name + "-*")):
        if os.path.abspath(old) != os.path.abspath(path):
            shutil.rmtree(old, ignore_errors=True)
    os.makedirs(path, exist_ok=True)
    return path


def build(script, out, *args):
    """Run `script` (a file of this folder) in its own headless Blender to write `out`; no-op when cached.
    The script gets `-- <temporary out path> <args...>`; the file is moved into place when it succeeded."""
    if os.path.isfile(out):
        return out
    tmp = os.path.join(os.path.dirname(out), "building-%d-%s" % (os.getpid(), os.path.basename(out)))
    p = subprocess.run([kits.blender(), "-b", "--factory-startup", "--python-exit-code", "1", "-P",
                        os.path.join(HERE, script), "--", tmp] + [str(a) for a in args],
                       capture_output=True, text=True, timeout=1800, encoding="utf-8", errors="replace")
    assert p.returncode == 0 and os.path.isfile(tmp), p.stdout[-3000:] + p.stderr[-2000:]
    os.replace(tmp, out)
    return out


def export_fbx(path, objs, up="Z", forward="-Y", scale=1.0, textures=True):
    """FBX of the given objects (meshes, armature). textures: embed the images (the kits' are packed)."""
    import bpy
    bpy.context.view_layer.update()
    for o in bpy.data.objects:
        o.hide_set(False)
        o.hide_viewport = False
        o.select_set(o in objs)
    bpy.context.view_layer.objects.active = objs[0]
    kw = dict(filepath=path, use_selection=True, axis_up=up, axis_forward=forward, global_scale=scale,
              apply_scale_options='FBX_SCALE_NONE', object_types={"MESH", "ARMATURE"}, add_leaf_bones=False,
              use_armature_deform_only=False, bake_anim=False)
    if textures:
        kw.update(path_mode="COPY", embed_textures=True)
    bpy.ops.export_scene.fbx(**kw)


def reexported(name, yup=False, cm=False, declared=False):
    """The kit's normalised geometry (rig/scene.blend of its cached import) as an FBX in another authoring
    convention; see the module text for what yup / cm / declared do. Returns the FBX path."""
    kits.project(name, "import")
    tag = "declared_yup_cm" if declared else "_".join(t for t, on in (("yup", yup), ("cm", cm)) if on) or "same"
    out = os.path.join(cache_dir(name), "%s_%s.fbx" % (name, tag))
    return build("kit_variants.py", out, name, int(yup), int(cm), int(declared))


def find_obj(name):
    """The .obj a kit ships beside its .fbx (same name, or the name plus a suffix), or None."""
    model = kits.kit(name)["model"]
    d = os.path.dirname(model)
    stem = os.path.splitext(os.path.basename(model))[0].lower()
    objs = sorted((f for f in os.listdir(d) if f.lower().endswith(".obj")), key=len)
    for f in objs:
        if os.path.splitext(f)[0].lower() == stem:
            return os.path.join(d, f)
    for f in objs:
        if f.lower().startswith(stem) and not any(
                os.path.isfile(os.path.join(d, os.path.splitext(f)[0] + e)) for e in (".fbx", ".FBX")):
            return os.path.join(d, f)
    return None


def _main(argv):
    """Runs inside the build Blender: write the re-exported FBX."""
    from mathutils import Matrix
    out, name, yup, cm, declared = argv[0], argv[1], int(argv[2]), int(argv[3]), int(argv[4])
    meshes = [o for o in kits.open_scene(name) if "mpm_proxy_of" not in o]
    for o in meshes:
        o.data.materials.clear()   # geometry only: no texture travels with these files
    M = Matrix.Identity(4)
    if yup:
        M = Matrix.Rotation(math.radians(-90.0), 4, 'X') @ M   # (x, y, z) -> (x, z, -y)
    if cm:
        M = Matrix.Scale(100.0, 4) @ M
    if not declared:
        for o in meshes:
            o.data.transform(M)
            o.data.update()
        export_fbx(out, meshes, textures=False)
    else:
        export_fbx(out, meshes, up="Y", forward="-Z", scale=100.0, textures=False)


if __name__ == "__main__":
    _main(sys.argv[sys.argv.index("--") + 1:])
