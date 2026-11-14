# WP6 — Electron main process: Blender manager, job runner, projects, settings, IPC (coder: Opus agent)

Read first: `docs/coding-rules.md`, `docs/contracts.md` (§1, §15, §16, §17, §19), the existing
`electron/main/*.ts`, `electron/preload/index.ts`, `src/shared/ipc.ts`, and the engine job protocol in
`engine/mpm/protocol.py` plus one job, `engine/jobs/import.py`.

Goal: everything the renderer needs to drive the engine. Find or download Blender 5.2, run engine jobs
with live progress and cancel, and create/open/save projects. **Keep logic testable without
Electron**: put pure logic in modules that import only Node built-ins, and keep Electron APIs in
`index.ts` / `ipc.ts`.

## Modules (`electron/main/`)

**`settings.ts`**:
- A JSON settings file at `dataDir()/settings.json`, holding `{ blenderPath?: string }`.
- `loadSettings`, `saveSettings`, with atomic writes (temp file + rename).

**`blender.ts`** (§19):
- `candidatePaths(platform, env, homedir)` returns the ordered candidates, with the user path first.
  The rejection rules are as §19 says: `blender-launcher.exe`, `WindowsApps`, `/snap/`, flatpak.
- `probe(path)` runs `<path> --version` (8 s timeout) and parses the first line
  `Blender (\d+)\.(\d+)\.(\d+)`; valid only if major.minor = 5.2.
- `status()` returns `{found, path, version, source}`.
- **Download**:
  - `parseIndex(html)` picks the highest `5.2.N` with a file for this platform/arch
    (`windows-x64.zip`, `macos-arm64.dmg`, `linux-x64.tar.xz`).
  - `parseSha256(text, filename)`.
  - `download(onProgress, signal)`:
    1. Check free space with `fs.statfs` (2.5 GB).
    2. Stream to `dataDir()/blender/_download/<file>` with progress.
    3. Verify the SHA-256.
    4. Extract into `dataDir()/blender/5.2.N/`:
       - Windows: `tar -xf` (Windows' bsdtar reads zip)
       - macOS: `hdiutil attach -nobrowse -readonly -mountpoint <tmp>`, `ditto <tmp>/Blender.app <dest>/Blender.app`,
         `hdiutil detach`
       - Linux: `tar -xJf`
    5. Locate the binary, `probe` it, save it in settings, and delete the archive.
  - Cancel via `AbortSignal` removes the partial files.
  - macOS x64 gets a clear "Blender 5.2 has no Intel Mac build" error.
- Use Node's global `fetch`; no new npm dependencies.

**`engineDir.ts`**: `engineDir()` returns `<repo>/engine` in dev (from `app.getAppPath()`) and
`process.resourcesPath/engine` when packaged. `resourcesDir()` works the same way.

**`jobs.ts`** (§16):
- `class JobRunner`, with one job at a time and a FIFO queue.
- `run({dir, type, args}) -> jobId`:
  1. Write `<dir>/cache/jobs/<jobId>.json` (`schema mpm.job/1`).
  2. Spawn `<blender> -b --factory-startup --offline-mode --python-exit-code 1 -P <abs engineDir>/jobs/<type>.py -- <abs job.json>`.
  3. Apply `cleanEnv(process.env)`: remove `LD_LIBRARY_PATH`, `APPDIR`, `APPIMAGE`, `PYTHONHOME` and
     `PYTHONPATH` when running from an AppImage.
  4. Parse stdout line by line with `parseLine(line)` → `{kind: 'progress' | 'result' | 'error' | 'log', payload}`.
  5. Write all stdout and stderr to `<dir>/cache/jobs/<jobId>.log`.
- **Exit and failure handling**:
  - Emit events through an injected `emit(evt)`.
  - Exit code 0 without a `@@result` is an error `E_INTERNAL` ("no result").
  - A nonzero exit without `@@error` is `E_INTERNAL` with the last 40 log lines.
  - Default timeout 30 min, giving `E_INTERNAL` "timeout".
- **Cancel**: `cancel(jobId)` uses tree-kill, then SIGKILL after 5 s, then emits `error E_CANCELLED`.
  A queued job is just removed.
- Expose `JobEvent` types in `src/shared/ipc.ts` if they're not already there.

**`projects.ts`** (§15):
- `create({name, parentDir})`: makes `<parentDir>/<Name>/` with `source/`, `rig/`, `weapons/`,
  `exports/`, `cache/`, plus `<Name>.mposer`:
  `{schemaVersion: 1, app: "Mini Pose Master", appVersion, source: null, rig: null, pose: null, hands: null, weapons: [], bake: <defaults per §14>}`.
  The name is sanitised for the file system.
- `open(path)`: accepts a `.mposer` file or a folder containing one; validates `schemaVersion` and
  runs migrations (none yet, but keep a hook).
- `save({dir, project})`: atomic write.
- `importModel({dir, file})`: copies the file into `source/`. If its folder has image files
  (`png jpg jpeg tga tif tiff bmp exr dds`) or a `textures/` subfolder, copies those too, keeping
  relative layout. Updates `project.source = {file: "source/<name>", orientation: null}`.
- `addWeapon({dir, file})`: copies into `weapons/` and returns the relative path.
- Opening a project calls `setProjectRoot(dir)` for `mpm://`.

**`ipc.ts`**: implement `blender.*`, `project.*` and `job.*` (§17). Downloads report
`blender:progress`; jobs report `job:event`. The `library.*` channels stay NOT_IMPLEMENTED.

## Tests (vitest, node; `tests/ts/main/*.test.ts`)

**Pure-logic tests:**
- `candidatePaths` and the rejection rules for win32/darwin/linux (inject env/home).
- The version regex: `Blender 5.2.4` passes; `Blender 4.5.1` and `Blender 5.3.0` fail.
- `parseIndex` on a saved snippet of the real directory index (copy a small portion into
  `tests/ts/main/fixtures/index.html`) picks 5.2.4 per platform.
- `parseSha256`.
- `parseLine` for all four kinds, including ASCII-escaped JSON.
- `cleanEnv`.

**JobRunner with a fake engine:**
- Point it at `node` running `tests/ts/main/fixtures/fake_job.js`, which prints a scripted mix of
  progress, log, result or error lines and exit codes, selected by an env var.
- Check event order, a result, an error, no result → `E_INTERNAL`, timeout, cancel → `E_CANCELLED`
  with the process gone, and queue order.

**Projects:**
- Create/open/save round trip in a temp dir; folder layout.
- `importModel` copies textures; `open` accepts both the file and the folder.

**Integration** (skipped unless env `MPM_BLENDER` points at a Blender 5.2): JobRunner runs the real
`import` job on `fixtures/out/apose/apose.fbx` in a temp project and gets a `result` with
`height_m ≈ 1.815`.

## Acceptance
- `npm run typecheck` and `npm test` pass.
- Run with `MPM_BLENDER="C:/Program Files/Blender Foundation/Blender 5.2/blender.exe"`; the
  integration test passes.
- `npm run build` passes.
- Don't run a real Blender download in tests. Report what you'd need to verify it manually.
