# WP8b — Renderer UI: shell, Blender setup, projects, Import step, Rig step, viewer (coder: Opus agent)

Read first: `docs/coding-rules.md`, `docs/contracts.md` (§2–§5, §8, §15–§18), `src/shared/*.ts` (all of
them: `ipc.ts`, `rig.ts`, `poseMath.ts`, `derive.ts`, `skeleton.ts`, `coords.ts`), `electron/main/ipc.ts`,
`electron/preload/index.ts`, and the current `src/renderer/` scaffold. Engine jobs you'll call:
- `import`: result includes `preview_glb`
- `suggest_markers`, `suggest_mapping`
- `rig`: with `markers`, or `mapping` (`{}` = suggested)

Output files: `rig/rig.glb`, `rig/rig.json`, `rig/preview.glb`, `rig/markers.json`.

Goal: the first half of the user flow, working end to end in the real Electron app. The user can:
- set up Blender
- create or open a project
- import a model and fix its orientation
- either auto-rig it (review and drag markers) or map an existing skeleton
- build the rig and see the skinned model in rest pose and in a quick test pose

The steps Pose, Hands, Weapons and Export stay placeholders. A later package builds them.

## Architecture (renderer, `src/renderer/`)
- **`api.ts`** is the only module touching `window.mpm`, as typed wrappers. It also has
  `runJob(type, args, onProgress) -> Promise<result>`, which resolves or rejects from `job:event` for
  that jobId; rejections carry the error code and message.
- **`store/`** holds zustand slices per §18: app, project, rig, ui, jobs. Pose, hands, weapons and
  bake slices exist with their types but no UI yet. Keep the project JSON (§15) as the single
  serialisable state, save through `project.save`, and keep a dirty flag.
- **`viewer/`**: an R3F `<Canvas>` with OrbitControls, grid, lights, and frame-to-fit on load.
  Components:
  - `PreviewModel`: loads `mpm://project/rig/preview.glb`.
  - `RigModel`: loads `rig.glb` and uses `bindRig` + `applyPoseState`.
  - `Markers`: draggable spheres.
  - `SkeletonLines`: the derived joints from `derive.ts`, drawn as bone lines.
- Load files through the `mpm://` protocol only. Add a cache-busting query (`?v=<mtime or counter>`)
  after a job rewrites a file.

## Screens and behaviour

1. **Blender setup**: shown on start if `blender.status()` reports not found.
   - Explains that Mini Pose Master uses Blender 5.2 (free, GPL) behind the scenes.
   - "Locate Blender…" opens a file dialog and calls `setPath`; show the rejection reason inline.
   - "Download Blender 5.2 (~400 MB download, ~1.2 GB installed)" calls `download()` with a progress
     bar and Cancel.
   - Not dismissible until Blender is found; a Settings entry reopens it later.
2. **Projects**:
   - New (name + parent folder picker) and Open (`.mposer` or folder).
   - Recent projects, up to 8, in localStorage wrapped in try/catch.
   - Title bar shows the project name and a dirty marker.
   - Ctrl+S saves. Closing with unsaved changes asks for confirmation.
   - Handle the `app:open-project` event.
3. **Import step**:
   - "Choose model…" with filters fbx, glb, gltf, obj, stl, ply. Then `project.importModel`, then
     `runJob('import', {file})`.
   - Show progress, then the summary: objects, triangles, height, materials and normal maps,
     "has skeleton: yes/no", and warnings.
   - Orientation panel: up / forward / unit-scale selects (from the `suggested_orientation` options).
     "Apply" re-runs import with `orientation`.
   - The preview model shows in the viewer, standing on the grid.
4. **Rig step**, two paths. Offer the "Use the model's skeleton" path only when the model has one.
   - **Auto-rig**:
     - "Find joints" runs `suggest_markers`.
     - Markers show as spheres coloured by confidence: green ≥ 0.8, amber 0.5–0.8, red < 0.5.
       Tooltip shows the name and confidence.
     - Click to select, drag in screen space at constant camera depth. A "Mirror edits" toggle moves
       the L/R partner, mirrored in x.
     - Skeleton lines update live from `deriveJoints` (finger joints included).
     - A marker list on the right, with low-confidence markers first. Clicking one focuses the camera
       on it.
     - Fingertip and knuckle markers are small. "Zoom to hand L/R" helps place them.
     - "Reset to suggestion".
     - Edited markers are saved to `rig/markers.json`, through the project save flow or a small
       helper; don't add a new IPC channel. Store them in the project JSON under `rigDraft.markers`
       and send them in the `rig` job args.
   - **Use the model's skeleton**:
     - `suggest_mapping` shows the convention and confidence.
     - A table of canonical bones, each with a dropdown of model bones (or "none"). Unmapped canonical
       bones are highlighted.
     - "Build rig" runs `runJob('rig', {mapping})`.
   - **After the rig job**:
     - Load `rig.glb` + `rig.json` and bind.
     - Show the skinned model at rest. A "Test pose" toggle applies a fixed pose (both arms raised
       45°, one knee bent) via `applyPoseState`, so the user can see the mesh follow.
     - Show the follow stats from the job result.
     - Update `project.rig = {kind, hash}`.
5. **Status bar**:
   - Blender status and version, plus the job progress and stage message.
   - An expandable log tail (the last 500 lines from `job:event` log).
   - Cancel for the running job.
   - Errors appear as a dismissible banner with the code and message.

Style: plain CSS, dark theme, as in the scaffold. No UI library. Keep components small and typed.
`npm run typecheck` must stay clean.

## Tests and verification
- **vitest** for pure logic: the `runJob` event plumbing (with a fake `window.mpm`), store reducers
  and actions, marker mirroring, the confidence colour mapping, and that a project save/load round
  trip keeps `rigDraft`.
- **End to end in the real app, through the Chrome DevTools Protocol.** Add no dependencies; Node 24
  has global `fetch` and `WebSocket`. Write `tests/e2e/drive.mjs`:
  1. It launches the built app (`npm run build`, then `npx electron . --remote-debugging-port=9333`
     with env `MPM_E2E=1`).
  2. It connects to the page target and runs scripted steps via `Runtime.evaluate`:
     1. create a project in a temp folder
     2. import `fixtures/out/apose/apose.fbx`
     3. run `suggest_markers`
     4. run `rig`
     5. assert the rig loaded
  3. It saves screenshots with `Page.captureScreenshot` to `tests/e2e/out/*.png`: after import, with
     markers, and rigged in the test pose.
- **`MPM_E2E=1` hooks**:
  - Expose a small test hook on `window.__mpmTest` for driving the store: `newProject(dir)`,
    `importModel(path)`, `findJoints()`, `buildRig()`, `state()`.
  - Make the main process accept a `--user-data-dir` override, so the run uses a temp settings and
    data dir, but still finds the installed Blender. Pass the Blender path through env
    `MPM_BLENDER`, honoured only when `MPM_E2E=1`.
- **Screenshots** must only ever show the original procedural fixture character from `fixtures/out`.
- Report the screenshot paths in your final message.

## Acceptance
- `npm run typecheck` and `npm test` pass.
- `node tests/e2e/drive.mjs` passes on Windows, with Blender at
  `C:/Program Files/Blender Foundation/Blender 5.2/blender.exe`, and produces the 3 screenshots.
- No new npm dependencies.
- Don't touch `engine/`, `electron/main/{blender,jobs,projects,settings}.ts` beyond the small
  `MPM_E2E` hooks, or `src/shared/*` math files (you may add new `src/shared` files for shared types).
