# Mini Pose Master — contracts

These contracts are binding for every work package. If something you need is not covered here, stop
and report it in your final message. Do not decide it yourself.

---------------------------------------------------------------------------------------------------
## 1. Repository layout and pinned versions

```
electron/main/      Electron main process (TypeScript)
electron/preload/   contextBridge API (TypeScript)
src/                renderer (React + TypeScript)
src/shared/         code shared by main + renderer (types, skeleton loader, math). No DOM, no Node APIs.
engine/mpm/         Python package run INSIDE Blender (bundled Python 3.13, numpy 2.3, NO scipy)
engine/jobs/        one Blender entry script per job type: engine/jobs/<type>.py
resources/          skeleton.json, hand_presets.json, packs.json, icons. Copied to the app as-is.
fixtures/           fixture generator (Blender script) + generated fixtures (small ones committed)
tests/              tests/ts (vitest), tests/engine (run through Blender), tests/golden
docs/               this file, briefs/, coding-rules.md
```

Pinned npm versions (exact, no ^ or ~):
- electron 45.3.2, electron-vite 6.0.0, electron-builder 26.18.0, electron-updater 6.8.11
- vite 8.3.8, @vitejs/plugin-react 6.3.0, typescript 5.9.3
- react 19.3.1, react-dom 19.3.1, @types/react 19.3.0, @types/react-dom 19.3.0, @types/node 26.6.6
- three 0.187.0, @types/three 0.187.0, @react-three/fiber 9.8.2, @react-three/drei 10.7.9,
  three-mesh-bvh 0.9.18, zustand 5.1.0, zod 4.6.7
- vitest 5.1.0, tree-kill 1.2.2, license-checker-rseidelsohn 5.0.1

Engine: **Blender 5.2.x LTS only.** Verify with `blender --version`, whose first line is
`Blender 5.2.N`.

---------------------------------------------------------------------------------------------------
## 2. Coordinates and units

- **Blender / engine / all JSON files**: right-handed, **Z up**, the figure faces **−Y**, the figure's
  **left is +X**, units are **metres**. Every JSON position, quaternion and matrix uses this frame
  unless the field name says otherwise.
- **three.js / glTF**: Y up. The Blender glTF exporter with `export_yup=True` maps Blender
  (x, y, z) → glTF (x, z, −y).
- The conversion matrix from three to Blender is
  `C = [[1,0,0],[0,0,-1],[0,1,0]]` (maps (x, y, z) to (x, −z, y)), and C⁻¹ = Cᵀ.
  - Vectors: `v_b = C · v_t`.
  - Rotations: `R_b = C · R_t · Cᵀ`.
  - C is a **+90° rotation about X** (it takes three's +Y to Blender's +Z). Convert quaternions
    through the matrix form; don't hand-derive them.
- **Quaternions in JSON are always `[w, x, y, z]`** (Blender order), normalised, with **w ≥ 0**
  (negate all four if w < 0). three.js uses (x, y, z, w); convert at the boundary only.
- **Matrices in JSON** are only used where the field name ends in `_m4`: 16 numbers, **row-major**,
  in Blender coordinates.
- Model-space units are metres. Print-space units are millimetres and are only used in bake settings
  and reports.

---------------------------------------------------------------------------------------------------
## 3. Canonical skeleton and bone identity

- `resources/skeleton.json` is the only definition of the bones. Expand it with its `expand` rule.
  Loaders: `src/shared/skeleton.ts` and `engine/mpm/skeleton.py`. Both must produce the same ordered
  list, and there is a test for it.
- **Bone identity at runtime is the index in `rig.json.bones`**, never a three.js object name.
  GLTFLoader sanitises names (`upper_arm.L` → `upper_armL`). In the renderer, find each bone's
  Object3D through `gltf.parser.associations.get(obj).nodes === rig.json.bones[i].gltf_node`.
- Imported (pre-rigged) characters keep their own bones. `rig.json.bones[i].canonical` holds the
  canonical name, or null if the bone is unmapped.

---------------------------------------------------------------------------------------------------
## 4. Markers and derived joints

