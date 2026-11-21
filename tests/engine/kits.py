# SPDX-License-Identifier: GPL-3.0-or-later
"""Real-model test harness. Model behaviour (joint finding, rigging, skinning, baking) is tested on real,
purchased character kits, never on a figure made for the app.

The kits are NOT in this repository and never will be. A local, git-ignored config names them:

  tests/local/kits.json   (or the file named by env MPM_KITS)
  { "kits": { "excalibur": { "model": "D:/kits/Excalibur/ExcaliburMesh.fbx" },
              "golem":     { "model": "D:/kits/golem.fbx", "hard": true } },
    "weapons": { "sword": "D:/kits/sword.glb" } }

Without the config every kit test is skipped (as on CI). Projects are built once per kit with the real jobs
(import -> suggest_markers -> rig) and cached in tests/local/cache, keyed by the model file and the engine
source, so an engine change rebuilds them.

Reviewed results live in tests/local/expected/<kit>.markers.json: marker positions a person has looked at
and accepted (tests/engine/accept_kit.py writes them). Tests compare against them when they exist.
"""
import atexit
import glob
import hashlib
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
LOCAL = os.path.join(REPO, "tests", "local")
CACHE = os.path.join(LOCAL, "cache")
EXPECTED = os.path.join(LOCAL, "expected")
IMAGE_EXT = (".png", ".jpg", ".jpeg", ".tga", ".bmp", ".tif", ".tiff", ".dds", ".exr", ".webp")
STAGES = ("import", "markers", "rig")

_config = None
_tmp = []


def blender():
    import bpy
    return bpy.app.binary_path


def config():
    """The local kit config, or None when there is none."""
    global _config
    if _config is None:
        path = os.environ.get("MPM_KITS") or os.path.join(LOCAL, "kits.json")
        _config = {}
        if os.path.isfile(path):
            with open(path, encoding="utf-8") as fh:
                _config = json.load(fh)
    return _config or None


FLAG_DEFAULTS = {"humanoid": True, "dense": False, "hard": False}


def names(**flags):
    """Names of the configured kits whose model file exists, optionally filtered by their flags
    (`hard`: unusual anatomy such as claws and spikes, where the automatic results need more correcting;
    `cloth`: draped cloth in the body mesh, which stretches in extreme poses)."""
    cfg = config()
    out = []
    for n, k in sorted(((cfg or {}).get("kits") or {}).items()):
        if not os.path.isfile(k.get("model", "")):
            continue
        if any(v is not None and bool(k.get(f, FLAG_DEFAULTS.get(f, False))) != v for f, v in flags.items()):
            continue
        out.append(n)
    return out


def need(*kit_names, **flags):
    """The given kits (or all matching the flags); raises SkipTest when none are configured."""
    have = names(**flags)
    want = [n for n in kit_names if n in have] if kit_names else have
    if not want:
        raise unittest.SkipTest("no real kits configured (tests/local/kits.json); see tests/engine/kits.py")
    return want


def kit(name):
    return config()["kits"][name]


def weapon(name="sword"):
    """A configured weapon file, else the repo's procedural one (fixtures/out), else SkipTest."""
    p = ((config() or {}).get("weapons") or {}).get(name)
    if p and os.path.isfile(p):
        return p
    for ext in (".glb", ".fbx"):
        p = os.path.join(REPO, "fixtures", "out", name, name + ext)
        if os.path.isfile(p):
            return p
    raise unittest.SkipTest("no %s weapon file available" % name)


# ---------------------------------------------------------------------------------------------------
# jobs

def run_job(project, jtype, args, timeout=3600):
    """Run engine/jobs/<jtype>.py as the app does. Returns (exit code, result or None, error or None, proc)."""
    jp = os.path.join(project, "cache", "%s.job.json" % jtype)
    os.makedirs(os.path.dirname(jp), exist_ok=True)
    with open(jp, "w", encoding="utf-8") as fh:
        json.dump({"schema": "mpm.job/1", "id": jtype, "type": jtype, "project_dir": project, "args": args}, fh)
    p = subprocess.run([blender(), "-b", "--factory-startup", "--python-exit-code", "1", "-P",
                        os.path.join(REPO, "engine", "jobs", jtype + ".py"), "--", jp],
                       capture_output=True, text=True, timeout=timeout, encoding="utf-8", errors="replace")
    res = [l for l in p.stdout.splitlines() if l.startswith("@@result")]
    err = [l for l in p.stdout.splitlines() if l.startswith("@@error")]
    return (p.returncode, json.loads(res[0][len("@@result"):]) if len(res) == 1 else None,
            json.loads(err[0][len("@@error"):]) if err else None, p)


def ok(code, res, err, p):
    assert code == 0 and res is not None and err is None, (err, p.stdout[-3000:], p.stderr[-2000:])
    return res


# ---------------------------------------------------------------------------------------------------
# cached projects

