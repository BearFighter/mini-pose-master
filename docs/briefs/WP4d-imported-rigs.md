# WP4d — Imported (pre-rigged) characters: bone mapping + rig normalisation (coder: Sonnet)

Read first: `docs/coding-rules.md`, `docs/contracts.md` (§3, §4, §5, §7, §8 incl. "Imported rigs", §10 finger frame,
§16 `suggest_mapping`/`rig`), `docs/briefs/WP4c-rig-build.md` (you reuse its export, pose, and
parity code; WP4c must be merged first).

## Files to create
- `engine/mpm/rig/imported.py`:
  - `suggest_mapping(arm) -> dict`, the §16 `suggest_mapping` result
  - `rig_imported(arm, meshes, project_dir, mapping) -> rig_json`
- `engine/jobs/suggest_mapping.py`: opens `rig/scene.blend`, finds the armature (else `E_ARGS`), and
  returns `suggest_mapping`
- `tests/engine/test_imported.py`

`engine/jobs/rig.py` (from WP4c) already calls `rig_imported` when `args.mapping` is given. Don't edit
it; if its call signature differs from the one above, report it under QUESTIONS.

## Name normalisation
- `base = re.sub(r'^.*:', '', name)`: strips `mixamorig:` and `mixamorig1:`-style prefixes.
- Side detection on `base`, case-insensitive, checked in this order:
  1. `^(left|right)` (Mixamo `LeftArm`)
  2. `(^|[ _.])(l|r)([ _.]|$)` (UE `_l`, Biped `Bip01 L UpperArm`, Rigify `.L`)
  3. `(left|right)$`

  The side is L or R; strip the side token to get the **stem**.
- Conventions, with the first matching detector winning:
  - `mixamo`: any bone named `Hips` after prefix stripping, with `LeftUpLeg` present
  - `ue`: `pelvis` and `upperarm_l` present
  - `biped`: a bone starting `Bip0` (`Bip01`, `Bip001`)
  - `rigify`: any bone starting `DEF-`; use only `DEF-` bones
  - otherwise `unknown`: return an empty mapping with confidence 0

## Mapping tables (stem → canonical; `{S}` = side)

| canonical | mixamo | ue | biped | rigify |
|---|---|---|---|---|
| hips | Hips | pelvis | Pelvis | DEF-spine |
| spine | Spine | spine_01 | Spine | DEF-spine.001 |
| chest | the highest `Spine\d*` | the highest `spine_0\d` | the highest `Spine\d*` | DEF-spine.003 |
| neck | Neck | neck_01 | Neck | DEF-spine.004 |
| head | Head | head | Head | DEF-spine.006 |
| shoulder.{S} | Shoulder | clavicle | Clavicle | DEF-shoulder |
| upper_arm.{S} | Arm | upperarm | UpperArm | DEF-upper_arm |
| forearm.{S} | ForeArm | lowerarm | Forearm | DEF-forearm |
| hand.{S} | Hand | hand | Hand | DEF-hand |
| thumb.0k.{S} (k = 1..3) | HandThumb{k} | thumb_0{k} | Finger0, Finger01, Finger02 | DEF-thumb.0{k} |
| index.0k.{S} | HandIndex{k} | index_0{k} | Finger1, Finger11, Finger12 | DEF-f_index.0{k} |
| middle.0k.{S} | HandMiddle{k} | middle_0{k} | Finger2, Finger21, Finger22 | DEF-f_middle.0{k} |
| ring.0k.{S} | HandRing{k} | ring_0{k} | Finger3, Finger31, Finger32 | DEF-f_ring.0{k} |
| pinky.0k.{S} | HandPinky{k} | pinky_0{k} | Finger4, Finger41, Finger42 | DEF-f_pinky.0{k} |
| thigh.{S} | UpLeg | thigh | Thigh | DEF-thigh |
| shin.{S} | Leg | calf | Calf | DEF-shin |
| foot.{S} | Foot | foot | Foot | DEF-foot |
| toe.{S} | ToeBase | ball | Toe0 | DEF-toe |

Everything else maps to **null**:
- middle spine/neck bones (Mixamo `Spine1`, UE `spine_02`–`04` and `neck_02`, Biped middle spines)
- twist bones (`twist` in the name)
- `ik_*`, `root`, `Bip01` itself
- metacarpals, `*_End` / `*4` end bones
- Rigify `.001` segment bones

The "highest" spine is the one deepest in the hierarchy among bones whose stem matches. When the chest
candidate is the same bone as spine, chest is null.

`confidence` = mapped canonical bones that exist ÷ 53, rounded to 2 decimals.
`unmapped_canonical` lists the canonical names not found.

## `rig_imported`
1. **Normalise the armature (§7.2)**:
   - remove all bone constraints, drivers and the action
   - `use_inherit_rotation = True`, `inherit_scale = 'FULL'`, `bbone_segments = 1`
   - clear the pose to rest
   - the armature object matrix must already be identity (WP3 importer); assert it
2. **Grip bones**: add non-deform bones `mpm_grip.L/R` (parent = the mapped hand bone, not connected)
   at the §4 grip joints, but **only when that side has all 5 `.01` finger bones mapped**. Compute the
   joints first (step 4) from the mapped finger bones. Roll per §3: `align_roll(palm_normal)`.
3. **Weights**: keep the asset's own vertex groups, then apply the §7 parity rules exactly as WP4c
   does. Reuse WP4c's function; don't copy it. If WP4c's code isn't reusable as-is, stop and report
   which function you need and why.
4. **Joints for rig.json** (§8 "Imported rigs"):
   - canonical head joints from the mapped bones' heads
   - `head_top` = the head bone's tail; `<f>_tip` = the `.03` tail; `toe` = the toe bone's tail
   - derived joints by the §4 rules where their inputs exist
   - `hands[s]` per §4 when fingers are mapped, else null
5. **Export** with WP4c's `export_rig(..., kind="imported")`: same GLB settings and the rig.json
   schema, with indices in Blender bone order.
6. **Self-check** (as in WP4c): test-pose `upper_arm.L` and `thigh.R` via their mapped bones, then
   follow-check; `E_FOLLOW_CHECK` on failure.

## Tests (`tests/engine/test_imported.py`)
For `rigged_mixamo`, `rigged_ue` and `rigged_biped` (import with the WP3 importer, normalised with the
suggested orientation):

| Check | Requirement |
|---|---|
| `convention` | detected correctly |
| `suggest_mapping` | equals the truth `mapping` for every key; null entries must be null too |
| rig.json bones | count = armature bones + the 2 grip bones |
| canonical joints | equal the mapped bone heads within 1e-6 |
| `hands.L` / `hands.R` | non-null, with the palm-normal sign matching the fixture truth (T-pose → L palm normal z < 0; UE A-pose → L palm normal x < 0) |
| follow check | passes |
| GLB nodes | present for every bone |
| weights | the parity rules hold (≤ 4 influences, sum 1, no zero weights) |
| unknown convention | renaming every bone of a copy to `bone_###` gives `convention == "unknown"` and an empty mapping, with no exception |

## Acceptance
`blender … -P tests/engine/run.py -- imported` passes, and the earlier suites still pass.