Markers file (`rig/markers.json`):
```json
{ "schema": "mpm.markers/1",
  "markers": { "<joint name>": { "p": [x,y,z], "confidence": 0.0-1.0, "source": "auto"|"user" } } }
```
Only **editable** joints (skeleton.json) appear. Derived joints are computed by the engine at rig
time, and identically in TS for preview, from these rules (`lerp(a, b, t) = a + t·(b − a)`):

| Derived | Rule |
|---|---|
| `spine0` | `lerp(pelvis, chest, 0.30)` |
| `clav_s` | `(sign·0.18·|shoulder_s.x − pelvis.x|, neck.y, neck.z − 0.25·(neck.z − shoulder_s.z))`, where `sign` = +1 for L and −1 for R, and x is measured from the pelvis x |
| `ball_s` | `lerp(ankle_s, toe_s, 0.68)` with z = `0.35·ankle_s.z + 0.65·toe_s.z` |
| `<f>_1_s`, `<f>_2_s` for index/middle/ring/pinky | `lerp(<f>_0, <f>_tip, 0.45)` and `lerp(<f>_0, <f>_tip, 0.75)` |
| `thumb_1_s`, `thumb_2_s` | `lerp(thumb_0, thumb_tip, 0.40)` and `lerp(thumb_0, thumb_tip, 0.73)` |
| `grip_s` | palm centre `= mean(index_0, middle_0, ring_0, pinky_0, wrist)` + `palm_normal_s · 0.35·hand_width_s` |
| `grip_tip_s` | `grip_s + grip_axis_s · 0.10` |

Hand frame for side s:
- `hand_axis = normalize(middle_0 − wrist)`
- `lateral = normalize(index_0 − pinky_0)`
- `palm_normal = normalize(cross(hand_axis, lateral))` for L and `normalize(cross(lateral, hand_axis))`
  for R. The palm normal points **out of the palm**. The fixture tests check its sign: for a relaxed
  A-pose hand hanging at the side, the L palm normal has a negative x component (it faces the thigh).
- `hand_width = |index_0 − pinky_0|`
- `grip_axis` is the direction a gripped cylinder runs through the fist:
  `normalize(lateral − hand_axis·dot(lateral, hand_axis))`

---------------------------------------------------------------------------------------------------
## 5. Pose math (shared by the renderer and the engine)

Armature space: for our rigs, the armature object's matrix is **identity**. The rig job asserts it:
it applies all transforms and leaves no parent inverses, and the glTF armature node then has the
identity transform. Every rotation below is in armature space.

For bone b with parent p:
- `R_rest_b`: rest rotation (3×3, armature space). In Blender this is `bone.matrix_local.to_3x3()`;
  in three it is the bone's rest world rotation relative to the armature node, then converted with C.
- `D_b`: **pose delta**, the armature-space rotation that takes the rest orientation to the posed one.
- Posed armature rotation: `R_b = D_b · R_rest_b`.
- Posed head:
  - root bone: `h_b = h_rest_b + root_offset`
  - other bones: `h_b = P_p · (P_rest_p⁻¹ · h_rest_b)`, where `P` is the full 4×4 posed armature
    matrix of the parent and `P_rest` its rest matrix. Equivalently,
    `h_b = h_p + D_p · (h_rest_b − h_rest_p)`.
  - There is **no per-bone translation and no scale**.