def _engine_hash():
    h = hashlib.sha1()
    for f in sorted(glob.glob(os.path.join(REPO, "engine", "**", "*.py"), recursive=True)):
        with open(f, "rb") as fh:
            h.update(os.path.relpath(f, REPO).encode() + b"\0" + fh.read().replace(b"\r\n", b"\n"))
    return h.hexdigest()


def _key(name):
    m = kit(name)["model"]
    st = os.stat(m)
    return hashlib.sha1(("%s|%d|%d|%s|%s" % (os.path.abspath(m), st.st_size, int(st.st_mtime), _engine_hash(),
                                             json.dumps(kit(name).get("objects"), sort_keys=True))).encode()
                        ).hexdigest()[:12]


def copy_source(model, project):
    """What the app's importModel copies: the model, images beside it and in textures/. Returns the
    project-relative model path."""
    src = os.path.join(project, "source")
    os.makedirs(src, exist_ok=True)
    d = os.path.dirname(model)
    shutil.copy(model, os.path.join(src, os.path.basename(model)))
    for f in os.listdir(d):
        if f.lower().endswith(IMAGE_EXT):
            shutil.copy(os.path.join(d, f), os.path.join(src, f))
    tex = os.path.join(d, "textures")
    if os.path.isdir(tex):
        shutil.copytree(tex, os.path.join(src, "textures"), dirs_exist_ok=True)
    return "source/" + os.path.basename(model)


class Project:
    def __init__(self, name, path):
        self.name, self.dir = name, path

    def result(self, stage):
        with open(os.path.join(self.dir, "cache", "kit.%s.json" % stage), encoding="utf-8") as fh:
            return json.load(fh)

    @property
    def markers(self):
        """{name: [x, y, z]} as suggested by the engine."""
        return {k: v["p"] for k, v in self.result("markers")["markers"].items()}

    @property
    def rig(self):
        with open(os.path.join(self.dir, "rig", "rig.json"), encoding="utf-8") as fh:
            return json.load(fh)


def project(name, stage="rig"):
    """The cached project of a kit, built up to `stage` with the real jobs."""
    path = os.path.join(CACHE, "%s-%s" % (name, _key(name)))
    for old in glob.glob(os.path.join(CACHE, name + "-*")):
        if os.path.abspath(old) != os.path.abspath(path):
            shutil.rmtree(old, ignore_errors=True)
    pr = Project(name, path)
    done = lambda s: os.path.isfile(os.path.join(path, "cache", "kit.%s.json" % s))  # noqa: E731

    def save(s, res):
        with open(os.path.join(path, "cache", "kit.%s.json" % s), "w", encoding="utf-8") as fh:
            json.dump(res, fh)

    if all(done(s) for s in STAGES[:STAGES.index(stage) + 1]):
        return pr
    os.makedirs(CACHE, exist_ok=True)
    lock = path + ".lock"   # several test processes may want the same kit: one builds, the others wait
    waited = 0
    while True:
        try:
            os.close(os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY))
            break
        except FileExistsError:
            if waited > 1800 or (time.time() - os.path.getmtime(lock)) > 1800:
                os.remove(lock)
            time.sleep(2)
            waited += 2
    try:
        _build(name, pr, path, stage, done, save)
    finally:
        try:
            os.remove(lock)
        except OSError:
            pass
    return pr


def _build(name, pr, path, stage, done, save):
    for s in STAGES[:STAGES.index(stage) + 1]:
        if done(s):
            continue
        print("  [kits] %s: running %s" % (name, s), flush=True)
        if s == "import":
            if os.path.isdir(path):
                shutil.rmtree(path)
            os.makedirs(path)
            rel = copy_source(kit(name)["model"], path)
            # "objects": the per-part choice a user would make in the app's Parts list for this kit
            args = {"file": rel}
            if kit(name).get("objects"):
                args["objects"] = kit(name)["objects"]
            save(s, ok(*run_job(path, "import", args)))
        elif s == "markers":
            save(s, ok(*run_job(path, "suggest_markers", {})))
        elif s == "rig":
            save(s, ok(*run_job(path, "rig", {"markers": pr.markers})))


def scratch_copy(name, stage="rig"):
    """A private copy of the cached project (for tests that write into it); removed at exit."""
    src = project(name, stage).dir
    dst = tempfile.mkdtemp(prefix="mpm_kit_%s_" % name)
    shutil.copytree(src, dst, dirs_exist_ok=True)
    _tmp.append(dst)
    return Project(name, dst)


@atexit.register
def _cleanup():
    for d in _tmp:
        shutil.rmtree(d, ignore_errors=True)


# ---------------------------------------------------------------------------------------------------
# in-process access

def open_scene(name):
    """Open the kit's normalised rig/scene.blend here. Returns the meshes the rig is built on."""
    import bpy
    sys.path.insert(0, os.path.join(REPO, "engine", "jobs"))
    bpy.ops.wm.open_mainfile(filepath=os.path.join(project(name, "import").dir, "rig", "scene.blend"))
    return [o for o in bpy.data.objects if o.type == 'MESH']


