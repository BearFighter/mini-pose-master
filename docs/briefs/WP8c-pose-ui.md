# WP8c — Pose step: library browser, scrubber, bone edits, mirror, undo, plant feet (coder: Opus agent)

Read first: `docs/coding-rules.md`, `docs/contracts.md` §5, §9, §13, §17, §18, §20; `src/shared/composePose.ts`
(+ `tests/ts/composePose.test.ts`), `retarget.ts`, `ik.ts`, `mirror.ts`, `clip.ts`, `fk.ts`, `coords.ts`,
`poseMath.ts`, `skinSample.ts`; your own WP8b renderer; `electron/main/library.ts` (main side of the library,
already done) and `src/shared/ipc.ts` (`library.*`).

**Rules carried over:** no third-party data anywhere in the repo, the tests or the screenshots. E2E uses a
synthetic BVH (port the writer from `tests/ts/main/libraryHelpers.ts`) imported with `library.importClip`.
Screenshots show only the procedural fixture character. Don't touch `engine/`, `electron/main/` beyond
small MPM_E2E hooks, or the `src/shared` math (composePose included). If you think one of them is wrong,
report it with a failing case.

## 1. Pose state in the store
- Replace the pose slice's stored `deltas` with the **inputs**:
  - `source: {pack, clip, frame} | null`
  - `mirrored`
  - `planted` (default true)
  - `edits: EditOp[]`
- `deltas` becomes derived: `composePose(rig, inputs, frame)`, memoised on (rig hash, inputs, loaded
  clip frame). Hands come from the hands slice; that's empty until WP9.
- Undo/redo stacks hold input snapshots (max 100). Shortcuts: Ctrl+Z, Ctrl+Shift+Z and Ctrl+Y, active
  only when focus is not in a text field. One committed action is one undo step:
  - a frame chosen (on scrub release)
  - a gizmo drag (on release)
  - mirror toggle
  - plant toggle
  - reset bone
  - clear edits
- Save: `project.pose = makePoseState(rig, deltas, [0,0,0], provenance)`, where provenance =
  `{pack, clip, frame, mirrored, planted, edits}`. Load restores the inputs from the provenance.
- **If `rig_hash` differs**, re-run composePose:
  - Clip installed: say "Pose re-applied to the rebuilt rig".
  - Clip missing: rest + edits, and say which pack to install.

## 2. Library panel (left side of the Pose step)
- Packs from `library.list()`.
  - **Not installed**: "Install…" opens a license dialog showing the title, license name and link,
    the attribution, and exactly: *"Non-commercial licenses: don't sell prints made with these poses."*
    The NC text shows only when `nc`. Then a checkbox "I accept the license" and Install.
  - **Downloadable packs**: `library.install({packId, acceptLicense: true})`.
  - **`user_supplied` packs**: the instructions plus "Choose file(s)…" (multi-select), then
    `installFromFile`.
  - Progress from `library:progress` with Cancel; errors in the error banner.
  - **Installed packs**: Remove, with a confirm. "Update" when `stale`.
- "Import my own BVH…" runs `library.importClip` into pack `mine`.
- Clip list for the selected pack:
  - `fetch('mpm://library/packs/<id>/index.json')`
  - a search box over id, move, style and tags, and tag chips
  - rows show a thumbnail, the move/style and the frame count
  - virtualise the list when it's over 200 rows; CMU can have thousands
- Loading a clip: fetch `mpm://library/packs/<pack>/clips/<id>.f32`, then
  `parseClipF32(buf, clip.joints ?? index.joints)`. Cache the last 8 clips.
- **Thumbnails**:
  - Draw a stick figure of the clip's first key frame (or frame 0) with one shared offscreen
    `WebGLRenderer` (128×128, 3/4 front view, the fixed bone list from the clip joints).
  - Save it via `library.saveThumb` as `<clip>_<frame>.png`.
  - Generate lazily, one at a time, only for rows in view, and only when no
    `mpm://library/packs/<id>/thumbs/<clip>_<frame>.png` exists (try loading it first).

## 3. Scrubber (under the viewer, when a clip is selected)
- Slider over frames 0..F−1 (15 fps), with key-frame ticks.
- Buttons: previous/next key frame, step ±1, play/pause (loops; it previews only and commits nothing
  until paused).