- three.js local quaternion of bone b:
  - `q_local_b = q_restlocal_b · (R_rest_b⁻¹ · D_p⁻¹ · D_b · R_rest_b)`
  - with `q_restlocal_b = R_rest_p⁻¹ · R_rest_b` (the bone's rest local rotation as loaded), and every
    term converted into three's frame first: `D_t = Cᵀ · D_b · C`.
  - For the root bone, D_p = I and R_rest_p = the armature node's rotation (identity).
- **Unmapped or absent bones**: `D_b = D_p` (they follow their parent rigidly).
- **Root offset**: `pose.root_offset` (metres, armature space) is added to the head of the bone whose
  canonical name is `hips`. If that bone has a parent (for example a UE `root` or `pelvis` chain), the
  engine and the renderer move the hips bone, not its ancestors.
- **Mirror**: `S = diag(−1, 1, 1)`. Then `D'_b = S · D_{swap(b)} · S`, where `swap` exchanges `.L` and
  `.R` (and `_L`/`_R` joints). In quaternions, `[w, x, y, z] → [w, x, −y, −z]`. The root offset becomes
  `[−x, y, z]`.
- **Engine application** (Python, top-down in skeleton order):
  `pose_bone.matrix = Matrix.Translation(h_b) @ (D_b @ R_rest_b).to_4x4()`, followed by
  `view_layer.update()` before the children. This is the mechanism of `rig.apply_pose` in the
  prototype.

Tolerances: renderer and engine must agree on every bone head and tail to **1e-5 m**, and on sampled
skinned vertices (section 7) to **1e-4 m**.

---------------------------------------------------------------------------------------------------
## 6. Retargeting a clip frame onto a rig (TS `retarget.ts`; Python reference `engine/mpm/retarget.py`)

Input: one clip frame (section 9) and the rig (rest heads/tails from rig.json plus canonical names).
Output: `D_b` for every mapped canonical bone.

1. Joint positions come from the clip, **never bone axes**. Clip joints use the canonical joint names
   of skeleton.json. The direction of bone b is `d_b = normalize(P[tail_joint(b)] − P[head_joint(b)])`.
   The rig's rest direction is `d_rest_b = normalize(tail_rest_b − head_rest_b)`, from rig.json.
2. **Torso** (`hips`, `spine`, `chest`, `neck`):
   - Use two-vector frames with a lateral side vector: `side_hips = P[hip_L] − P[hip_R]`,
     `side_chest = P[shoulder_L] − P[shoulder_R]`, `side_spine = normalize(side_hips) + normalize(side_chest)`,
     `side_neck = side_chest`.
   - Rest side vectors come from the same joints in the rig's rest pose.
   - `D_b = frame(d_b, side_b) · frame(d_rest_b, side_rest_b)ᵀ`.
3. **Head, hands, feet**: two-vector frames whose secondary vector comes from the clip rotations
   (section 9):
   - head: `fwd = q_head ⊗ (0, −1, 0)`
   - hand.s: `palm = q_hand_s ⊗ (0, 0, −1)`
   - foot.s: `up = q_foot_s ⊗ (0, 0, 1)`
   - Rest secondary vectors: head (0, −1, 0); hand.s the rig's rest `palm_normal_s` (section 4);
     foot.s (0, 0, 1).
   - `D_b = frame(d_b, sec_b) · frame(d_rest_b, sec_rest_b)ᵀ`.
4. **Upper limbs** (`upper_arm.s`, `thigh.s`): use the fold-plane frame.
   - `fold = l − d·dot(l, d)`, where d is the bone's direction and l is its child's direction
     (forearm or shin).
   - If `|fold| > sin(12°)`: `D_b = frame(d_b, fold_b) · frame(d_rest_b, fold_rest_b)ᵀ`, where
     `fold_rest_b` is the rest fold vector computed the same way from rest directions. If the rest limb
     is straight, its rest fold vector is `(0, −1, 0)` projected for arms and `(0, 1, 0)` projected
     for legs.
   - Otherwise use the swing rule (step 5).
5. **Everything else** (shoulders, forearms, shins, toes, finger bones without clip data) uses the
   swing rule, applied parents-first:
   - Inherited delta: `D_inh = D_p`.
   - Current direction: `c = D_inh · d_rest_b`.
   - `D_b = rot(c → d_b) · D_inh`, where `rot(a → b)` is the minimal rotation taking a to b
     (Rodrigues; if a ≈ −b, rotate 180° about any axis perpendicular to a).
6. `frame(y, x_hint)` builds an orthonormal basis with columns `[x, y, z]`:
   - `y = normalize(y)`
   - `x = normalize(x_hint − y·dot(x_hint, y))`
   - `z = cross(x, y)`
7. Finger bones are only set from the clip if the clip has finger data; otherwise from the hand pose
   (section 10).
8. `root_offset` = (0, 0, 0). Floor contact is handled by "plant feet" (section 12).

The Python reference implementation and the TS port must give the same D (angle difference
< 0.01°) on the parity fixtures.

---------------------------------------------------------------------------------------------------
## 7. Skinning parity and GLB export (engine)

Before exporting `rig.glb` and before baking, the rig job enforces all of the following on every mesh:
1. Exactly **one Armature modifier**, first in the stack. `use_deform_preserve_volume=False`,
   `use_bone_envelopes=False`, `use_vertex_groups=True`. All other modifiers and all shape keys are
   applied or removed **before** weighting.
2. Every bone has `bbone_segments = 1`. Imported rigs: remove constraints, drivers and actions; set
   `use_inherit_rotation = True` and `inherit_scale = 'FULL'`.
3. Vertex groups exist only for deform bones of the armature.
4. Per vertex:
   - keep the **4 largest** weights, drop weights < 1e-3, then renormalise to a sum of 1
   - **assert** no vertex has zero total weight; if one does, give it the weights of its nearest
     weighted vertex, and if that's impossible fail with `E_WEIGHTS_EMPTY`
5. Every mesh gets an `INT` point attribute **`_ORIG_INDEX`** = the vertex index. It is exported as the
   glTF attribute `_ORIG_INDEX`.

GLB export call (exact):
```python
bpy.ops.export_scene.gltf(filepath=..., export_format='GLB', use_selection=True,
    export_yup=True, export_apply=False, export_skins=True, export_def_bones=False,
    export_rest_position_armature=True, export_influence_nb=4, export_all_influences=False,
    export_animations=False, export_morph=False, export_extras=True, export_attributes=True,
    export_materials='EXPORT', export_image_format='AUTO')
```
Images larger than 2048 px on their longest side are scaled down to 2048, on a copy, before export.
After export, the engine parses the GLB JSON chunk and records every bone's `gltf_node` index in
`rig.json`.

---------------------------------------------------------------------------------------------------
## 8. rig.json

```json
{ "schema": "mpm.rig/1",
  "hash": "<sha1 of the bone table + weights summary>",
  "kind": "auto" | "imported",
  "height_m": 1.84,
  "floor_z": 0.0,
  "bones": [ { "index": 0, "name": "hips", "canonical": "hips"|null, "parent": -1,
               "head": [x,y,z], "tail": [x,y,z], "rest_q": [w,x,y,z], "deform": true,
               "gltf_node": 12, "radius_m": 0.012|null } ],
  "meshes": [ { "name": "Body", "gltf_node": 3, "vertices": 6400, "normal_map": true } ],
  "joints": { "<canonical joint name>": [x,y,z] },
  "hands": { "L": { "palm_normal": [..], "lateral": [..], "hand_axis": [..], "hand_width": 0.08 },
             "R": { ... } }
}
```
`rest_q` is `R_rest_b` as a quaternion. `radius_m` is set for finger bones (the mean distance from
the bone axis to the mesh vertices weighted > 0.5 to that bone) and is null elsewhere.

---------------------------------------------------------------------------------------------------
## 9. Clip format (pose library)

Library folder: `<library>/packs/<pack_id>/` contains `index.json`, plus `clips/<clip_id>.f32` and
`thumbs/<clip_id>_<frame>.png`.

`index.json`:
```json
{ "schema": "mpm.pack/1", "pack": "bandai1", "title": "...", "license": "CC BY-NC 4.0",
  "license_url": "...", "exportable": false,
  "joints": ["pelvis","spine0", "..."],
  "has_fingers": false,
  "clips": [ { "id": "dance-long_normal_001", "move": "dance-long", "style": "normal",
               "tags": ["dance"], "frames": 1234, "fps": 15,
               "key_frames": [12, 340] } ] }
```

`clips/<id>.f32`, all little-endian:
1. A 16-byte header: the 4 ASCII bytes `MPM0`, then uint32 F (frames), uint32 J (joints = length of
   `index.json.joints`), and uint32 version = 1.
2. F × J × 7 float32 values `[px, py, pz, qw, qx, qy, qz]`, frame-major, then in joint order.
3. F × uint32 contact bitmasks (bit 0 = left foot on the floor, bit 1 = right foot).

Rules for what is stored:
- **Positions**: metres, Blender frame, normalised **per frame**. The hips (pelvis) x and y are 0,
  the heading turns so the hip line points +X (the figure faces −Y), and z is measured from the
  clip's floor (2nd percentile of the lowest foot joint over the clip).
- **Rotations**: each joint's world rotation in the same normalised frame, **relative to the
  reference pose**. The reference pose (identity) is a T-pose facing −Y with palms down (−Z), feet
  flat and head level. Each converter has a per-source calibration (`engine/mpm/convert/sources.py`)
  that maps the source's rest pose to the reference. Calibration is verified with the palm/forward
  check in the converter tests.
- **Frames are picked, never interpolated**, when resampling to 15 fps: take the nearest source
  frame.
- `exportable: false` means clip data must never leave the library folder. That covers LaFAN1 and any
  pack whose license is ND.

---------------------------------------------------------------------------------------------------
## 10. Hand pose

`resources/hand_presets.json` and each project's hands use this format:
```json
{ "schema": "mpm.hand/1", "name": "rifle_trigger",
  "fingers": {
    "thumb":  { "flex": [f1,f2,f3], "spread": s, "roll": r },
    "index":  { "flex": [f1,f2,f3], "spread": s },
    "middle": { ... }, "ring": { ... }, "pinky": { ... } } }
```
- Angles are in degrees.
- **Flex** rotates about the bone's local X (positive curls toward the palm).
- **Spread** rotates about local Z, with **positive toward the thumb side** for both hands; the
  implementation picks the sign per side.
- **Roll** (thumb only) rotates about local Y.
- Per-bone local delta in the bone's own rest frame: `L = Rz(spread) · Rx(flex) · Ry(roll)`. Spread
  and roll apply only to the `.01` bone.
- The resulting armature delta is `D_b = (R_parent_posed · R_rest_parent⁻¹ · R_rest_b · L) · R_rest_b⁻¹`,
  which is consistent with section 5.

---------------------------------------------------------------------------------------------------
## 11. Auto-grip (renderer, `autoGrip.ts`)

Inputs:
- the posed rig with the hand pose as a starting point
- weapon meshes with a three-mesh-bvh BVH (in world space)
- `tol_m`: 0.2 mm converted to model metres using the current bake scale

Per finger:
- Process the joints proximal → distal (`.01`, `.02`, `.03`).
- Increase flex in **2° steps** up to the per-joint maximum:
  - fingers: [95, 110, 85]
  - thumb: [60, 70, 85]
- Stop a joint when the capsule of **that joint's bone or any bone distal to it** reaches a
  capsule-to-mesh distance ≤ `tol_m`. Use the BVH `shapecast` for capsule distance; the capsule radius
  is `rig.json` `radius_m`.
- After a joint stops, continue with the next joint.
- `locked` fingers (the user ticked "keep") are skipped. For example, the trigger index finger stays
  extended for "rifle trigger, finger off trigger".

---------------------------------------------------------------------------------------------------
## 12. Weapons, two-hand IK, plant feet

Weapon entry (project file):
```json
{ "id": "w1", "file": "weapons/rifle.glb", "attach_bone": "grip.R",
  "offset": { "t": [x,y,z], "q": [w,x,y,z], "s": 1.0 },
  "support": { "enabled": true, "side": "L", "point": [x,y,z], "normal": [x,y,z], "axis": [x,y,z] },
  "merge": true }
```
- The weapon's world transform is `posed(attach_bone) · TRS(offset)`. `offset` is in the attach
  bone's posed frame. Weapon geometry is in metres, in Blender frame.
- `support.point`, `normal` and `axis` are in **weapon-local** coordinates. They give where the support
  hand's grip socket goes, which way the palm faces, and the grip axis.
- **Two-hand IK** (`ik.ts`, Python reference `engine/mpm/ik.py`):
  1. Target socket position `T = W · point`. The support hand's target orientation comes from
     `frame(axis_world, normal_world)` matched to the hand's `frame(grip_axis, palm_normal)`.
  2. Solve the arm with two-bone IK: upper_arm and forearm with fixed lengths, shoulder fixed.
  3. The elbow pole is the current elbow position projected, falling back to `(sign·1, 0.3, −1)`
     normalised.
  4. Then set the hand delta so the hand frame matches the target orientation exactly.
  5. If out of reach: stretch no bones, point the arm at the target, and report `reach_short_m`.
- **Plant feet**:
  - A foot is "in contact" if the clip frame's contact bit is set.
  - With 2 contacts, raise the lower foot to the higher one by two-bone IK on that leg, keeping the
    foot's world orientation (as the prototype's `plant_feet` does).
  - With 1 or 0 contacts, nothing changes.
  - The bake always moves the lowest point of the mesh to z = 0.