def open_rig(name):
    """Open the kit's rig/rig.blend here. Returns (armature, rigged meshes, rig.json)."""
    import bpy
    pr = project(name, "rig")
    bpy.ops.wm.open_mainfile(filepath=os.path.join(pr.dir, "rig", "rig.blend"))
    rig = pr.rig
    arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
    want = {m["name"] for m in rig["meshes"]}
    return arm, [o for o in bpy.data.objects if o.type == 'MESH' and o.name in want], rig


def local_x_deltas(rig, spec):
    """{bone index: [w, x, y, z]} turning each named canonical bone about its own rest X axis by degrees."""
    from mathutils import Matrix, Quaternion
    out = {}
    for b in rig["bones"]:
        if b.get("canonical") in spec:
            R = Quaternion(b["rest_q"]).to_matrix()
            q = (R @ Matrix.Rotation(math.radians(spec[b["canonical"]]), 3, 'X') @ R.transposed()).to_quaternion()
            if q.w < 0:
                q.negate()
            out[str(b["index"])] = [q.w, q.x, q.y, q.z]
    return out


# ---------------------------------------------------------------------------------------------------
# reviewed results

def expected_markers(name):
    """Marker positions a person reviewed and accepted for this kit, or None."""
    p = os.path.join(EXPECTED, name + ".markers.json")
    if not os.path.isfile(p):
        return None
    with open(p, encoding="utf-8") as fh:
        return json.load(fh)["markers"]


def accept_markers(name, markers, note=""):
    os.makedirs(EXPECTED, exist_ok=True)
    with open(os.path.join(EXPECTED, name + ".markers.json"), "w", encoding="utf-8") as fh:
        json.dump({"kit": name, "note": note, "markers": markers}, fh, indent=1)


# ---------------------------------------------------------------------------------------------------
# a dense version of a real kit (no kit is over the 300k-triangle proxy limit as shipped)

_DENSE_SCRIPT = '''
import sys, math, bpy, bmesh
scene, out, target = sys.argv[-3], sys.argv[-2], int(sys.argv[-1])
bpy.ops.wm.open_mainfile(filepath=scene)
meshes = [o for o in bpy.data.objects if o.type == 'MESH' and "mpm_proxy_of" not in o]
tris = sum(len(p.vertices) - 2 for o in meshes for p in o.data.polygons)
cuts = max(1, math.ceil(math.sqrt(target / max(tris, 1))) - 1)
for o in meshes:
    bm = bmesh.new()
    bm.from_mesh(o.data)
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    bmesh.ops.subdivide_edges(bm, edges=bm.edges[:], cuts=cuts, use_grid_fill=True)
    bm.to_mesh(o.data)
    bm.free()
for o in bpy.data.objects:
    o.hide_set(False)
    o.hide_viewport = False
    o.select_set(o in meshes)
bpy.ops.export_scene.fbx(filepath=out, use_selection=True, path_mode='COPY', embed_textures=True,
                         apply_scale_options='FBX_SCALE_ALL', object_types={'MESH'})
print("DENSE_TRIS", sum(len(p.vertices) - 2 for o in meshes for p in o.data.polygons))
'''


def dense_model(name, target=330_000):
    """A copy of the kit subdivided (flat, no smoothing) past the proxy limit, as an FBX in the cache.
    Real geometry and textures, just more triangles. Returns the FBX path."""
    src = project(name, "import").dir
    d = os.path.join(CACHE, "_dense", "%s-%s" % (name, _key(name)))
    out = os.path.join(d, name + "_dense.fbx")
    if os.path.isfile(out):
        return out
    os.makedirs(d, exist_ok=True)
    script = os.path.join(d, "make_dense.py")
    with open(script, "w", encoding="utf-8") as fh:
        fh.write(_DENSE_SCRIPT)
    p = subprocess.run([blender(), "-b", "--factory-startup", "--python-exit-code", "1", "-P", script, "--",
                        os.path.join(src, "rig", "scene.blend"), out, str(target)],
                       capture_output=True, text=True, timeout=1800, encoding="utf-8", errors="replace")
    assert p.returncode == 0 and os.path.isfile(out), p.stdout[-2000:] + p.stderr[-2000:]
    return out


def project_from_model(model, upto="rig", label="model"):
    """A scratch project built from any model file with the real jobs (import, markers, rig)."""
    path = tempfile.mkdtemp(prefix="mpm_%s_" % label)
    _tmp.append(path)
    rel = copy_source(model, path)
    out = {"import": ok(*run_job(path, "import", {"file": rel}))}
    pr = Project(label, path)
    if upto in ("markers", "rig"):
        out["markers"] = ok(*run_job(path, "suggest_markers", {}))
    if upto == "rig":
        out["rig"] = ok(*run_job(path, "rig", {"markers": {k: v["p"] for k, v in out["markers"]["markers"].items()}}))
    pr.results = out
    return pr
