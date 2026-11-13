# WP5 — GLB ↔ three.js conformance: shared pose math + golden tests (coder: Sonnet)

Read first: `docs/coding-rules.md`, `docs/contracts.md` (§2, §3, §5, §7, §8, §13, §16 `dump_skinned`, §21),
`docs/briefs/WP4c-rig-build.md`, `docs/briefs/WP4d-imported-rigs.md`.
Depends on WP4c and WP4d being merged.

Goal: prove that what three.js shows equals what Blender bakes, **both for bones (1e-5 m) and skinned
vertices (1e-4 m)**, on an auto rig and an imported rig, for random poses. This package also creates
the TS pose math the renderer will use.

## Engine side
1. `engine/jobs/dump_skinned.py` (§16):
   - Opens `<project_dir>/rig/rig.blend` and applies the args `pose` (mpm.pose/1) with
     `engine.mpm.pose.apply_pose_state`.
   - For each mesh, reads the **evaluated** mesh (armature only; there is no subdivision in rig.blend)
     and returns the positions for the requested `_ORIG_INDEX` values. `sample` is
     `{mesh_name: [indices]}` or `"all"`.
   - Also returns every bone's posed head and tail (`pose_bone.head`/`.tail`, armature space).
   - Result: `{"meshes": {name: {"indices": [...], "positions": [[x,y,z], …]}}, "bones": [{"index", "head", "tail"}]}`
     in Blender coordinates, metres.
2. `tests/engine/make_golden.py`: a Blender script (run directly, not through run.py) writing
   `tests/golden/<case>/`.
   - Cases:
     - `auto_apose`: fixture `apose`, rigged by WP4c from the **truth** markers
     - `imported_mixamo`: fixture `rigged_mixamo`, rigged by WP4d from its suggested mapping
   - Per case, write:
     - `rig.json`
     - `rig_noimg.glb`: the §7 export call but with `export_materials='NONE'` and
       `export_image_format='NONE'`; nothing else changes
     - `poses.json`: 3 poses, seeded with 42. Each draws a random unit axis and an angle in [0°, 40°]
       per bone for `deltas`, composed parent-first so the deltas are consistent, plus
       `root_offset` = random within ±5 cm. Also include the identity pose.
     - `expected.json`: the `dump_skinned` output per pose, with 2000 seeded random `_ORIG_INDEX`
       samples per mesh
   - `tests/golden/` is git-ignored. Add it to `.gitignore`; that edit is allowed in this package.

## TS side (`src/shared/`, pure: three.js only, no DOM, no Node APIs)
1. `coords.ts`:
   - the `C` matrix
   - `vecB2T`, `vecT2B`
   - `quatB2T(q_wxyz) -> THREE.Quaternion`, `quatT2B(THREE.Quaternion) -> [w,x,y,z]` (normalised,
     w ≥ 0)
   - `mat3B2T` / `mat3T2B`

   All of these go through the matrix form (§2).
2. `rig.ts`:
   - The `RigJson` type (§8).
   - `bindRig(gltf, rig: RigJson) -> BoundRig`. It finds each bone's Object3D through
     `gltf.parser.associations` and `rig.bones[i].gltf_node`, **never by name**, records each bone's
     rest local quaternion and rest armature-space rotation (relative to the armature node), and lists
     the skinned meshes.
   - Throws a clear error if any `gltf_node` isn't found.
3. `poseMath.ts`:
   - `applyPoseState(bound, rig, deltas, rootOffset)` implements §5 in three space:
     - `D_t = Cᵀ·D_b·C`
     - local quaternion `q_local_b = q_restlocal_b · (R_rest_b⁻¹ · D_p⁻¹ · D_b · R_rest_b)`, with every
       R the bone's **three-space** rest armature rotation
     - a missing delta gives `D = D_parent`
     - the root offset goes to the hips bone, converted into its parent's local space
   - Then `updateMatrixWorld(true)`.
   - Also `posedHeadsBlender(bound) -> [x,y,z][]` (armature space → Blender coords).
4. `skinSample.ts`:
   - `skinnedPositionsBlender(bound, meshName, origIndices) -> [x,y,z][]`, using
     `SkinnedMesh.getVertexPosition` (applies skinning) for the first glTF vertex whose `_orig_index`
     attribute equals each requested index, then converted to Blender coordinates.
   - GLTFLoader lowercases custom attribute names to `_orig_index`. Verify, and report what you find.

## Tests (`tests/ts/conformance.test.ts`, vitest, node environment)
- Load `tests/golden/<case>/rig_noimg.glb` with `GLTFLoader.parse` (an ArrayBuffer from `fs`).
- For each pose:
  - posed heads match `expected.bones[].head` within **1e-5 m**
  - sampled vertices match within **1e-4 m**
- The identity pose matches the rest pose.
- If `tests/golden` is missing:
  - **skip** with a console message, unless the env `MPM_REQUIRE_GOLDEN=1`, in which case **fail**
- Plus unit tests in `tests/ts/coords.test.ts`:
  - `quatB2T` ∘ `quatT2B` round-trips
  - `C` maps three +Y to Blender +Z
  - `vecT2B` of three (1, 2, 3) is Blender (1, −3, 2)

## Acceptance
1. `"<blender>" -b --factory-startup --python-exit-code 1 -P tests/engine/make_golden.py`, then
   `MPM_REQUIRE_GOLDEN=1 npm test`, passes.
2. Plain `npm test` with no golden files skips cleanly.
3. `npm run typecheck` passes.
4. Report the max errors observed per case and pose.
