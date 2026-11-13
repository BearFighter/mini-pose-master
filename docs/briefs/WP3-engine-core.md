# WP3 — Engine core: printable + detail port, job protocol, import/normalise/inspect (coder: Sonnet)

Read first: `docs/coding-rules.md`, `docs/contracts.md` (§2, §7, §14, §15, §16, §21).
Prototype code to port is in `prototype/` (git-ignored; the architect wrote it). Read `prototype/make_printable.py`,
`prototype/detail.py` and `prototype/enhance.py`. **Port; don't redesign.** Keep the algorithms and
constants unless this brief says otherwise.

Blender: `C:/Program Files/Blender Foundation/Blender 5.2/blender.exe`. Tests run through
`tests/engine/run.py` (made in WP2). Fixtures are in `fixtures/out/` (make them with
`fixtures/generate.py` if missing).

## Files to create

### `engine/mpm/protocol.py` (job protocol, contracts §16)
- `class MpmError(Exception)`: `__init__(self, code: str, message: str, detail: dict | None = None)`.
  `code` must be one of the §16 error codes; assert it.
- `progress(stage: str, fraction: float, message: str = "")`, `result(payload: dict)`,
  `error(code, message, detail=None)`.
  - Each writes **one line** to stdout: `@@progress <json>`, `@@result <json>`, `@@error <json>`.
  - The JSON comes from `json.dumps(..., ensure_ascii=True, separators=(",", ":"))`, then
    `flush=True`.
  - `result`/`error` may be called once per process; a second call raises `RuntimeError`.
- `load_job() -> dict`: reads the path after `--` in `sys.argv` and parses the JSON. It validates
  `schema == "mpm.job/1"` and the presence of `id`, `type`, `project_dir`, `args`; otherwise it raises
  `MpmError("E_ARGS", …)`.
- `run(main: Callable[[dict], dict])`:
  - Checks `bpy.app.version[:2] == (5, 2)`, else `E_BLENDER_VERSION`.
  - Loads the job and calls `main(job)`, then emits `result(return value)` and exits 0.
  - On `MpmError` it emits `error` and exits 1.
  - On any other exception it emits `error("E_INTERNAL", str(e), {"traceback": ...})` and exits 1.
  - Write tracebacks to stderr as well.

### `engine/mpm/printable.py` (port of `prototype/make_printable.py`)
- Keep: `Settings`, `make_printable`, `write_stl`, `summarize`, and all the private helpers they use
  (off-grid remesh shift, sole flattening via bisect, voids/debris removal, decimate, thin check,
  `_normalize` with `unit_mm`).
- Remove: the Blender UI panel/operator/props, `register`/`unregister`, the CLI (`cli`,
  `_collect_inputs`, `_safe_extract`, `_import`), and the `__main__` block.
- Change `log()` to call `protocol.progress(...)` when a stage starts. Add stages
  `gather`, `clean`, `thicken`, `remesh`, `cleanup`, `decimate`, `thin_check`, `write`, with
  fractions 0.05, 0.10, 0.15, 0.20, 0.70, 0.75, 0.85, 0.95.
- **Voxel budget** (contracts §14), before the remesh:
  - `est = total_surface_area / voxel²`.
  - If `est > 60_000_000`: raise the voxel size to `sqrt(area / 60e6)`. If that exceeds 2× the
    original, raise `MpmError("E_BUDGET", …)`; otherwise record `voxel_coarsened_to` in the report.
- `make_printable` keeps its current signature and return value `(ob, rep)`.

### `engine/mpm/detail.py` (port of `prototype/detail.py`)
- Keep all functions.
- Add `image_rgb(img: bpy.types.Image) -> np.ndarray`. It reads pixels from an already loaded
  (possibly packed) image with the colorspace forced to Non-Color, and returns `(h, w, 3)` float32 with
  rows = +V, the same layout as `load_image_rgb`.
- Add `find_normal_maps(obj) -> list[dict]`:
  - For each material slot, find `ShaderNodeNormalMap` nodes whose `Color` input links from a
    `ShaderNodeTexImage` with an image.
  - Return `{"material": name, "slot": index, "image": bpy Image, "space": node.space}`.
  - Ignore materials without a node tree, and normal maps whose `space` isn't `TANGENT`.

### `engine/mpm/importer.py`
- `import_model(path: str) -> list[bpy.types.Object]`:
  - Dispatch by extension:
    - `.fbx`: `bpy.ops.import_scene.fbx(filepath, use_anim=False, automatic_bone_orientation=False, ignore_leaf_bones=False, use_image_search=True)`
    - `.glb`/`.gltf`: `import_scene.gltf`
    - `.obj`: `wm.obj_import`
    - `.stl`: `wm.stl_import`
    - `.ply`: `wm.ply_import`
  - Return the new objects. An unknown extension raises `E_IMPORT_FAILED`; no mesh at all raises
    `E_NO_MESH`.
- `suggest_orientation(meshes) -> {"up": "Z", "forward": "-Y", "unit_scale": s, "reason": str}`:
  - `unit_scale` is the value from `{1, 0.01, 0.001, 0.0254, 100}` that brings the bbox height
    (world Z extent) closest to 1.8 m in log space.
  - `up` is always `"Z"` after Blender's importer conversion. If the Y extent is more than 1.6× the
    Z extent, suggest `"Y"` with the reason `"model appears to lie along Y"`.
  - `forward` comes from the toes:
    1. Take the vertices in the lowest 4 % of height (the feet) and the vertices between 4 % and 10 %
       (the ankles).
    2. `v = centroid(feet).xy − centroid(ankles).xy`.
    3. Snap to the nearest of ±X/±Y. The toes point forward, so `forward = snap(v)`.
    4. If `|v|` is under 1 % of the height, report `"-Y"` with the reason `"no clear toe direction"`.