- Arrow keys step; Shift+arrow jumps to the next key frame.
- While dragging, the viewer previews the frame live. Release commits `source.frame`: one undo step,
  edits kept.
- Show the current frame, the contacts (L/R foot icons) and a "Plant feet" toggle.
- Target: retarget + compose of one frame under 5 ms on the fixture rig. Measure it in a vitest and
  report the number.

## 4. Viewer for the Pose step
- `RigModel` takes the derived deltas (not the test pose). Keep `applyPoseState`.
- **Ground display**: shift the displayed model so its lowest posed point sits on the grid.
  - Compute it from the skinned mesh bounds after posing (`SkinnedMesh.computeBoundingBox()` uses the
    bones).
  - This is display-only; the bake does the same.
- **Bone picking**:
  - Click the mesh: a raycast on the skinned mesh (three's skinned raycast is fine on click). Take the
    bone with the largest weight on the hit face's vertices, mapped to its canonical name.
  - Also clickable joint dots on the skeleton overlay, and a bone tree list in the right panel
    (canonical bones only).
  - Show the selection highlighted in the list and as a coloured bone line.
- **Rotation gizmo**: drei `TransformControls` in rotate mode, local space, on a helper Object3D under
  the armature node. The helper sits at the selected bone's posed head and is oriented as
  `D_b · R_rest_b`, converted with `coords.ts`.
  - On drag: `q_three = q_now · q_start⁻¹`, `q = quatT2B(q_three)`, previewed as an extra
    `{kind:'rotate', bone, q, chain}` op.
  - On release: commit it. Merge it with the previous op when that was the same bone and mode within
    the same gesture.
  - Default `chain: true`. Hold Alt, or use the "Rotate bone only" toggle, for `chain: false`.
- **Hand reach**: with a hand bone selected, a "Move hand" mode shows a translate gizmo at the wrist
  and commits `{kind:'reach', side, target}`. Show `reachShort` when it's over 1 mm ("can't reach by
  N mm").
- Right-panel buttons:
  - "Reset bone": removes that bone's ops.
  - "Clear edits".
  - "Mirror pose": `toggleMirror`.
  - "Copy pose L→R" / "R→L": for each canonical bone on the source side, append a rotate op to its
    mirror partner so its delta becomes the mirrored source delta. Compute `q = D_target_wanted ·
    D_target_now⁻¹` per bone, with `chain: false`, parents first.

## 5. Tests and verification
- vitest:
  - the pose slice (input snapshots, undo/redo limits, the merge rule)
  - save/load round trip of the provenance
  - the rig-hash change paths
  - gizmo delta maths (three ↔ Blender) against `composePose` on the fixture rig: a 30° drag about a
    known axis gives the expected posed joint positions within 1e-5 m
  - copy L→R gives `mirrorPose` on that side
  - the thumbnail queue logic (fake renderer)
  - the clip-list filter
- **E2E** (extend `tests/e2e/drive.mjs`):
  1. Build the rig as in WP8b.
  2. Write a synthetic BVH (a bandai-style hierarchy that waves an arm over 60 frames) into the temp
     folder and import it with `importClip`.
  3. Select it, scrub to frame 40, rotate `spine` 20° via a test hook, toggle mirror, undo once,
     save, reload the project, and check the pose is restored (same provenance and deltas within 1e-6).
  4. **App ↔ Blender parity, the key acceptance check**:
     - The test hook returns the renderer's posed positions for 500 sampled vertices, by
       `_ORIG_INDEX`. Use `skinSample.ts`, or read them back from the skinned mesh with bone
       transforms.
     - Run the `dump_skinned` job with the same pose state.
     - The max difference must be under 1e-4 m.
  5. Screenshots: library panel with the synthetic clip, scrubber, the posed rig with gizmo, and the
     mirrored pose.
- `npm run typecheck`, `npm test` and `node tests/e2e/drive.mjs` pass. No new npm dependencies, except
  a list virtualiser only if it's under 10 kB and pinned (ask me first).
- Report: files, test counts, the per-frame timing, the parity number, screenshot paths, deviations
  and questions.
