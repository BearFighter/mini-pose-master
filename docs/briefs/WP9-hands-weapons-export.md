# WP9 — Hands, auto-grip, Weapons, two-hand IK, Export step (coder: Opus agent)

Read first: `docs/coding-rules.md`, `docs/contracts.md` §10–§17 (the §13 order was updated: sockets follow
hands → two-hand IK → hand poses last), `src/shared/weaponPose.ts` + `tests/ts/weaponPose.test.ts`,
`src/shared/composePose.ts` (now takes `inputs.weapons` and returns `supportShort`), `handPose.ts`,
`resources/hand_presets.json`, and the engine jobs `convert_weapon` and `bake` (result fields in §16). This
finishes the user flow: after this package a user can go from a bought model to a printable STL.

Rules carried over:
- Fixture-only data and screenshots: use `fixtures/out/sword/sword.glb` and `fixtures/out/rifle/rifle.glb`,
  and their `*.truth.json` grips.
- Don't touch `engine/` or `src/shared` math. Report problems with a failing case.
- No main-process changes beyond E2E hooks. No new npm dependencies.
- Commit nothing.

## 1. One history for the whole pose
Hands and weapons join the pose history. One undo/redo stack (max 100) of snapshots
`{poseInputs, hands, weapons}`, so a weapon move or a finger slider undoes like a bone edit. Project save
writes `pose` (with `deltas` from composePose including weapons and hands), `hands`
(`{L, R, locked: {L: [], R: []}}`, §15) and `weapons` (§12).

## 2. Hands step
- Per side: a preset dropdown (`hand_presets.json`, imported at build time), then sliders for each finger
  (flex ×3, spread; thumb roll), a "keep" checkbox per finger (= `locked`, skipped by auto-grip; presets fill
  it from their `lock`), "Copy hand L→R / R→L", "Reset hand". A side whose rig has `hands[side] = null` shows
  "This rig has no finger bones on this side".
- Slider drags preview live and commit one undo step on release.
- **Auto-grip** (§11), `src/renderer/lib/autoGrip.ts`, pure and unit-tested:
  - Inputs: rig, the composed deltas without this side's hand pose, the starting hand pose (the preset),
    the weapons' triangles in **Blender armature space** (from the loaded GLB + `weaponMatrix`), `tol_m` =
    0.2 mm / `unit_mm` (`unit_mm` from the bake settings: height mode `height_mm / rig.height_m`; heroic mode
    as `engine/mpm/bake.py unit_mm`).
  - Capsules: each finger bone, posed head→tail, radius `radius_m` (fallback `0.09 × hands[side].hand_width`
    when null). Distance = capsule axis to triangle minus radius; use three-mesh-bvh `MeshBVH.shapecast`
    with `ExtendedTriangle.closestPointToSegment`.
  - Per finger, joints proximal → distal in 2° steps up to [95, 110, 85] (thumb [60, 70, 85]); a joint stops
    when the capsule of that bone or any bone distal to it is within `tol_m`; then the next joint. Locked
    fingers untouched. Spread/roll stay from the preset.
  - Returns the new HandPose plus per-finger `{touching, minDistance_m}`. Show "index: touching / not
    touching (max flex)" after running.
  - "Auto-grip" button per side, enabled when a weapon is attached to that side's socket or a support grip
    uses that side.
- Tests: on the fixture rig with the sword placed in the right hand by its truth grip, every unlocked finger
  ends touching or at max flex, no capsule is closer than `−tol_m` (no deep penetration), touching fingers
  are within `tol_m`; locked fingers unchanged; a 2° step more on any stopped joint would bring that capsule
  under `−tol_m` or it is at max (sanity of the stop rule). Time one auto-grip; report it.

## 3. Weapons step
- "Add weapon…": `api.dialog.openFile` (fbx, glb, gltf, obj, stl) → `project.addWeapon` →
  `runJob('convert_weapon', {file: weaponFile})` → entry `{id, file: result.weapon_glb, attach_bone: 'grip.R',
  offset, support: {enabled: false, side: 'L', ...}, merge: true}`. Show the job's warnings; offer "Units:
  metres / centimetres / millimetres" that re-runs the job with `unit_scale`.
- Viewer: load `mpm://project/<weapon_glb>`; its object matrix each frame is `weaponMatrix(rig, deltas, w)`
  converted to three space (`M_t = C⁻¹ · M_b · C` with the 4×4 version of `coords.C`), parented the same way
  as the rig's armature node so it lines up with the skinned mesh.
- Default placement: the weapon's `principal_axis` along the attach frame's +Y (the grip bone points along
  the hand's grip axis), centred on the weapon's bbox centre; then "Set grip point" mode: click the weapon,
  the clicked point (weapon-local) moves to the socket (offset.t = −q·s·p).
- Gizmo: TransformControls translate / rotate on a helper inside an object that carries the attach frame,
  editing `offset.t` / `offset.q` (local space); a scale field (0.25–4) and the weapon's length in mm at print
  scale next to it. Attach to: right hand / left hand. "Print separately" (`merge: false`).
- Two-handed: a toggle (support side = the other hand), "Set support grip": click the weapon → `point` =
  clicked point (weapon-local), `normal` = the opposite of the surface normal there (the palm faces into the
  weapon), `axis` = the weapon's principal axis (a "Flip grip axis" button). Show `supportShort` when > 1 mm:
  "Left hand can't reach by N mm".
- Remove weapon (confirm). Several weapons are allowed (one per hand socket).

## 4. Export step
- Bake settings form (§14): scale mode (standing height in mm / heroic eye height in mm), detail
  (0–4, default 2), sole flatten mm, base mm (0 = none, the default), min wall mm, print weapons separately,
  max triangles. Saved in `project.bake`.
- "Bake STL": `runJob('bake', {name, pose: makePoseState(...), hands, weapons, bake})`, with stage progress
  and Cancel. Before running, save the project.
- Result: the summary text, final size in mm, triangles, thin-wall %, the gates (follow-check numbers, faces,
  voxel coarsening), and the weapon STLs. The preview GLB in the viewer (grey printable, red too thin), with
  a toggle back to the posed rig. "Show in folder" (`shell.showItemInFolder`) for each STL.
- Errors: show the code and message (E_FOLLOW_CHECK and E_BUDGET with their detail numbers).

## 5. E2E (extend `tests/e2e/drive.mjs`)
After the WP8c flow:
1. Add `fixtures/out/sword/sword.glb` as a weapon (convert job), attach to grip.R with the truth main grip
   point, enable two-handed with the truth support point/normal/axis, after moving the right hand in front of
   the body with a reach edit so the support hand can reach (check `supportShort` < 1 mm).
2. Auto-grip the right hand from the "sword" preset; check every finger touching or at max flex.
3. **Parity**: run `dump_skinned` with the final pose state; its `bones[].matrix` for `grip.R` must equal the
   renderer's `attachFrame(…, 'grip.R')` within 1e-5 (translation in metres, rotation entries), and the vertex
   parity stays < 1e-4 m with the hand poses applied.
4. Bake at 40 mm with the sword merged; check the STL in Node (a small binary STL reader: 0 open edges,
   0 edges with more than two faces after merging identical vertices, height ≤ 40.05 mm).
5. Screenshots: hands panel with sliders, weapon with gizmo, two-handed grip close-up, export result with the
   preview.

## Acceptance
- `npm run typecheck`, `npm test`, `node tests/e2e/drive.mjs` pass.
- Report: files, test counts, auto-grip time, the parity numbers, bake time and STL check, screenshot
  paths, deviations, questions.