- `normalise(meshes, armature|None, orientation)`:
  - Apply the orientation: a rotation that maps the given up to +Z and the given forward to −Y, and
    the uniform `unit_scale`.
  - Then **for every object**: clear its parent while keeping the transform (`matrix_world`), apply
    all transforms into the data (for the armature, use `bpy.ops.object.transform_apply` with a
    `temp_override`; the rest pose follows).
  - Re-parent meshes that had an Armature modifier to nothing; keep their Armature modifier pointing
    at the armature.
  - Assert every object's `matrix_world` is identity, within 1e-6.
  - Move everything so the bbox centre XY = (0, 0) and min Z = 0 (apply that translation into the
    data too).
  - Apply every modifier except `ARMATURE`, and remove shape keys, keeping the current mix (use
    `shape_key_remove(all=True, apply_mix=True)` via `temp_override`).
  - Keep only one armature: the one with the most bones. Delete the others and add a warning.
- `make_proxy(meshes, max_tris=300_000)`:
  - If the total triangle count exceeds `max_tris`, duplicate each mesh into `<name>__proxy` and
    decimate it (COLLAPSE, same ratio for all, `use_collapse_triangulate=True`), keeping UVs.
  - Proxies are hidden and get the custom property `mpm_proxy_of = <name>`.
  - Returns True if proxies were made.
- `inspect(meshes, armature) -> dict` with the §16 `import` result fields:
  - `objects`: `[{name, verts, tris, materials}]`
  - `materials`: names
  - `normal_maps`: `[{object, material, image, size: [w, h]}]`
  - `has_armature`
  - `armature_bones`: `[{name, parent, head, tail}]`
  - `tri_count`, `height_m`, `suggested_orientation`, `proxy`, `warnings`

### `engine/jobs/import.py` (job entry)
1. Uses `protocol.run`. Args: `file` (path relative to `project_dir`), optional `orientation`.
2. Reads the scene fresh (`read_factory_settings(use_empty=True)`) and imports.
3. If `orientation` is absent, uses `suggest_orientation`.
4. Normalises, makes the proxy, inspects.
5. Saves `<project_dir>/rig/scene.blend` (creating `rig/`) with `bpy.ops.wm.save_as_mainfile`
   (`compress=True`).
6. Returns the inspect dict plus `{"orientation_used": ...}`.

### Tests: `tests/engine/test_engine_core.py`

1. **Protocol end to end**:
   - Write a job.json for `import` of `fixtures/out/apose/apose.fbx` into a temp project dir (copy the
     fbx into `source/`).
   - Run Blender as a **subprocess** on `engine/jobs/import.py`.
   - Assert the stdout has ≥ 1 `@@progress` line, exactly one `@@result`, no `@@error`, exit code 0,
     and that `rig/scene.blend` exists.
   - A second run with a bad schema returns exactly one `@@error` with `E_ARGS` and exit code 1.
2. **Import/normalise** (in-process). Note from WP2:
   - The fixture meshes are about **1.81 m** tall, because the skin end caps extend past `head_top`
     and the toes; the truth joints are unchanged.
   - Blender's FBX exporter put `yup_cm`'s ×100 into the node scale, so a default import is about
     181 units tall.

   Define `H_ref` = the bbox height of `apose.fbx` imported with defaults, measured in the test, and
   compare every variant against `H_ref`, not 1.80.
   - `apose.fbx`: height = H_ref ± 0.005; suggested forward `-Y`, unit 1; identity matrices; min z ≈ 0.
   - `yup_cm.fbx`: after normalising with the suggested orientation (the suggested `unit_scale` must
     be 0.01), its height = H_ref ± 0.005 and its mesh bbox equals the bbox of `apose` normalised,
     within 5 mm.
   - `rigged_mixamo.fbx`: `has_armature`; the armature object matrix is identity after normalising;
     the bone count matches the truth mapping's key count; the mesh has an Armature modifier.
   - `apose.glb` and `apose.obj` give the same height within 5 mm.
   - `dense.fbx`, only if present: `proxy` is True and the proxy triangle count ≤ 300k.
   - `skirt.fbx`: more than 1 object reported.
3. **Normal-map discovery**: `apose.fbx` → exactly 1 entry, with an image size of 1024×1024.
4. **Detail** (the ported `height_from_normal`):
   - On `apose`, using the discovered image and the mesh's UV mask, the recovered height correlates
     with `apose_height.npy` (masked to UV islands, both mean-removed) at **r > 0.9**.
   - The detected green convention is DirectX.
5. **Printable**:
   - `make_printable([apose mesh], Settings(height=40, flatten=0.5), out)` writes an STL.
   - `engine/mpm/stlcheck.check` reports 0 open edges, 0 non-manifold edges, and a height of
     40 ± 0.05 mm.
   - The report contains no error.
   - A voxel budget test: monkeypatch the budget constant small so coarsening triggers, then confirm
     `E_BUDGET` raises when it would need more than 2×.

## Acceptance
`blender … -P tests/engine/run.py -- engine_core` passes, and `-- fixtures` still passes. Paste the
summary.
