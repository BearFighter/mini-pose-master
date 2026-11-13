# WP4c — Rig build, skinning, pose application, GLB export, rig job (coder: Sonnet)

Read first: `docs/coding-rules.md`, `docs/contracts.md` (§3, §4, §5, §7, §8, §14 gates, §16), `resources/skeleton.json`,
`docs/briefs/WP4b-fingers.md` (`hand_info_from_markers`, `hand_weight_fractions`).
Prototype to port: `prototype/rig.py` (`build_armature`, `skin` with its visibility + distance
weights, `_seg_dist`, `follow_check`). **Blender's bone-heat weighting is not used**; it failed on
real game meshes.

## Files to create
- `engine/mpm/skeleton.py`: loads and expands `resources/skeleton.json` exactly like
  `src/shared/skeleton.ts`. It exports `JOINTS`, `BONES` (dicts with name, head, tail, parent,
  connected, deform), `bone_index(name)`, `mirror_name(name)`, and
  `derive_joints(markers: dict) -> dict` (all 68 joints, using the §4 rules for the derived ones and
  editable ones from markers).
- `engine/mpm/rig/build.py`: `build_armature(joints, hands) -> bpy Object`
- `engine/mpm/rig/skin.py`: `skin(meshes, arm, joints, hands, H) -> report`
- `engine/mpm/pose.py`: `apply_pose_state(arm, deltas: dict[int, q_wxyz], root_offset)` and
  `follow_check(arm, meshes, H)`
- `engine/mpm/rig/export.py`: `export_rig(arm, meshes, project_dir, joints, hands, kind) -> rig_json dict`
- `engine/jobs/rig.py`
- `tests/engine/test_rig_build.py`

## Details
1. **Armature** (`build.py`):
   - Object name `Armature`, matrix identity. Bones are created in `skeleton.BONES` order with
     head/tail from the derived joints, `use_connect`, `use_deform` and parent from the skeleton.
   - Roll:
     - finger and grip bones (`thumb|index|middle|ring|pinky.*`, `grip.*`):
       `edit_bone.align_roll(hands[side]["palm_normal"])`, so local Z ≈ the palm normal (§3 finger
       rule)
     - all others: `align_roll((0, −1, 0))`, unless `|dir.y| > 0.9`, in which case
       `align_roll((0, 0, 1))`
   - `bbone_segments = 1` for all bones.
2. **Body weights** (`skin.py`): port the prototype's `skin()`:
   - voxel proxy occluder at `H/120`
   - candidates = the 6 nearest bones, excluding the other side's limbs (beyond the 0.02 H margin)
   - visibility ray test with a 2-voxel skip, weight `1/d⁴`
   - keep the 3 strongest, then 6 smoothing iterations along mesh edges

   The candidate bones are every deform bone **except finger bones** (thumb/index/middle/ring/pinky);
   `hand.s` stands in for the whole hand at this stage.
3. **Hand split**:
   - For each side: `info = fingers.hand_info_from_markers(objs, joints, H)`, then
     `fractions = fingers.hand_weight_fractions(mesh, joints, side, info)`.
   - For every vertex in `fractions`: `w_new[b] = w[hand.s] · fraction[b]` for each listed bone b
     (this replaces `w[hand.s]`). Other bones' weights stay.
4. **Parity rules** (§7), applied last: top 4 influences, prune < 1e-3, renormalise.
   - Zero-weight fix: nearest weighted vertex (KDTree); if none, raise `MpmError("E_WEIGHTS_EMPTY")`.
   - Vertex groups only for deform bones.
   - One Armature modifier first, `use_deform_preserve_volume=False`, `use_bone_envelopes=False`,
     `use_vertex_groups=True`.
   - Add the INT point attribute `_ORIG_INDEX` = vertex index.
