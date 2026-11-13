# WP4a — Body auto-markers for A- and T-pose models (coder: Sonnet)

Read first: `docs/coding-rules.md`, `docs/contracts.md` (§2, §3, §4, §16, §21), `resources/skeleton.json`.

Prototype to port and generalise: `prototype/rig.py` (`surface_samples`, `_clusters` (2D),
`fit_joints`, `inside_check`). Read its comments. Every constant used there was tuned on real game
characters; keep them unless this brief changes them.

Input: a normalised `scene.blend` from the WP3 `import` job (Z up, faces −Y, left = +X, metres,
feet at z = 0, centred). Ignore objects with the custom property `mpm_proxy_of` when proxies exist,
and use the proxies instead.

## Files to create
- `engine/mpm/rig/__init__.py` (SPDX only)
- `engine/mpm/rig/sampling.py`: `surface_samples(objs, n, seed=0)` (port), `clusters2d(points_xy, gap)`
  (port of `_clusters`, generalised to points already projected to 2D).
- `engine/mpm/rig/markers.py`: `suggest_body_markers(objs) -> (markers: dict, warnings: list[str])`.
- `engine/jobs/suggest_markers.py`:
  - Opens `<project_dir>/rig/scene.blend` (`bpy.ops.wm.open_mainfile`).
  - Calls `suggest_body_markers`.
  - Calls `engine.mpm.rig.fingers.suggest_finger_markers` **only if that module exists** (WP4b adds
    it); otherwise leaves the finger markers out and adds the warning `"finger markers not available"`.
  - Writes `<project_dir>/rig/markers.json` (contracts §4 format, `source: "auto"`) and returns
    `{"markers": ..., "warnings": [...]}`.
- `tests/engine/test_markers.py`

## Output markers (editable body joints only)
`pelvis, chest, neck, head, head_top, shoulder_L/R, elbow_L/R, wrist_L/R, hip_L/R, knee_L/R, ankle_L/R, toe_L/R`.
Each marker is `{"p": [x,y,z], "confidence": c, "source": "auto"}`. The function **never raises**.
On any failure for a marker, use the fallback (below) with confidence 0.2 and add a warning naming
the marker.

## Algorithm
Let `H` be the max z of all samples (the full figure height, including any helmet), `P` 250k surface
samples of all meshes, and `gap = 0.012·H`, `slab(z)` = samples with `|z − zᵢ| < 0.006·H` (the
prototype's constants, re-based on H).

1. **Legs and torso.** Port `fit_joints` exactly for: crotch (midline fill at the legs' y-middle, scanning
   0.30–0.70 H), hips (first clean leg slice below the crotch, crotch + 0.015 H), ankle
   (z = 0.065 H; x, y from the leg cluster at 0.10 H), knee (min **lateral** width over 0.40–0.70 of
   ankle→hip, placed on the hip–ankle line), and toe (the front-most foot sample with
   z < 0.04 H; z = 0.02 H).
2. **Arm elevation.** On each side, `hand = the sample with max sign·x among samples with
   0.35 H < z < 0.95 H`. Initial shoulder guess `S0 = (sign·0.11 H, mean y of P, 0.82 H)`. Axis
   `A = normalize(hand − S0)`. Elevation `θ = asin(−A.z)`, the angle below horizontal.
3. **Arm tracing, perpendicular to the arm axis** (this replaces the prototype's horizontal-slice
   tracing so T-poses work):
   - For `t` from `|hand − S0|` down to 0, in steps of `0.005 H`: take the samples within
     `0.006 H` of the plane through `S0 + t·A` with normal A. Project them onto that plane's 2D basis,
     `u = normalize(cross(A, (0, 0, 1)))` (fall back to `(0, 1, 0)` when A is near-vertical), and
     `v = cross(A, u)`. Cluster with `clusters2d(gap)`.
   - Pick the cluster whose 2D centroid is nearest to the previous step's centroid; at the start, the
     one nearest the hand's projection.
   - **Merged into the torso**: stop when the picked cluster's 2D extent exceeds 2.5× the median extent
     of the clusters picked so far, or when it contains points with `|x| < 0.05 H`. The last good step
     is the armpit, `t_sep`.
   - Record the centreline points (cluster centroid back in 3D) and widths (the larger 2D extent).
4. **Arm joints**:
   - `fingertip` = the sample farthest along A (at max `dot(p − S0, A)`) on that side.
   - **Wrist**: among traced points at an axial distance between 0.05 H and 0.15 H from the fingertip,
     the one with the minimum width.
   - **Shoulder**: fit a line through the traced centroids within 0.08 H of `t_sep` (least squares in
     t), then evaluate it at `t_sep − 0.045 H` (beyond the armpit, toward the body), i.e. 0.045 H
     inward from the armpit along −A. For an A-pose this reproduces the prototype's "armpit z +
     0.045 H" closely; keep the test tolerance as the judge.
   - **Elbow**: the point at half the arc length along the centreline polyline from shoulder to wrist.
5. **Spine and head**:
   - `pelvis = ((0, mean y of hips, hip z))`.
   - `chest` = the torso centre at `hip_z + 0.55·(shoulder_z − hip_z)`, using the prototype's
     `torso_centre`: the largest cluster spanning x = 0.
   - **Neck**: the torso centre at `shoulder_z + 0.04 H`.
   - **Head**: the z of minimum horizontal width of the midline cluster in
     `[shoulder_z + 0.06 H, shoulder_z + 0.6·(H − shoulder_z)]`, at that slice's centre.
   - **Head_top**: `(0, head.y, H)`.
6. **Confidence**, the product of:
   - inside: 1.0 if `inside_check` scores ≥ 0.5 (port it), else 0.4
   - symmetry, for sided joints: `1 − min(1, |x_L + x_R| / (0.03 H))·0.5`
   - method: 1.0 normally; 0.5 when the knee width minimum is less than 10 % narrower than the
     widths at both ends of its search range; 0.3 for any fallback

   Round to 2 decimals.
7. **Fallbacks**: the ground-truth A-pose joint table from `docs/briefs/WP2-fixtures.md` scaled by
   `H / 1.80`, centred at the model's xy centre. For T-poses, rotate the arm joints by the measured
   θ about the shoulder.

## Tests (`tests/engine/test_markers.py`)
For fixtures `apose`, `tpose`, `skirt`, `mitten`, and `yup_cm`: run the WP3 import job in-process
(`importer.import_model` + `normalise` with the suggested orientation), then `suggest_body_markers`.

1. Every editable body marker is within **2 % of H** of the truth joint (truth from
   `<name>.truth.json`, scaled the same way the import scaled it, i.e. truth is in metres already).
2. All confidences are ≥ 0.6 on these fixtures.
3. On `tpose`, θ < 10°; on `apose`, 40° < θ < 60°.
4. The job end to end: `engine/jobs/suggest_markers.py` via subprocess writes `markers.json`, which
   validates against the §4 shape.
5. Robustness: on a fixture with the arms deleted (delete the vertices with |x| > 0.25 in the test),
   the function doesn't raise, returns fallbacks with confidence 0.2, and gives warnings.

## Acceptance
`blender … -P tests/engine/run.py -- markers` passes, and the earlier suites still pass. Report the
per-marker error table (cm) for each fixture.