---------------------------------------------------------------------------------------------------
## 13. Pose state (renderer → bake), stored in the project file

```json
{ "schema": "mpm.pose/1", "rig_hash": "...",
  "root_offset": [x,y,z],
  "deltas": { "<rig.json bone index>": [w,x,y,z] },
  "provenance": { "pack": "lafan1", "clip": "aiming1_subject1", "frame": 512,
                  "mirrored": false, "edits": [ {"bone": 7, "q": [w,x,y,z]} ] } }
```
`deltas` must contain **every** bone of rig.json, with unmapped bones resolved to `D_parent`, so the
engine needs no rules. If `rig_hash` differs from the current rig, the renderer re-derives the pose
from `provenance` and warns the user.

---------------------------------------------------------------------------------------------------
## 14. Bake settings, gates, budgets

```json
{ "schema": "mpm.bake/1",
  "scale": { "mode": "height_mm", "height_mm": 40 } | { "mode": "heroic", "size_mm": 32 },
  "detail": 2.0, "flatten_mm": 0.5, "base_mm": 0, "min_wall_mm": 0.6,
  "weapons_separate": false, "max_tris": 2000000 }
```
- `heroic`: the eye height of the standing rest pose (from the `head` joint z + 0.4·(head_top − head))
  equals `size_mm`.
