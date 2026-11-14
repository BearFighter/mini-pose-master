# SPDX-License-Identifier: GPL-3.0-or-later
"""convert_weapon job (contracts sections 12, 16): weapon file -> weapons/<name>.glb in Blender metres."""
import json
import os
import shutil
import sys
import tempfile

import numpy as np

import bpy

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(REPO, "engine", "jobs"))
from mpm import bake as BK  # noqa: E402
from test_markers import fx  # noqa: E402
from test_rig_build import _run_job  # noqa: E402
import convert_weapon as CW  # noqa: E402


def _verts(objs):
    return np.vstack([np.array([v.co[:] for v in o.data.vertices]) for o in objs])


def test_unit_suggestion_and_out_path():
    assert CW.suggest_unit_scale(1.1) == 1.0 and CW.suggest_unit_scale(110.0) == 0.01
    assert CW.suggest_unit_scale(1100.0) == 0.001
    pd = os.path.abspath("proj")
    assert CW.out_path(pd, "weapons/rifle/rifle.fbx") == "weapons/rifle.glb"
    assert CW.out_path(pd, "weapons/axe.obj") == "weapons/axe.glb"
    assert CW.out_path(pd, "weapons/axe.glb") == "weapons/axe.mpm.glb"


def test_convert_weapon_round_trip():
    """FBX -> converted GLB -> glTF import (what the bake does) keeps the geometry in place."""
    tmp = tempfile.mkdtemp(prefix="mpm_weapon_")
    try:
        for name in ("sword", "rifle"):
            d = os.path.join(tmp, "weapons", name)
            os.makedirs(d)
            shutil.copy(fx(name), os.path.join(d, name + ".fbx"))
            code, res, errs, p = _run_job(tmp, "convert_weapon", {"file": "weapons/%s/%s.fbx" % (name, name)})
            assert code == 0 and len(res) == 1 and not errs, p.stdout[-2000:] + p.stderr[-1500:]
            r = json.loads(res[0][len("@@result"):])
            print("  %s: %s, dims %s m, axis %s" % (name, r["weapon_glb"], [round(x, 3) for x in r["dims_m"]],
                                                 [round(x, 2) for x in r["principal_axis"]]))
            assert r["weapon_glb"] == "weapons/%s.glb" % name and r["unit_scale_used"] == 1.0
            bpy.ops.wm.read_factory_settings(use_empty=True)
            bpy.ops.import_scene.fbx(filepath=fx(name))
            src = [o for o in bpy.data.objects if o.type == 'MESH']
            for o in src:
                o.data.transform(o.matrix_world)
            ref = _verts(src)
            got = _verts(BK.import_weapon(os.path.join(tmp, r["weapon_glb"])))
            # glTF splits vertices at UV / normal seams: compare the sets of positions
            u_ref = np.unique(np.round(ref, 5), axis=0)
            u_got = np.unique(np.round(got, 5), axis=0)
            assert len(u_ref) == len(u_got), (len(u_ref), len(u_got))
            assert np.abs(u_ref - u_got).max() < 2e-5
            lo, hi = got.min(0), got.max(0)
            assert np.abs(lo - ref.min(0)).max() < 1e-5 and np.abs(hi - ref.max(0)).max() < 1e-5, (lo, hi)
            assert np.allclose(hi - lo, r["dims_m"], atol=1e-5)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_convert_weapon_cm_file():
    """A weapon authored in centimetres is scaled to metres, with a warning."""
    tmp = tempfile.mkdtemp(prefix="mpm_weapon_cm_")
    try:
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.ops.mesh.primitive_cube_add(size=1.0)
        o = bpy.context.active_object
        o.scale = (5.0, 5.0, 90.0)   # a 90 cm "sword" exported without unit conversion
        os.makedirs(os.path.join(tmp, "weapons"))
        src = os.path.join(tmp, "weapons", "big.obj")
        bpy.ops.wm.obj_export(filepath=src, export_materials=False)
        code, res, errs, p = _run_job(tmp, "convert_weapon", {"file": "weapons/big.obj"})
        assert code == 0 and len(res) == 1, p.stdout[-2000:] + p.stderr[-1500:]
        r = json.loads(res[0][len("@@result"):])
        assert r["unit_scale_used"] == 0.01 and r["warnings"], r
        assert abs(max(r["dims_m"]) - 0.9) < 1e-4, r["dims_m"]
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
