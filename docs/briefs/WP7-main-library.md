# WP7-main — Pose library in the main process: pack index, downloads, license, conversion (coder: Opus agent)

Read first: `docs/coding-rules.md`, `docs/contracts.md` §9, §16, §17, §19, §20, and your own WP6 code
(`electron/main/{jobs,settings,paths,fsutil,ipc,blender,index}.ts`, `src/shared/ipc.ts`). The engine
side exists: `engine/jobs/convert_clip.py` accepts `files[]` and/or `archives[]` + `extract_dir`
(+ `include[]`), `pack_dir`, `pack` and returns `{clips, failed}`.

**Hard rule:** no third-party data in the repo or the installer: no BVH, no converted clips, no zips,
not even as test fixtures. Tests use the synthetic BVH writer pattern from `tests/engine/test_convert.py`
(port the idea to TS, or write the tiny BVH text inline) and a local `node:http` server.

## 1. `resources/packs.json` (§20)
- `bandai1`, Bandai Namco Research Motion Dataset 1:
  - license CC BY-NC 4.0 (`https://creativecommons.org/licenses/by-nc/4.0/`), `nc: true`,
    `exportable: true`, source `bandai`
  - attribution "Bandai Namco Research Inc. — Bandai-Namco-Research-Motiondataset (dataset 1)"
  - homepage `https://github.com/BandaiNamcoResearchInc/Bandai-Namco-Research-Motiondataset`
  - one entry per BVH file, URL pinned to commit `74ead3ba1ae4696404e6086233779f60de8bf9ef`:
    `https://raw.githubusercontent.com/BandaiNamcoResearchInc/Bandai-Namco-Research-Motiondataset/<sha>/dataset/Bandai-Namco-Research-Motiondataset-1/data/<name>`
- Generate these entries with a script `scripts/make-pack-index.mjs` (Node, no deps):
  `node scripts/make-pack-index.mjs --pack bandai1 --dir <folder> --url-prefix <prefix>` prints the
  `files` array with name, url, sha256 and size. Run it against the local copy at
  `C:/Claude Code/Claude Code/Warframe STL/poses/bandai-namco/dataset/Bandai-Namco-Research-Motiondataset-1/data`
  (175 files). **Read-only**: hash the files there and never copy, move or commit anything from that
  folder. Only the generated hashes, names and URLs go into packs.json.
- `lafan1`, Ubisoft La Forge Animation Dataset:
  - CC BY-NC-ND 4.0, `nc: true`, `exportable: false`, source `lafan1`
  - homepage `https://github.com/ubisoft/ubisoft-laforge-animation-dataset`
  - `download: {user_supplied: true, accepts: [".zip"], instructions: "Download lafan1.zip from the
    LaFAN1 page (lafan1 folder) and choose it here."}`
- `cmu`, CMU Graphics Lab Motion Capture Database (BVH conversion):
  - license "CMU Graphics Lab Motion Capture Database terms", url `http://mocap.cs.cmu.edu/faqs.php`,
    `nc: false`, `exportable: true`, source `cmu`
  - `user_supplied` accepting `.zip` or a folder; `include: null` for now
- Top level: `"converter_version": 1` (must equal `CONVERTER_VERSION` in `engine/mpm/convert/clipio.py`;
  add a vitest that reads both files and compares).
- Ship packs.json in `extraResources`. Validate it with zod at load.

## 2. `electron/main/library.ts` + IPC (§17)
Root: `libraryDir()`. Layout per §20: `raw/<pack>/`, `packs/<pack>/`, `packs/<pack>.installing/`.