- `height_mm` is the standing rest height, so poses keep their scale (a crouch prints shorter).
- **Gates, in order**: follow-check (≥ 5 % of vertices moved when any D ≠ I; worst drift of a weighted
  vertex from its bone < 1 % of height; posed bbox < 2 × rest bbox), then budgets, then remesh.
- **Budgets**:
  - subdivided faces ≤ 8,000,000 in total; lower the subdivision level per mesh until under
  - meshes without a normal map use level 0
  - estimated voxels = total surface area / voxel² ≤ 60,000,000; otherwise coarsen the voxel up to
    2× and report it, or fail `E_BUDGET`

---------------------------------------------------------------------------------------------------
## 15. Project format

A project is a folder `<Name>/` containing `<Name>.mposer` (JSON) and:
```
source/    copied imported model + textures
rig/       scene.blend, rig.blend, rig.glb, rig.json, markers.json
weapons/   copied weapon files + converted .glb
exports/   baked STL + preview .glb + report.json
cache/     anything regenerable
```

`<Name>.mposer`:
```json
{ "schemaVersion": 1, "app": "Mini Pose Master", "appVersion": "0.1.0",
  "source": { "file": "source/hero.fbx", "orientation": { "up": "Z", "forward": "-Y", "unit_scale": 1.0 } },
  "rig": { "kind": "auto"|"imported", "hash": "..." } | null,
  "pose": <section 13> | null,
  "hands": { "L": <hand pose> , "R": <hand pose>, "locked": {"R": ["index"]} },
  "weapons": [ <section 12> ],
  "bake": <section 14> }
```
- All paths are relative to the project folder.
- Licensed clip data is never embedded; projects store only `provenance`.
- Loading a `schemaVersion` older than the current one runs migrations in
  `src/shared/project-migrations.ts`.

