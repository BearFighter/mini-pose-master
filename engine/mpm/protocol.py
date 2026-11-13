# SPDX-License-Identifier: GPL-3.0-or-later
"""Job protocol (docs/contracts.md section 16): stdout tags, job.json loading, error codes."""
import json
import sys
import traceback

ERROR_CODES = frozenset("""E_BLENDER_VERSION E_ARGS E_IMPORT_FAILED E_NO_MESH E_ORIENTATION E_MARKERS_INCOMPLETE
E_WEIGHTS_EMPTY E_FOLLOW_CHECK E_BUDGET E_REMESH E_EXPORT E_IO E_CANCELLED E_INTERNAL""".split())

_terminal_sent = False


class MpmError(Exception):
    def __init__(self, code, message, detail=None):
        assert code in ERROR_CODES, "unknown error code %r" % (code,)
        super().__init__(message)
        self.code = code
        self.message = message
        self.detail = detail


def _emit(tag, obj):
    line = "@@%s %s" % (tag, json.dumps(obj, ensure_ascii=True, separators=(",", ":")))
    print(line, flush=True)


def progress(stage, fraction, message=""):
    _emit("progress", {"stage": stage, "fraction": float(fraction), "message": message})


def result(payload):
    global _terminal_sent
    if _terminal_sent:
        raise RuntimeError("result/error already emitted for this job")
    _terminal_sent = True
    _emit("result", payload)


def error(code, message, detail=None):
    global _terminal_sent
    if _terminal_sent:
        raise RuntimeError("result/error already emitted for this job")
    assert code in ERROR_CODES, "unknown error code %r" % (code,)
    _terminal_sent = True
    _emit("error", {"code": code, "message": message, "detail": detail if detail is not None else {}})


def load_job():
    argv = sys.argv
    if "--" not in argv or len(argv) <= argv.index("--") + 1:
        raise MpmError("E_ARGS", "no job.json path after --")
    path = argv[argv.index("--") + 1]
    try:
        with open(path, "r", encoding="utf-8") as f:
            job = json.load(f)
    except (OSError, ValueError) as e:
        raise MpmError("E_ARGS", "cannot read job file: %s" % e, {"path": path})
    if not isinstance(job, dict) or job.get("schema") != "mpm.job/1":
        raise MpmError("E_ARGS", "job schema must be 'mpm.job/1'")
    for k in ("id", "type", "project_dir", "args"):
        if k not in job:
            raise MpmError("E_ARGS", "job is missing %r" % k)
    return job


def run(main):
    try:
        import bpy
        if tuple(bpy.app.version[:2]) != (5, 2):
            raise MpmError("E_BLENDER_VERSION", "Blender 5.2 is required, found %s" % ".".join(map(str, bpy.app.version)),
                           {"version": list(bpy.app.version)})
        job = load_job()
        payload = main(job)
        result(payload)
    except MpmError as e:
        error(e.code, e.message, e.detail)
        sys.exit(1)
    except Exception as e:  # noqa: BLE001
        tb = traceback.format_exc()
        sys.stderr.write(tb)
        sys.stderr.flush()
        error("E_INTERNAL", str(e), {"traceback": tb})
        sys.exit(1)
    sys.exit(0)