- `list()`: every packs.json entry plus `installed` (packs/<id>/index.json exists), `clips` count,
  `licenseAccepted`, `busy`, and `stale` (index `converter_version` older than packs.json's). Include
  pack `mine` when it exists.
- `install({packId, acceptLicense})`:
  1. Refuse unless `acceptLicense === true`. Record `{license, acceptedAt}` under `settings.licenses[packId]`.
  2. Refuse a `user_supplied` pack with E_ARGS ("choose the downloaded file"). Refuse if this pack is
     already busy.
  3. Check free disk space (`fs.statfs`) ≥ 3 × the total size, else E_IO with the numbers.
  4. Download into `raw/<pack>/`:
     - Skip files already there with the right sha256.
     - Write `name.part`, verify size and sha256, then rename.
     - Mismatch: delete the file; after 3 tries, E_IO naming the file.
     - 4 files in parallel, a 60 s timeout per file, retries with backoff.
     - Use Electron `net.fetch` in the app. Make the fetch function injectable so vitest can use
       Node's `fetch` against a local `node:http` server.
     - Only `https://` URLs from packs.json; refuse redirects to anything but https.
  5. Convert: queue `convert_clip` jobs on the existing JobRunner in batches of 25 files. Use
     `project_dir` = the library dir, `pack_dir` = `packs/<pack>.installing`, and
     `pack = {pack, title, license, license_url, exportable, converter_version}`. Batches leave room
     for user jobs in the FIFO queue.
  6. When every batch is done, replace `packs/<pack>` with the `.installing` folder (rename; remove
     the old one first). Return `{clips, failed}` (failed = all batches' `failed`).
  7. Progress: `library:progress {packId, stage: "download"|"convert"|"done", fraction}`.
- `installFromFile({packId, file, acceptLicense})`: same license step.
  - `.zip`: convert_clip with `archives: [file]`, `extract_dir: raw/<pack>`, `include` from packs.json.
    Run it as one job: extraction can't be batched.
  - Folder: every `*.bvh` below it (cap 20,000), batched as above.
  - Single `.bvh`: one job.
- `importClip({file, source})`: converts one BVH into pack `mine`. The `mine` pack has no packs.json
  entry: license "Your own", `nc: false`, `exportable: true`. Returns `{packId: "mine", clipIds}`.
- `cancel(packId)`: abort downloads and cancel this pack's queued and running jobs. Remove
  `.installing`, keep `raw/`.
- `remove(packId)`: delete `packs/<id>` and `raw/<id>`. Refuse while busy.
- `saveThumb({packId, clipId, frame, png})`:
  - ids match `^[\w.-]+$`, frame is an integer ≥ 0
  - png starts with the PNG signature and is ≤ 512 KB
  - write `packs/<pack>/thumbs/<clip>_<frame>.png` atomically
- Register the channels in `ipc.ts` (`mpm:library.*`), types in `src/shared/ipc.ts`, preload wrappers.
  Validate every argument with zod.

## 3. `project.addWeapon` sidecars
A weapon FBX or OBJ also needs its textures. Reuse your `planImport`:
- Copy the weapon and its sidecars into `weapons/<stem>/`, using a free stem if the folder exists.
- Return `{weaponFile: "weapons/<stem>/<file>", copied, skipped}`.
- Update §17's line for it.

## Tests and acceptance
- vitest, with a fake JobRunner where useful:
  - packs.json schema, and `converter_version` parity with clipio.py
  - the download flow against a local http server: good file, wrong hash (retries then E_IO),
    resume (existing good file is not re-fetched), a redirect to http refused, cancel mid-download
  - the license gate
  - disk-space refusal (inject statfs)
  - the `.installing` swap
  - thumb validation
  - addWeapon sidecars
- With `MPM_BLENDER` set (like your integration test): install a pack from a local http server
  serving 3 synthetic BVH files (with a packs.json override pointing at it, test-only). Check the pack
  installs with 3 clips and `list()` shows it installed.
- `npm run typecheck`, `npm test` and `npm run build` pass. No new npm dependencies.
- Don't touch `engine/` (report anything the engine should change), `src/renderer/` (WP8b is
  running there) or `src/shared` math files.
- Report: files, test counts, deviations, questions.