---------------------------------------------------------------------------------------------------
## 16. Jobs

Invocation (main process):
```
<blender> -b --factory-startup --offline-mode --python-exit-code 1 -P <abs engine>/jobs/<type>.py -- <abs job.json>
```
- On Linux inside an AppImage, remove `LD_LIBRARY_PATH`, `APPDIR`, `APPIMAGE`, `PYTHONHOME`,
  `PYTHONPATH` from the child environment.
- Kill the whole tree (tree-kill) on cancel; if it's still alive after 5 s, send SIGKILL.

`job.json`:
```json
{ "schema": "mpm.job/1", "id": "<uuid>", "type": "...", "project_dir": "<abs>", "args": { ... } }
```

**stdout protocol**: one line per message, ASCII-only JSON (`json.dumps(..., ensure_ascii=True)`,
`flush=True`), each line starting with a tag. Anything else on stdout or stderr is log text.
```
@@progress {"stage": "remesh", "fraction": 0.4, "message": "voxel remeshing"}
@@result   { ... job-type specific ... }
@@error    {"code": "E_FOLLOW_CHECK", "message": "...", "detail": {...}}
```
Exactly one `@@result` or `@@error` per job. Exit code 0 means success.

Job types (args → result):

| type | args | result |
|---|---|---|
| `import` | `file`, `orientation` (optional; else auto) | `objects[]` (with `materials`), `materials[]`, `normal_maps[]`, `has_armature`, `armature_bones[]`, `tri_count`, `height_m`, `suggested_orientation`, `orientation_used`, `proxy` (bool), `warnings[]`; writes `rig/scene.blend` |
| `suggest_markers` | – | `markers` (section 4) + `warnings[]` |
| `rig` | `markers` or `mapping` (`{bone_name: canonical_name}`) | `rig_json`, `rig_glb`, `follow` stats; writes `rig/rig.blend` |
| `convert_clip` | `source`, `file`, `pack_dir` | `clips[]` ids added |
| `dump_skinned` | `pose`, `sample` (list of `_ORIG_INDEX`) | `positions` (same order, posed, before subdivision, metres) |
| `bake` | `pose`, `hands`, `weapons`, `bake` | `stl`, `preview_glb`, `report` (`printable.summarize` fields + gates) |

