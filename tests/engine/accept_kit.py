# SPDX-License-Identifier: GPL-3.0-or-later
"""Record a kit's current markers as reviewed (tests/local/expected/<kit>.markers.json, never committed).
Run it only after LOOKING at the markers on the model (the app's Rig step, or tests/e2e/real.mjs
screenshots): test_markers then holds later engine changes to these positions.

  blender -b --factory-startup --python-exit-code 1 -P tests/engine/accept_kit.py -- <kit> [<kit> ...] [--note "text"]
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import kits  # noqa: E402

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
note = ""
if "--note" in argv:
    i = argv.index("--note")
    note = argv[i + 1]
    argv = argv[:i] + argv[i + 2:]
if not argv:
    sys.exit("name at least one kit: %s" % ", ".join(kits.names()))
for name in argv:
    m = kits.project(name, "markers").result("markers")["markers"]
    kits.accept_markers(name, m, note)
    print("accepted %d markers for %s" % (len(m), name))
