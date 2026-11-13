# WP1 — App scaffold (coder: Haiku)

Read first: `docs/coding-rules.md`, `docs/contracts.md` §1, §17, §19 (data dir only), `resources/skeleton.json`.

Goal: a buildable, launchable Electron + React + TypeScript app shell with the project structure,
security settings, the `mpm://` protocol, typed IPC stubs, the skeleton loader, and CI.
**Write every file by hand; don't use interactive create commands (`npm create …`).**

## Files to create

1. `package.json`
   - `"name": "mini-pose-master"`, `"productName": "Mini Pose Master"`, `"version": "0.0.1"`,
     `"license": "GPL-3.0-or-later"`, `"main": "out/main/index.js"`, `"type": "module"` **not set**
     (CommonJS main output is fine).
   - `"author": "BearFighter"`, `"repository": "github:BearFighter/mini-pose-master"`.
   - Dependencies use **exactly** the versions in contracts §1:
     - `dependencies`: electron-updater, react, react-dom, three, @react-three/fiber,
       @react-three/drei, three-mesh-bvh, zustand, zod, tree-kill
     - `devDependencies`: electron, electron-vite, electron-builder, vite, @vitejs/plugin-react,
       typescript, vitest, @types/three, @types/react, @types/react-dom, @types/node,
       license-checker-rseidelsohn
   - Scripts:
     - `"dev": "electron-vite dev"`
     - `"build": "electron-vite build"`
     - `"typecheck": "tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json"`
     - `"test": "vitest run"`
     - `"dist": "electron-vite build && electron-builder --publish never"`
     - `"dist:dir": "electron-vite build && electron-builder --dir --publish never"`
2. `electron.vite.config.ts`
   - Three entries:
     - main: `electron/main/index.ts`
     - preload: `electron/preload/index.ts`
     - renderer: root `src/renderer`, `index.html` in `src/renderer/`
   - Use `@vitejs/plugin-react` for the renderer.
   - Alias `@shared` → `src/shared` in all three.
3. `tsconfig.json` (references), `tsconfig.node.json` (main, preload, shared, tests),
   `tsconfig.web.json` (renderer, shared). Both use `"strict": true` and
   `"resolveJsonModule": true`.
4. `electron/main/index.ts`
   - Single-instance lock (`app.requestSingleInstanceLock`).
     - On `second-instance`: focus the window and, if argv contains a path ending in `.mposer`, send
       `app:open-project {path}` to the renderer.
     - macOS: handle `open-file` the same way.
   - `BrowserWindow`: 1400×900, `webPreferences` exactly:
     `{ contextIsolation: true, sandbox: true, nodeIntegration: false, preload: <built preload path> }`.
   - Before `app.ready`: `protocol.registerSchemesAsPrivileged([{ scheme: 'mpm', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }])`.
   - After ready: `protocol.handle('mpm', …)`, using `resolveMpmUrl` from
     `electron/main/mpmProtocol.ts`.
   - Data dir: `electron/main/paths.ts` exports `dataDir()` following contracts §19 (Windows uses
     `process.env.LOCALAPPDATA`), plus `libraryDir()` = `dataDir()/library`.
   - Updater skeleton in `electron/main/updater.ts`:
     - uses `electron-updater` `autoUpdater` with `autoDownload = process.platform !== 'darwin'`
     - checks only when `app.isPackaged`
     - on Linux, checks only when `process.env.APPIMAGE` is set
     - forwards events as `update:event` (`available`, `downloaded`, `none`, `error`)
     - exports `checkUpdate()` and `installUpdate()`; on darwin, `installUpdate` opens the release page
       URL with `shell.openExternal`
5. `electron/main/mpmProtocol.ts`
   - Exports `resolveMpmUrl(url: string, roots: {project: string|null, library: string}): string|null`.
   - `mpm://project/<encoded rel>` resolves under `roots.project`; `mpm://library/<encoded rel>`
     resolves under `roots.library`.
   - Return null (the caller answers 403) when the root is null or the resolved absolute path isn't
     inside the root (`path.relative` starts with `..` or is absolute).
   - Also export `setProjectRoot(dir|null)` and `getRoots()`. Serve the file with `net.fetch(pathToFileURL(p))`.
6. `electron/main/ipc.ts`
   - Registers `ipcMain.handle` for **every** channel in contracts §17.
   - Implemented now:
     - `app.info` → `{version: app.getVersion(), platform, arch, dataDir}`
     - `dialog.openFile` / `dialog.saveFile` via `dialog.showOpenDialog` / `showSaveDialog`
     - `shell.showItemInFolder`
     - `app.checkUpdate` / `app.installUpdate` via updater.ts
   - Every other channel rejects with `new Error('NOT_IMPLEMENTED: <channel>')`.
   - Channel names on the wire: `'mpm:<area>.<method>'`, for example `'mpm:app.info'`.
