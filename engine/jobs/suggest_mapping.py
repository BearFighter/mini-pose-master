# SPDX-License-Identifier: GPL-3.0-or-later
"""Job `suggest_mapping`: suggest the bone mapping of an imported (pre-rigged) character (contracts s16)."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import bpy  # noqa: E402

from mpm import protocol  # noqa: E402
from mpm.rig import imported  # noqa: E402


def main(job):
    scene = os.path.join(os.path.abspath(job["project_dir"]), "rig", "scene.blend")
    if not os.path.exists(scene):
        raise protocol.MpmError("E_ARGS", "rig/scene.blend is missing; run the import job first")
    bpy.ops.wm.open_mainfile(filepath=scene)
    return imported.suggest_mapping(imported.find_armature())


if __name__ == "__main__":
    protocol.run(main)
