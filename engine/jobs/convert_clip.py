# SPDX-License-Identifier: GPL-3.0-or-later
"""Job `convert_clip`: convert BVH clips into a pose pack (contracts sections 9, 16).

args: {"source": "bandai"|"lafan1"|"cmu"|null (auto), "files": [abs paths], "pack_dir": abs path,
       "pack": {"pack", "title", "license", "license_url", "exportable", "tags_for"},
       "archives": [abs .zip paths] (optional; their .bvh members are extracted into "extract_dir"),
       "extract_dir": abs path, "include": [lower-case substrings] (optional member-name filter),
       "root": abs path (optional; folder installs: clip ids stay unique across sub-folders)}
"""
import os
import shutil
import sys
import zipfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from mpm import protocol  # noqa: E402
from mpm.convert import clipio, convert  # noqa: E402

MAX_MEMBER = 256 * 1024 * 1024      # one BVH
MAX_TOTAL = 8 * 1024 * 1024 * 1024  # everything extracted from one job (zip-bomb guard)


def extract_bvh(archives, dest, include=None):
    """.bvh members of zip archives -> files under dest (no path escapes, size-capped). Returns paths."""
    root = os.path.realpath(dest)
    os.makedirs(root, exist_ok=True)
    out, total = [], 0
    for z in archives:
        try:
            zf = zipfile.ZipFile(z)
        except (OSError, zipfile.BadZipFile) as e:
            raise protocol.MpmError("E_IMPORT_FAILED", "not a readable zip: %s" % os.path.basename(z), {"error": str(e)})
        with zf:
            for info in zf.infolist():
                name = info.filename.replace("\\", "/")
                if info.is_dir() or not name.lower().endswith(".bvh"):
                    continue
                if include and not any(s in name.lower() for s in include):
                    continue
                target = os.path.realpath(os.path.join(root, *[p for p in name.split("/") if p not in ("", ".", "..")]))
                if os.path.commonpath([root, target]) != root:
                    continue
                if info.file_size > MAX_MEMBER or total + info.file_size > MAX_TOTAL:
                    raise protocol.MpmError("E_BUDGET", "the archive is too large to extract", {"member": name})
                total += info.file_size
                os.makedirs(os.path.dirname(target), exist_ok=True)
                with zf.open(info) as src, open(target, "wb") as dst:
                    shutil.copyfileobj(src, dst)
                out.append(target)
    return sorted(out)


def _src(f, roots):
    """The file's path relative to the install root it came from (for unique clip ids), else its name."""
    for r in roots:
        r = os.path.realpath(r)
        p = os.path.realpath(f)
        if os.path.commonpath([r, p]) == r:
            return os.path.relpath(p, r).replace("\\", "/")
    return os.path.basename(f)


def main(job):
    a = job["args"]
    files = list(a.get("files") or ([a["file"]] if a.get("file") else []))
    if a.get("archives"):
        if not a.get("extract_dir"):
            raise protocol.MpmError("E_ARGS", "archives need extract_dir")
        protocol.progress("extract", 0.0, "extracting")
        files += extract_bvh(a["archives"], a["extract_dir"], [s.lower() for s in a.get("include") or []])
    if not files or not a.get("pack_dir") or not isinstance(a.get("pack"), dict):
        raise protocol.MpmError("E_ARGS", "convert_clip needs files, pack_dir and pack")
    roots = [r for r in [a.get("root"), a.get("extract_dir")] if r]
    done, failed = [], []
    for k, f in enumerate(files):
        protocol.progress("convert", k / max(len(files), 1), os.path.basename(f))
        try:
            conv = convert.convert_bvh(f, a.get("source"))
            done.append(clipio.add_to_pack(a["pack_dir"], a["pack"], conv, _src(f, roots)))
        except Exception as e:  # noqa: BLE001 - one bad file must not stop a pack
            failed.append({"file": os.path.basename(f), "error": str(e)})
    if not done:
        raise protocol.MpmError("E_IMPORT_FAILED", "no clip could be converted", {"failed": failed})
    return {"clips": done, "failed": failed}


if __name__ == "__main__":
    protocol.run(main)
