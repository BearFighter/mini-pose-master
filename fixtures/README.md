# Fixtures

Original, procedural test characters and weapons with exact ground truth. Nothing here is third-party
content. Every later work package measures itself against these files.

Generate (headless, ~12 s for everything):

```
"C:/Program Files/Blender Foundation/Blender 5.2/blender.exe" -b --factory-startup --python-exit-code 1 \
    -P fixtures/generate.py -- --out fixtures/out [--only apose,dense]
```

Output goes to `fixtures/out/<name>/` (git-ignored). Each fixture holds its model file(s),
`<name>.truth.json` and, for every humanoid except `dense`, `<name>_n.png` (normal map, **DirectX**
convention), `<name>_d.png` (flat 0.6 grey) and `<name>_height.npy` (the 1024x1024 float32 height field).

Tests: `blender -b --factory-startup --python-exit-code 1 -P tests/engine/run.py -- fixtures`
(generates missing fixtures first; `MPM_FIXTURES` overrides the folder).

## Fixtures

| name | purpose |
|---|---|
| `apose` | Reference character, arm angle 50 degrees. FBX, GLB and OBJ (+MTL, Z up, -Y forward). Used for marker detection, rigging, skinning parity, bake. |
| `tpose` | Same figure, arms at 0 degrees. Palm normal points -Z. Used for retarget rest poses and T-pose detection. |
| `yup_cm` | `apose` exported as FBX with Y up, -Z forward, `global_scale=100`. Tests orientation and unit detection. Note: Blender's importer converts the axes but keeps the 100x node scale, so a default import is 180 units tall, not 1.80 (the truth stores `export.unit_scale = 0.01`). |
| `mitten` | Four fingers fused into one paddle (wrist, middle_0, middle_tip); thumb normal. Tests finger-radius estimation and auto-grip on non-separable fingers. |
| `curled` | Fingers `_0`, `_1`, `_2` flexed 60 degrees toward the palm. The truth stores the actual curled joints (so `_1`/`_2` do not follow the straight-finger derivation rule). |
| `skirt` | `apose` plus an open cone sheet and a back flap (separate objects, zero thickness). Tests voxel-remesh / thin-geometry handling and non-manifold input. |
| `dense` | `apose` subdivided to about 1.05 M triangles, no texture. Tests budgets and performance. |
| `rigged_mixamo` | T-pose mesh with a Mixamo-named armature (`mixamorig:` prefix, armature object scale 0.01 + rotation X 90, cm FBX). |
| `rigged_ue` | A-pose mesh with an Unreal 5 mannequin-style armature (twist and IK bones, metacarpals, cm FBX). |
| `rigged_biped` | T-pose mesh with a 3ds Max Biped-named armature (metres). |
| `sword` | Blade 0.80 m, grip origin, grip axis +Z, blade toward +Z. GLB and FBX. |
| `rifle` | Barrel along +Y, origin at the pistol-grip centre. GLB and FBX. The truth gives main and support grip point, axis and palm normal (weapon-local). |

## Anatomy

Humanoids are built from Blender Skin-modifier parts (Subsurf level 1) unioned with an Exact boolean into one
closed mesh. Extra non-joint skin vertices shape the body: `upper_chest`, `neck_mid`, `cranium`,
`mid_thigh`, `mid_calf` (30 % knee to ankle, r 0.060), `upper_arm_mid`, `forearm_mid`. The neck is the
narrowest part between shoulders and head top, the knee is a local minimum of leg width (at least 3 mm
narrower than slices 5 cm above and below), and the crotch sits at about z = 0.87. Each hand has a
bevelled palm block (oriented by the hand frame) and every finger and the thumb starts at an anchor 0.008 m
behind its first joint, inside the palm. `mitten` keeps the palm and replaces the four fingers with one
flattened bevelled box paddle from middle_0 to middle_tip. Chain ends extend 0.3 x radius past the end
joint so end joints are inside the mesh.

## Truth file

`mpm.fixture/1` JSON. Humanoids: `joints` (all 68 skeleton joints, metres, Blender frame, original
orientation even for `yup_cm`), `hands`, `editable`, `export`, `mesh_bbox_m` (min/max of the final mesh), `crotch_z` (first hit of an upward ray at x=0, y=mean hip y), `arm_angle_deg`, `normal_convention`, and for rigged
fixtures `mapping` (fixture bone name -> canonical bone name or null). Weapons: `grips`.

## Normal map convention

`H` is the saved height field (row 0 = image top, v points up). With `k = 2`:
`du = gradient(H, axis=1)`, `dv = -gradient(H, axis=0)`, `n = normalize(-k*du, -k*dv, 1)`, then green is
flipped (DirectX), and the PNG stores `round((n*0.5+0.5)*255)`.

## Rigged fixtures: weights and mapping

Weights: per vertex, the 2 nearest bone segments among the bones that have a canonical mapping,
weights proportional to 1/d^4, normalised. Twist, IK, metacarpal, end, root and extra spine bones are
unweighted. Mapping rule for extra spine bones: the first spine bone maps to `spine`, the last to
`chest`, the ones between map to null.