Error codes:
`E_BLENDER_VERSION E_ARGS E_IMPORT_FAILED E_NO_MESH E_ORIENTATION E_MARKERS_INCOMPLETE E_WEIGHTS_EMPTY E_FOLLOW_CHECK E_BUDGET E_REMESH E_EXPORT E_IO E_CANCELLED E_INTERNAL`

---------------------------------------------------------------------------------------------------
## 17. IPC (preload exposes `window.mpm`), file protocol

Renderer → main (`ipcRenderer.invoke`, typed in `src/shared/ipc.ts`):
```
app.info()                       -> {version, platform, arch, dataDir}
app.checkUpdate()                -> {available, version?, notes?, url?}
app.installUpdate()              -> void   (Windows/Linux; macOS opens the release page)
blender.status()                 -> {found, path?, version?, source:"installed"|"downloaded"|null}
blender.setPath(path)            -> status
blender.download()               -> status            (progress via event "blender:progress")
blender.cancelDownload()         -> void
dialog.openFile({filters})       -> path|null
dialog.saveFile({defaultPath, filters}) -> path|null
project.create({name, parentDir})-> {dir, project}
project.open(path)               -> {dir, project}
project.save({dir, project})     -> void
project.importModel({dir, file}) -> {copied}          (copies into source/)
project.addWeapon({dir, file})   -> {weaponFile}
job.run({dir, type, args})       -> {jobId}           (events "job:event")
job.cancel(jobId)                -> void
library.list()                   -> packs[] (index.json contents + installed flag)
library.install(packId)          -> void              (license accepted in UI first; events "library:progress")
library.installFromFile({packId, file}) -> void
library.importClip({file, source}) -> {packId, clipIds}
shell.showItemInFolder(path)     -> void
```
On the wire, invoke channels are named `mpm:<area>.<method>` (for example `mpm:app.info`); events
use the bare event names below.
Main → renderer events: `job:event {jobId, kind:"progress"|"result"|"error"|"log", payload}`,
`blender:progress {bytes,total}`, `library:progress {packId, stage, fraction}`,
`update:event {kind, version?, url?}`, `app:open-project {path}`.

