# SPDX-License-Identifier: GPL-3.0-or-later
"""Job `convert_clip`: convert BVH clips into a pose pack (contracts sections 9, 16).

args: {"source": "bandai"|"lafan1"|"cmu"|null (auto), "files": [abs paths], "pack_dir": abs path,
       "pack": {"pack", "title", "license", "license_url", "exportable", "tags_for"}}
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from mpm import protocol  # noqa: E402
from mpm.convert import clipio, convert  # noqa: E402


def main(job):
    a = job["args"]
    files = a.get("files") or ([a["file"]] if a.get("file") else [])
    if not files or not a.get("pack_dir") or not isinstance(a.get("pack"), dict):
        raise protocol.MpmError("E_ARGS", "convert_clip needs files, pack_dir and pack")
    done, failed = [], []
    for k, f in enumerate(files):
        protocol.progress("convert", k / max(len(files), 1), os.path.basename(f))
        try:
            conv = convert.convert_bvh(f, a.get("source"))
            done.append(clipio.add_to_pack(a["pack_dir"], a["pack"], conv))
        except Exception as e:  # noqa: BLE001 - one bad file must not stop a pack
            failed.append({"file": os.path.basename(f), "error": str(e)})
    if not done:
        raise protocol.MpmError("E_IMPORT_FAILED", "no clip could be converted", {"failed": failed})
    return {"clips": done, "failed": failed}


if __name__ == "__main__":
    protocol.run(main)