7. `electron/preload/index.ts`
   - `contextBridge.exposeInMainWorld('mpm', api)`, where `api` matches the `MpmApi` type exactly.
   - Event subscription: `on(event: MpmEventName, cb) => unsubscribe` for the five events in §17.
8. `src/shared/ipc.ts`
   - The `MpmApi` TypeScript interface for every method in §17, with argument and result types (use
     the shapes in §17; use `unknown` where §17 defers to other sections, for example the project
     JSON).
   - `MpmEventName` and the event payload types.
   - `declare global { interface Window { mpm: MpmApi } }`.
9. `src/shared/skeleton.ts`
   - Loads `resources/skeleton.json` (JSON import) and expands it per its `expand` rule.
   - Exports `JOINTS: {name, editable}[]`,
     `BONES: {name, head, tail, parent: string|null, connected, deform}[]`, `boneIndex(name)`,
     `mirrorName(name)`. `mirrorName` swaps `.L`↔`.R` and `_L`↔`_R` at the end of a name and leaves
     other names unchanged.
10. `src/renderer/index.html`, `src/renderer/main.tsx`, `src/renderer/App.tsx`
    - Layout: left sidebar with step buttons `Import`, `Rig`, `Pose`, `Hands`, `Weapons`, `Export`
      (the selected step is local state for now); main area holds a react-three-fiber `<Canvas>` with
      a grid helper and drei `OrbitControls`; a right panel shows the selected step's name and
      "Coming soon".
    - Bottom status bar showing `window.mpm.app.info()` version and platform.
    - Use plain CSS in `src/renderer/styles.css`, dark theme, with no UI library.
11. `electron-builder.yml`
    - `appId: com.bearfighter.miniposemaster`, `productName: Mini Pose Master`.
    - `directories.output: release`.
    - `files: [out/**]`.
    - `extraResources: [{from: engine, to: engine}, {from: resources, to: resources}]`.
    - `asar: true`.
    - `fileAssociations: [{ext: mposer, name: Mini Pose Master Project, role: Editor}]`.
    - Windows: `win.target: [{target: nsis, arch: [x64]}]`, `nsis: {oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true}`.
    - macOS: `mac.target: [{target: dmg, arch: [arm64]}, {target: zip, arch: [arm64]}]`,
      `mac.category: public.app-category.graphics-design`.
    - Linux: `linux.target: [{target: AppImage, arch: [x64]}]`, `linux.category: Graphics`.
    - `publish: [{provider: github, owner: BearFighter, repo: mini-pose-master, releaseType: draft}]`.
12. `engine/README.md` and `engine/mpm/__init__.py` already exist (the architect created them).
    Don't modify them.
13. `vitest.config.ts`: test files `tests/ts/**/*.test.ts`, environment `node`.
14. Tests:
    - `tests/ts/skeleton.test.ts`:
      - JOINTS.length === 68 and BONES.length === 53
      - every bone's parent appears earlier in BONES
      - the first 5 bones are hips, spine, chest, neck, head
      - `upper_arm.L` comes before `upper_arm.R`
      - `mirrorName('thumb.01.L') === 'thumb.01.R'`, `mirrorName('hip_R') === 'hip_L'`,
        `mirrorName('hips') === 'hips'`
      - every bone's head/tail is a known joint
      - `grip.L.deform === false`
    - `tests/ts/mpmProtocol.test.ts`:
      - a resolve inside the root works
      - `..` traversal (raw and %2e%2e-encoded) returns null
      - a null project root returns null
      - an absolute path in the URL returns null
      - library and project roots resolve independently
15. `.github/workflows/ci.yml`
    - Triggers: push and pull_request.
    - Matrix `windows-latest`, `macos-latest`, `ubuntu-latest`; Node 24.
    - Steps: `npm ci`, `npm run typecheck`, `npm test`, `npm run build`,
      `npx electron-builder --dir --publish never`.
    - Env `CSC_IDENTITY_AUTO_DISCOVERY: false`.
16. `README.md`
    - A short placeholder: name, one-line description, "Work in progress", GPL-3.0, and a link to
      `docs/contracts.md`.

## Acceptance (run all; paste results)
- `npm install` (creates package-lock.json; commit-ready)
- `npm run typecheck`, `npm test`, `npm run build` all succeed
- `npm run dist:dir` produces `release/win-unpacked/Mini Pose Master.exe`
- Launch `npm run dev` for about 10 seconds and confirm in the log that the window loads with no errors,
  then stop it

Do not implement anything beyond this list.
