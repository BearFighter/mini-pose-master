# SPDX-License-Identifier: GPL-3.0-or-later
"""Engine test harness. Run inside Blender:

  blender -b --factory-startup --python-exit-code 1 -P tests/engine/run.py -- [filter]

Discovers tests/engine/test_*.py and runs every module-level function named test_*. A fresh empty scene
is created before each test. `filter` is a substring of the module name or of "module.function".
Tests may raise unittest.SkipTest to skip.
"""
import glob
import importlib
import importlib.util
import os
import sys
import time
import traceback
import unittest

import bpy

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
for p in (os.path.join(REPO, "engine"), os.path.join(REPO, "tests", "engine")):
    if p not in sys.path:
        sys.path.insert(0, p)


def fixtures_dir():
    return os.path.abspath(os.environ.get("MPM_FIXTURES") or os.path.join(REPO, "fixtures", "out"))


def ensure_fixtures(fx_dir):
    spec = importlib.util.spec_from_file_location("mpm_fixture_generator", os.path.join(REPO, "fixtures", "generate.py"))
    gen = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(gen)
    missing = [n for n in gen.DEFAULT_FIXTURES
               if not os.path.isfile(os.path.join(fx_dir, n, n + ".truth.json"))]
    if not os.path.isdir(fx_dir) or missing:
        print("generating fixtures into %s: %s" % (fx_dir, ", ".join(missing)), flush=True)
        gen.generate(fx_dir, missing or None)


def discover(flt):
    tests = []
    for path in sorted(glob.glob(os.path.join(REPO, "tests", "engine", "test_*.py"))):
        mod_name = os.path.splitext(os.path.basename(path))[0]
        mod = importlib.import_module(mod_name)
        for fn_name in sorted(n for n in dir(mod) if n.startswith("test_")):
            fn = getattr(mod, fn_name)
            if not callable(fn) or getattr(fn, "__module__", None) != mod_name:
                continue
            full = "%s.%s" % (mod_name, fn_name)
            if flt and flt not in full:
                continue
            tests.append((full, fn))
    return tests


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    flt = argv[0] if argv else ""
    fx = fixtures_dir()
    os.environ["MPM_FIXTURES"] = fx
    tests = discover(flt)
    if tests:
        ensure_fixtures(fx)
    npass = nfail = nskip = 0
    for name, fn in tests:
        bpy.ops.wm.read_factory_settings(use_empty=True)
        t0 = time.perf_counter()
        try:
            fn()
            print("PASS %s (%.1f s)" % (name, time.perf_counter() - t0), flush=True)
            npass += 1
        except unittest.SkipTest as e:
            print("SKIP %s: %s" % (name, e), flush=True)
            nskip += 1
        except BaseException:
            print("FAIL %s: %s" % (name, traceback.format_exc()), flush=True)
            nfail += 1
    print("SUMMARY: %d passed, %d failed, %d skipped, %d total" % (npass, nfail, nskip, len(tests)), flush=True)
    if nfail or not tests:
        if not tests:
            print("no tests matched filter %r" % flt)
        sys.exit(1)


main()