5. **Pose application** (`pose.py`):
   - Implement §5 exactly: for bones in skeleton order (or `rig.json` order for imported rigs), set
     `pose_bone.matrix = Translation(h_b) @ (D_b @ R_rest_b).to_4x4()`, then `view_layer.update()`.
   - Bones missing from `deltas` get `D = D_parent`.
   - `root_offset` goes to the bone whose rig.json canonical name is `hips`.
   - Quaternions arrive as `[w, x, y, z]`.
6. **Follow check** (`pose.py`): port the prototype `follow_check`, returning
   `{moved_fraction, worst_drift, grow}`, with the §14 thresholds as module constants.
7. **Export** (`export.py`):
   - Copy-and-downscale images over 2048 px.
   - Select only the armature + meshes and call the **exact** §7 GLB export, into
     `<project_dir>/rig/rig.glb`.
   - Parse the GLB JSON chunk (read header and chunk 0) and map node names → indices; every bone and
     mesh name must be found, else `E_EXPORT`.
   - Write `rig/rig.json` per §8:
     - `index` = position in `skeleton.BONES` for `kind="auto"`
     - `rest_q` from `bone.matrix_local.to_quaternion()` (normalised, w ≥ 0)
     - `radius_m` for finger bones = the mean distance from the bone segment to mesh vertices with
       weight > 0.5 on it
     - `hands` frames, all joints, `height_m`, `floor_z`
     - `hash` = sha1 of the canonical JSON of `[(name, parent, head, tail, rest_q) …]` plus the per-bone
       weight sums rounded to 1e-4
   - Save `rig/rig.blend` (`compress=True`).
8. **Job** (`engine/jobs/rig.py`):
   - Opens `rig/scene.blend`.
   - With `args.markers` (dict), or if absent reading `rig/markers.json`: `derive_joints`, then
     build, skin, run the self-check, export.
   - With `args.mapping`: if `engine/mpm/rig/imported.py` exists, call its `rig_imported(...)`;
     otherwise raise `E_ARGS("imported rigs not available yet")`.
   - **Self-check before export**: apply a test pose (`upper_arm.L` +40° about the bone's local X,
     `thigh.R` −30°, expressed as armature-space deltas), run `follow_check`, and require
     `moved_fraction ≥ 0.05`, `worst_drift < 0.01`, `grow < 2`; else `E_FOLLOW_CHECK`. Then reset to
     the rest pose (all D = I) before export.
   - Result: `{"rig_json": "rig/rig.json", "rig_glb": "rig/rig.glb", "follow": {...}, "bones": 53, "seconds": t}`.

## Tests (`tests/engine/test_rig_build.py`)
Fixtures `apose`, `tpose`, `curled`, `mitten`. Markers = the fixture **truth** editable joints, so this
WP tests building, not marker finding.
- Bone heads/tails equal `derive_joints(truth)` within 1e-6. For apose, the derived joints equal the
  truth joints within 1e-6 (the truth was built with the same §4 rules).
- Finger bone roll: `dot(bone.z_axis, palm_normal) > 0.99`.
- Weights: every vertex 1–4 influences, sum = 1 ± 1e-6, no zero weights. Vertices within 1 cm of
  `index_tip_L` are mostly (> 0.8) on `index.03.L`.
- Follow self-check passes. Separately, `apply_pose_state` with D = I everywhere leaves the evaluated
  mesh equal to the rest mesh within 1e-6.
- §5 head rule: after a random pose (seeded), every posed head equals
  `h_p + D_p·(h_rest_b − h_rest_p)` within 1e-6.
- The GLB exists and every bone has a `gltf_node`; the glTF skin's `joints` count = 53. rig.json has
  53 bones, and its hash is stable across two runs.
- The job end to end via subprocess on a temp project (import → suggest_markers (if WP4a is merged) or
  truth markers → rig): exactly one `@@result`.
- Time: apose rig job under 60 s.

## Acceptance
`blender … -P tests/engine/run.py -- rig_build` passes, and the earlier suites still pass.