**File protocol** `mpm://`, registered as privileged (standard, secure, supportFetchAPI):
- `mpm://project/<url-encoded relative path>` resolves inside the currently open project folder.
- `mpm://library/<relative path>` resolves inside the library folder.
- Anything that resolves outside those roots, after `path.resolve`, returns 403.

Security settings: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, no `remote`.

---------------------------------------------------------------------------------------------------
## 18. Renderer store (zustand), `src/renderer/store/*`

Slices:
- `app`: info, blender status, update state
- `project`: dir, data, dirty
- `rig`: rigJson, markers, glbUrl
- `pose`: deltas by bone index, root offset, provenance, undo/redo stacks (max 100)
- `hands`: L and R hand poses, locked
- `weapons`: entries plus loaded geometry handles
- `bake`: settings
- `jobs`: active job, progress, log tail (500 lines), last result
- `ui`: step = `import|rig|pose|hands|weapons|export`, selection

Components never call IPC directly; they go through `src/renderer/api.ts`.

---------------------------------------------------------------------------------------------------
## 19. Blender manager rules (main process)

Detection, in order (the first valid one wins; valid means the first line of `--version` is
`Blender 5.2.N`):
1. The user-set path.
2. `<dataDir>/blender/<version>/...` (downloaded).
3. Windows: `%ProgramFiles%\Blender Foundation\Blender 5.2\blender.exe`, Steam
   `...\steamapps\common\Blender\blender.exe`, then `blender.exe` on PATH.
   Reject `blender-launcher.exe` and WindowsApps (Microsoft Store) paths.
4. macOS: `/Applications/Blender.app/Contents/MacOS/Blender`, then `~/Applications/...`.
5. Linux: `blender` on PATH (reject `/snap/` and flatpak), then `~/blender-5.2*/blender`.

Download (only after user consent in the UI):
- Fetch `https://download.blender.org/release/Blender5.2/` and pick the highest `5.2.N` that has a
  matching file:
  - `blender-5.2.N-windows-x64.zip`
  - `blender-5.2.N-macos-arm64.dmg`
  - `blender-5.2.N-linux-x64.tar.xz`
- Verify the archive's SHA-256 against `blender-5.2.N.sha256` in the same folder.
- Require 2.5 GB free first.
- Extract:
  - Windows: unzip
  - macOS: `hdiutil attach -nobrowse -readonly`, `ditto Blender.app`, `hdiutil detach`
  - Linux: system `tar -xJf`; if `tar` fails, show a clear error
- macOS has no Intel Blender 5.2, so x64 Macs get a clear "not supported" message.

Data directory:
- Windows: `%LOCALAPPDATA%\Mini Pose Master`
- macOS: `~/Library/Application Support/Mini Pose Master`
- Linux: `$XDG_DATA_HOME` or `~/.local/share/mini-pose-master`

---------------------------------------------------------------------------------------------------
## 20. Pose packs

`resources/packs.json` lists every pack: id, title, license, license_url, exportable, the download
source (URL + SHA-256 + size, or `"user_supplied": true`), the converter `source` id, and
filter rules (for example CMU keywords). Third-party data is **never bundled** in the app or the repo.
The license dialog must show the license name, a link, and this text: *"Non-commercial licenses: don't
sell prints made with these poses."*

---------------------------------------------------------------------------------------------------
## 21. Tests and fixtures

- Fixtures are **original** characters, generated by `fixtures/generate.py` (Blender). They come with
  ground-truth JSON (exact joints, palm normals, fingertips, the normal map's source height field).
- Tolerances:

  | Check | Tolerance |
  |---|---|
  | auto-markers | within 2 % of standing height |
  | fingertips | within 15 % of hand length |
  | renderer vs engine heads | 1e-5 m |
  | skinned vertices | 1e-4 m |
  | retarget parity | 0.01° |
  | detail height correlation vs ground truth | > 0.9 |
- Engine tests run with
  `blender -b --factory-startup --python-exit-code 1 -P tests/engine/run.py -- <test filter>`.
- TS tests: `npm test` (vitest).
