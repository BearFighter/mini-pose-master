// SPDX-License-Identifier: GPL-3.0-or-later
// End-to-end run of the real app through the Chrome DevTools Protocol (no dependencies: Node 24
// has fetch and WebSocket). Builds the app, launches Electron with MPM_E2E=1, a temp user-data
// folder and the installed Blender, then: new project -> import fixtures/out/apose/apose.fbx ->
// find joints -> build rig -> test pose -> import a synthetic BVH clip -> scrub, rotate, mirror,
// undo -> save and reopen -> renderer vs Blender (dump_skinned) parity -> sword with a two-handed
// grip -> auto-grip -> attach-frame and vertex parity -> bake at 40 mm and an STL check.
// Screenshots go to tests/e2e/out/*.png.
//
//   node tests/e2e/drive.mjs [--no-build] [--keep]
//
// Env: MPM_BLENDER (default: the standard Blender 5.2 install path), MPM_E2E_PORT (default 9333).
import { spawn, spawnSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const OUT = path.join(REPO, 'tests', 'e2e', 'out')
const PORT = Number(process.env.MPM_E2E_PORT || 9333)
const FIXTURE = path.join(REPO, 'fixtures', 'out', 'apose', 'apose.fbx')
const SWORD = path.join(REPO, 'fixtures', 'out', 'sword', 'sword.glb')
const DEFAULT_BLENDER = {
  win32: 'C:/Program Files/Blender Foundation/Blender 5.2/blender.exe',
  darwin: '/Applications/Blender.app/Contents/MacOS/Blender',
  linux: 'blender'
}
const BLENDER = process.env.MPM_BLENDER || DEFAULT_BLENDER[process.platform] || 'blender'
const args = new Set(process.argv.slice(2))

const JOB_TIMEOUT_MS = 10 * 60 * 1000
/** The whole run, build excluded. */
const RUN_TIMEOUT_MS = 60 * 60 * 1000
const SCREENSHOT_TIMEOUT_MS = 15_000
const SCREENSHOT_ATTEMPTS = 4
/** Makes the page draw a new frame (the R3F canvas redraws on resize), then waits two frames. */
const REPAINT =
  "window.dispatchEvent(new Event('resize')), new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))"
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function withTimeout(promise, ms, what) {
  let timer
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timeout after ${ms} ms: ${what}`)), ms)
    })
  ])
}
const log = (...a) => console.log('[e2e]', ...a)

function assert(cond, message) {
  if (!cond) throw new Error(`assertion failed: ${message}`)
}

// ---------------------------------------------------------------------------------------------------
// CDP client

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.nextId = 1
    this.pending = new Map()
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'))
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`))
        else resolve(msg.result)
      } else if (msg.method === 'Runtime.consoleAPICalled') {
        const text = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ')
        if (msg.params.type === 'error' || msg.params.type === 'warning') log(`page ${msg.params.type}:`, text)
      } else if (msg.method === 'Runtime.exceptionThrown') {
        log('page exception:', msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text)
      }
    })
    ws.addEventListener('close', () => {
      for (const { reject } of this.pending.values()) reject(new Error('CDP connection closed'))
      this.pending.clear()
    })
  }

  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url)
      ws.addEventListener('open', () => resolve(new Cdp(ws)), { once: true })
      ws.addEventListener('error', () => reject(new Error(`cannot connect to ${url}`)), { once: true })
    })
  }

  send(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  /** Evaluates an expression in the page (promises awaited) and returns its JSON value. */
  async evaluate(expression, timeoutMs = JOB_TIMEOUT_MS) {
    const call = this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    const res = await withTimeout(call, timeoutMs, expression)
    if (res.exceptionDetails) {
      const d = res.exceptionDetails
      throw new Error(`page: ${d.exception?.description ?? d.exception?.value ?? d.text}`)
    }
    return res.result.value
  }

  async waitFor(expression, what, timeoutMs = 60_000) {
    const end = Date.now() + timeoutMs
    for (;;) {
      try {
        if (await this.evaluate(expression, 10_000)) return
      } catch {
        // page not ready yet
      }
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
      await sleep(250)
    }
  }

  /**
   * Page.captureScreenshot waits for a compositor frame, which a window covered by other windows
   * may not produce right away; force a repaint first, and retry with a timeout.
   */
  async screenshot(name) {
    const file = path.join(OUT, name)
    for (let attempt = 1; attempt <= SCREENSHOT_ATTEMPTS; attempt++) {
      await this.evaluate(REPAINT, 10_000).catch(() => {})
      try {
        const { data } = await withTimeout(this.send('Page.captureScreenshot', { format: 'png' }), SCREENSHOT_TIMEOUT_MS, `screenshot ${name}`)
        writeFileSync(file, Buffer.from(data, 'base64'))
        log('screenshot', path.relative(REPO, file))
        return file
      } catch (e) {
        log(`screenshot ${name}: attempt ${attempt} failed (${e instanceof Error ? e.message : e})`)
      }
    }
    throw new Error(`could not capture ${name}`)
  }

  close() {
    try {
      this.ws.close()
    } catch {
      // already closed
    }
  }
}

// ---------------------------------------------------------------------------------------------------
// App process

function build() {
  log('npm run build')
  // One command string: npm is a .cmd script on Windows and needs the shell.
  const res = spawnSync('npm run build', { cwd: REPO, stdio: 'inherit', shell: true })
  if (res.status !== 0) throw new Error(`npm run build failed (exit ${res.status})`)
}

function launch(userDataDir, logFile) {
  const electron = createRequire(import.meta.url)('electron')
  const env = { ...process.env, MPM_E2E: '1', MPM_BLENDER: BLENDER }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  const child = spawn(electron, ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDataDir}`], {
    cwd: REPO,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false
  })
  const out = createWriteStream(logFile)
  child.stdout.pipe(out)
  child.stderr.pipe(out)
  return child
}

async function pageTarget(timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const targets = await res.json()
      const page = targets.find((t) => t.type === 'page' && /index\.html/.test(t.url))
      if (page) return page
    } catch {
      // not listening yet
    }
    if (Date.now() > end) throw new Error(`no page target on port ${PORT}`)
    await sleep(300)
  }
}

function waitExit(child, ms) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

function killTree(child) {
  if (child.exitCode !== null || child.pid === undefined) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  else child.kill('SIGKILL')
}

// ---------------------------------------------------------------------------------------------------
// Pose step helpers

/** Waits until the viewer has shown a new pose (viewer.poseSeq increased), then a little more. */
async function waitPose(cdp) {
  const before = await cdp.evaluate('window.__mpmTest.state().viewer.poseSeq')
  await cdp
    .waitFor(`window.__mpmTest.state().viewer.poseSeq > ${before} && window.__mpmTest.state().viewer.pose === 'pose'`, 'the posed rig', 10_000)
    .catch(() => {}) // the pose may already have been shown before `before` was read
  await sleep(500)
}

async function waitUntil(check, what, timeoutMs) {
  const end = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(250)
  }
}

// Synthetic BVH: the Bandai-style skeleton of tests/ts/main/libraryHelpers.ts (original, no
// third-party data), 60 frames at 15 fps: the left arm rises over 10 frames, then waves.
const BVH_SKEL = [
  ['Hips', null, [0, 0, 0]],
  ['Spine', 'Hips', [0, 10, 0]],
  ['Chest', 'Spine', [0, 25, 0]],
  ['Neck', 'Chest', [0, 20, 0]],
  ['Head', 'Neck', [0, 8, 0]],
  ['Shoulder_L', 'Chest', [5, 18, 0]],
  ['UpperArm_L', 'Shoulder_L', [12, 0, 0]],
  ['LowerArm_L', 'UpperArm_L', [28, 0, 0]],
  ['Hand_L', 'LowerArm_L', [25, 0, 0]],
  ['Shoulder_R', 'Chest', [-5, 18, 0]],
  ['UpperArm_R', 'Shoulder_R', [-12, 0, 0]],
  ['LowerArm_R', 'UpperArm_R', [-28, 0, 0]],
  ['Hand_R', 'LowerArm_R', [-25, 0, 0]],
  ['UpperLeg_L', 'Hips', [9, -2, 0]],
  ['LowerLeg_L', 'UpperLeg_L', [0, -43, 0]],
  ['Foot_L', 'LowerLeg_L', [0, -42, 0]],
  ['Toes_L', 'Foot_L', [0, -8, 12]],
  ['UpperLeg_R', 'Hips', [-9, -2, 0]],
  ['LowerLeg_R', 'UpperLeg_R', [0, -43, 0]],
  ['Foot_R', 'LowerLeg_R', [0, -42, 0]],
  ['Toes_R', 'Foot_R', [0, -8, 12]]
]
const BVH_ENDS = { Head: [0, 20, 0], Hand_L: [9, 0, 0], Hand_R: [-9, 0, 0], Toes_L: [0, 0, 6], Toes_R: [0, 0, 6] }

function syntheticWaveBvh() {
  const kids = new Map()
  for (const [name, parent] of BVH_SKEL) kids.set(parent, [...(kids.get(parent) ?? []), name])
  const offset = new Map(BVH_SKEL.map(([name, , o]) => [name, o]))
  const lines = ['HIERARCHY']
  const order = []
  const emit = (name, depth) => {
    order.push(name)
    const pad = '  '.repeat(depth)
    lines.push(`${pad}${depth === 0 ? 'ROOT' : 'JOINT'} ${name}`, `${pad}{`, `${pad}  OFFSET ${offset.get(name).join(' ')}`)
    lines.push(
      pad + '  ' + (depth === 0 ? 'CHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation' : 'CHANNELS 3 Zrotation Xrotation Yrotation')
    )
    for (const kid of kids.get(name) ?? []) emit(kid, depth + 1)
    const end = BVH_ENDS[name]
    if (end) lines.push(`${pad}  End Site`, `${pad}  {`, `${pad}    OFFSET ${end.join(' ')}`, `${pad}  }`)
    lines.push(`${pad}}`)
  }
  emit('Hips', 0)
  const frames = 60
  lines.push('MOTION', `Frames: ${frames}`, `Frame Time: ${(1 / 15).toFixed(7)}`)
  for (let f = 0; f < frames; f++) {
    const rise = Math.min(1, f / 10)
    const vals = new Map(order.map((n) => [n, [0, 0, 0]]))
    vals.get('UpperArm_L')[0] = -80 + 130 * rise
    vals.get('LowerArm_L')[0] = rise * (35 + 30 * Math.sin((2 * Math.PI * f) / 12))
    vals.get('UpperArm_R')[0] = 80
    const row = [0, 95, 0]
    for (const n of order) row.push(...vals.get(n))
    lines.push(row.map((v) => v.toFixed(5)).join(' '))
  }
  return lines.join('\n') + '\n'
}

// ---------------------------------------------------------------------------------------------------
// Binary STL check: identical vertices merged, then every edge must have exactly two faces.

function checkStl(file) {
  const buf = readFileSync(file)
  const n = buf.readUInt32LE(80)
  if (84 + n * 50 !== buf.length) throw new Error(`${file} is not a binary STL (${buf.length} bytes for ${n} triangles)`)
  const ids = new Map()
  const lo = [Infinity, Infinity, Infinity]
  const hi = [-Infinity, -Infinity, -Infinity]
  const vid = (o) => {
    const x = buf.readFloatLE(o)
    const y = buf.readFloatLE(o + 4)
    const z = buf.readFloatLE(o + 8)
    const key = `${x},${y},${z}`
    let id = ids.get(key)
    if (id === undefined) {
      id = ids.size
      ids.set(key, id)
      ;[x, y, z].forEach((v, k) => {
        lo[k] = Math.min(lo[k], v)
        hi[k] = Math.max(hi[k], v)
      })
    }
    return id
  }
  const edges = new Map()
  let degenerate = 0
  for (let t = 0; t < n; t++) {
    const o = 84 + t * 50 + 12
    const v = [vid(o), vid(o + 12), vid(o + 24)]
    if (v[0] === v[1] || v[1] === v[2] || v[0] === v[2]) {
      degenerate++
      continue
    }
    for (let k = 0; k < 3; k++) {
      const a = v[k]
      const b = v[(k + 1) % 3]
      const key = a < b ? a * 2 ** 26 + b : b * 2 ** 26 + a
      edges.set(key, (edges.get(key) ?? 0) + 1)
    }
  }
  let open = 0
  let over = 0
  for (const c of edges.values()) {
    if (c === 1) open++
    else if (c > 2) over++
  }
  return { triangles: n, vertices: ids.size, open, over, degenerate, dims: hi.map((h, k) => h - lo[k]) }
}

// ---------------------------------------------------------------------------------------------------
// The run

async function main() {
  if (!existsSync(SWORD)) throw new Error(`fixture missing: ${SWORD} (run fixtures/generate.py)`)
  if (!existsSync(FIXTURE)) {
    throw new Error(`fixture missing: ${FIXTURE}\nGenerate it with: blender -b --factory-startup --python-exit-code 1 -P fixtures/generate.py`)
  }
  if (path.isAbsolute(BLENDER) && !existsSync(BLENDER)) throw new Error(`Blender not found at ${BLENDER} (set MPM_BLENDER)`)
  if (!args.has('--no-build')) build()
  mkdirSync(OUT, { recursive: true })

  const tmp = mkdtempSync(path.join(os.tmpdir(), 'mpm-e2e-'))
  const userData = path.join(tmp, 'user-data')
  const projectsDir = path.join(tmp, 'projects')
  mkdirSync(userData, { recursive: true })
  mkdirSync(projectsDir, { recursive: true })
  log('temp folder', tmp)

  const child = launch(userData, path.join(OUT, 'electron.log'))
  let cdp = null
  let ok = false
  let parity = null
  let parity2 = null
  let autoGripMs = null
  let bakeInfo = null
  const watchdog = setTimeout(() => {
    console.error(`[e2e] FAIL: the run took longer than ${RUN_TIMEOUT_MS / 60000} min`)
    killTree(child)
    process.exit(1)
  }, RUN_TIMEOUT_MS)
  try {
    const target = await pageTarget()
    cdp = await Cdp.connect(target.webSocketDebuggerUrl)
    await cdp.send('Runtime.enable')
    await cdp.send('Page.enable')
    await cdp.waitFor('!!window.__mpmTest', 'the test hook')
    await cdp.waitFor('window.__mpmTest.state().blender !== null', 'the Blender status')
    let state = await cdp.evaluate('window.__mpmTest.state()')
    assert(state.blender?.found === true, `Blender found (${JSON.stringify(state.blender)})`)
    log(`Blender ${state.blender.version} at ${state.blender.path}`)

    // 1. new project in the temp folder
    state = await cdp.evaluate(`window.__mpmTest.newProject(${JSON.stringify(projectsDir)})`)
    assert(state.project?.dir, 'project created')
    const projectDir = state.project.dir
    log('project', projectDir)

    // 2. import the fixture
    log('import', path.relative(REPO, FIXTURE))
    state = await cdp.evaluate(`window.__mpmTest.importModel(${JSON.stringify(FIXTURE)})`)
    assert(state.error === null, `no error after import (${JSON.stringify(state.error)})`)
    assert(state.import && state.import.tri_count > 0, 'import summary has triangles')
    assert(state.import.height_m > 1.5 && state.import.height_m < 2.1, `fixture height ~1.8 m (${state.import.height_m})`)
    assert(state.import.has_armature === false, 'apose fixture has no skeleton')
    assert(state.project.source?.orientation, 'orientation saved in the project')
    await cdp.waitFor('window.__mpmTest.state().viewer.previewLoaded', 'the preview model')
    await sleep(500)
    await cdp.screenshot('01-import.png')

    // 3. find joints
    log('suggest_markers')
    state = await cdp.evaluate('window.__mpmTest.findJoints()')
    assert(state.error === null, `no error after find joints (${JSON.stringify(state.error)})`)
    assert(state.markers >= 30, `markers found (${state.markers})`)
    assert(state.project.draftMarkers === state.markers, 'markers stored in rigDraft')
    await cdp.waitFor('window.__mpmTest.state().viewer.previewLoaded', 'the preview with markers')
    await sleep(500)
    await cdp.screenshot('02-markers.png')

    // 4. build the rig
    log('rig')
    state = await cdp.evaluate('window.__mpmTest.buildRig()')
    assert(state.error === null, `no error after rig (${JSON.stringify(state.error)})`)
    await cdp.waitFor('window.__mpmTest.state().rig.loaded', 'the rig model', 120_000)
    state = await cdp.evaluate('window.__mpmTest.state()')

    // 5. the rig loaded
    assert(state.rig.loaded === true, 'rig loaded in the viewer')
    assert(state.rig.bones > 0, `rig has bones (${state.rig.bones})`)
    assert(state.rig.kind === 'auto', 'auto rig')
    assert(state.project.rig?.kind === 'auto' && state.project.rig.hash === state.rig.hash, 'project.rig = {kind, hash}')
    assert(state.rig.follow && state.rig.follow.moved_fraction >= 0.05, `follow stats (${JSON.stringify(state.rig.follow)})`)
    assert(state.project.dirty === false, 'project saved after the rig job')
    for (const f of ['rig/rig.glb', 'rig/rig.json', 'rig/preview.glb', 'rig/markers.json']) {
      assert(existsSync(path.join(projectDir, f)), `${f} exists`)
    }
    const markersFile = JSON.parse(readFileSync(path.join(projectDir, 'rig', 'markers.json'), 'utf8'))
    assert(markersFile.schema === 'mpm.markers/1' && Object.keys(markersFile.markers).length === state.markers, 'markers.json written')
    log(`rig: ${state.rig.bones} bones, hash ${state.rig.hash}, follow ${JSON.stringify(state.rig.follow)}`)

    state = await cdp.evaluate('window.__mpmTest.testPose(true)')
    await cdp.waitFor(`window.__mpmTest.state().viewer.pose === 'test'`, 'the test pose')
    await sleep(500)
    await cdp.screenshot('03-rig-test-pose.png')

    // --- Pose step (WP8c)
    state = await cdp.evaluate('window.__mpmTest.testPose(false)')
    const bvh = path.join(tmp, 'dataset-1_wave-arm_normal_001.bvh')
    writeFileSync(bvh, syntheticWaveBvh())
    log('importClip', path.basename(bvh))
    const imported = await cdp.evaluate(`window.__mpmTest.importClip(${JSON.stringify(bvh)})`)
    assert(imported.packId === 'mine' && imported.clipIds.length === 1, `clip imported (${JSON.stringify(imported)})`)
    const clipId = imported.clipIds[0]
    state = await cdp.evaluate(`window.__mpmTest.selectClip('mine', ${JSON.stringify(clipId)})`)
    assert(state.error === null, `no error after selecting the clip (${JSON.stringify(state.error)})`)
    assert(state.step === 'pose' && state.library.loadedClip === `mine/${clipId}`, `clip loaded (${state.library.loadedClip})`)
    assert(state.library.indexClips.includes(clipId), 'clip listed')
    await waitPose(cdp)
    // the clip row's thumbnail is made lazily; wait for it before the library screenshot
    const thumbs = path.join(userData, 'library', 'packs', 'mine', 'thumbs')
    await waitUntil(() => existsSync(thumbs) && readdirSync(thumbs).some((f) => f.endsWith('.png')), 'the clip thumbnail', 30_000)
    await sleep(700)
    await cdp.screenshot('04-library.png')

    state = await cdp.evaluate('window.__mpmTest.scrubTo(40)')
    assert(state.pose.inputs.source?.frame === 40, 'scrubbed to frame 40')
    await waitPose(cdp)
    await cdp.screenshot('05-scrubber.png')

    state = await cdp.evaluate(`window.__mpmTest.rotateBone('spine', [0, 0, 1], 20)`)
    assert(state.pose.inputs.edits.length === 1 && state.pose.selected === 'spine', 'spine rotated and selected')
    await waitPose(cdp)
    await cdp.screenshot('06-gizmo.png')

    state = await cdp.evaluate('window.__mpmTest.toggleMirror()')
    assert(state.pose.inputs.mirrored === true, 'mirrored')
    await cdp.evaluate('window.__mpmTest.selectBone(null)')
    await waitPose(cdp)
    await cdp.screenshot('07-mirrored.png')

    state = await cdp.evaluate('window.__mpmTest.undo()')
    assert(state.pose.inputs.mirrored === false && state.pose.inputs.edits.length === 1, 'undo restored the unmirrored pose')
    const posed = await cdp.evaluate('window.__mpmTest.poseState()')

    // Save, reopen: rigDraft markers, the rig and the pose come back.
    state = await cdp.evaluate('window.__mpmTest.save()')
    assert(state.project.dirty === false, 'saved')
    const markerCount = state.markers
    const savedPose = JSON.parse(readFileSync(path.join(projectDir, 'E2E Fixture.mposer'), 'utf8')).pose
    assert(savedPose && savedPose.rig_hash === state.rig.hash, 'project.pose saved with the rig hash')
    assert(JSON.stringify(savedPose.provenance) === JSON.stringify(posed.provenance), 'saved provenance')

    state = await cdp.evaluate(`window.__mpmTest.openProject(${JSON.stringify(projectDir)})`)
    assert(state.project.dirty === false && state.markers === markerCount, `markers restored from rigDraft (${state.markers})`)
    await cdp.waitFor('window.__mpmTest.state().rig.loaded', 'the reopened rig', 60_000)
    state = await cdp.evaluate('window.__mpmTest.state()')
    assert(state.rig.hash === state.project.rig.hash, 'reopened rig matches project.rig')
    assert(state.error === null, `no error after reopening (${JSON.stringify(state.error)})`)
    assert(state.pose.notice === null, `no pose notice (${state.pose.notice})`)
    const restored = await cdp.evaluate('window.__mpmTest.poseState()')
    assert(JSON.stringify(restored.provenance) === JSON.stringify(savedPose.provenance), 'provenance restored')
    let worstDelta = 0
    for (const [k, q] of Object.entries(savedPose.deltas)) {
      for (let n = 0; n < 4; n++) worstDelta = Math.max(worstDelta, Math.abs(q[n] - restored.deltas[k][n]))
    }
    assert(worstDelta < 1e-6, `deltas restored within 1e-6 (${worstDelta})`)
    log(`pose restored: provenance equal, worst delta difference ${worstDelta.toExponential(2)}`)

    // App <-> Blender parity: the renderer's posed vertices against the dump_skinned job.
    await waitPose(cdp)
    const sampled = await cdp.evaluate('window.__mpmTest.posedSample(500)')
    const count = Object.values(sampled.sample).reduce((n, v) => n + v.length, 0)
    log(`dump_skinned with ${count} sampled vertices`)
    const dumped = await cdp.evaluate(`window.__mpmTest.dumpSkinned(${JSON.stringify(sampled.sample)})`)
    assert(!dumped.error, `dump_skinned ran (${JSON.stringify(dumped.error)})`)
    let worst = 0
    for (const [mesh, idx] of Object.entries(sampled.sample)) {
      const engine = dumped.meshes[mesh]
      assert(engine && JSON.stringify(engine.indices) === JSON.stringify(idx), `engine returned mesh ${mesh}`)
      idx.forEach((_v, k) => {
        const a = sampled.positions[mesh][k]
        const b = engine.positions[k]
        worst = Math.max(worst, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]))
      })
    }
    log(`parity: max vertex difference ${worst.toExponential(3)} m over ${count} vertices`)
    assert(count >= 450, `about 500 vertices sampled (${count})`)
    assert(worst < 1e-4, `renderer vs Blender under 1e-4 m (${worst})`)
    parity = { worst, count }

    // --- Weapons, hands, export (WP9)
    const swordTruth = JSON.parse(readFileSync(SWORD.replace(/\.glb$/, '.truth.json'), 'utf8')).grips
    state = await cdp.evaluate(`window.__mpmTest.setStep('weapons')`)
    log('add weapon', path.relative(REPO, SWORD))
    const weapon = await cdp.evaluate(`window.__mpmTest.addWeapon(${JSON.stringify(SWORD)})`)
    assert(weapon.id && weapon.file === 'weapons/sword.glb' && weapon.attach_bone === 'grip.R', `weapon added (${JSON.stringify(weapon)})`)
    // from the rest pose, the right hand in front of the body so the left hand can reach the sword
    state = await cdp.evaluate('window.__mpmTest.clearPose()')
    assert(state.pose.inputs.source === null && state.pose.inputs.edits.length === 0, 'rest pose')
    state = await cdp.evaluate(`window.__mpmTest.reach('R', [-0.03, -0.3, 1.2])`)
    state = await cdp.evaluate(`window.__mpmTest.setGripPoint(${JSON.stringify(weapon.id)}, ${JSON.stringify(swordTruth.main.point)})`)
    const support = { point: swordTruth.support.point, normal: swordTruth.support.palm_normal, axis: swordTruth.support.axis }
    state = await cdp.evaluate(`window.__mpmTest.setSupport(${JSON.stringify(weapon.id)}, ${JSON.stringify(support)})`)
    assert(state.weapons[0].support.enabled === true && state.weapons[0].support.side === 'L', 'two-handed, left hand supports')
    const short = (await cdp.evaluate('window.__mpmTest.supportShort()'))[weapon.id]
    log(`support hand short by ${(short * 1000).toFixed(3)} mm`)
    assert(short < 0.001, `the left hand reaches the support grip (${short} m)`)
    state = await cdp.evaluate(`window.__mpmTest.selectWeapon(${JSON.stringify(weapon.id)}, 'move')`)
    await cdp.evaluate(`window.__mpmTest.focusJoint('wrist_R', 0.45)`)
    await waitPose(cdp)
    await cdp.screenshot('09-weapon-gizmo.png')

    // auto-grip the right hand from the sword preset
    state = await cdp.evaluate(`window.__mpmTest.setStep('hands')`)
    state = await cdp.evaluate(`window.__mpmTest.preset('R', 'sword')`)
    const grip = await cdp.evaluate(`window.__mpmTest.autoGrip('R')`)
    const fingerText = Object.entries(grip.fingers)
      .map(([f, r]) => `${f} ${r.touching ? 'touching' : r.maxed ? 'max flex' : 'NOT touching'} (${(r.minDistance_m * 1000).toFixed(1)} mm)`)
      .join(', ')
    log(`auto-grip R in ${grip.ms.toFixed(1)} ms: ${fingerText}`)
    for (const [f, r] of Object.entries(grip.fingers)) assert(r.touching || r.maxed, `${f} touching or at max flex`)
    autoGripMs = grip.ms
    state = await cdp.evaluate(`window.__mpmTest.preset('L', 'sword')`)
    const gripL = await cdp.evaluate(`window.__mpmTest.autoGrip('L')`)
    log(`auto-grip L in ${gripL.ms.toFixed(1)} ms`)
    await cdp.evaluate(`window.__mpmTest.focusJoint('wrist_R', 0.16)`)
    await waitPose(cdp)
    await cdp.screenshot('08-hands.png')
    await cdp.evaluate(`window.__mpmTest.focusJoint('wrist_L', 0.24)`)
    await waitPose(cdp)
    await cdp.screenshot('10-two-handed.png')

    // parity with the hands and the weapon: grip.R's attach frame and the skinned vertices
    const sampled2 = await cdp.evaluate('window.__mpmTest.posedSample(500)')
    const dumped2 = await cdp.evaluate(`window.__mpmTest.dumpSkinned(${JSON.stringify(sampled2.sample)})`)
    assert(!dumped2.error, `dump_skinned ran (${JSON.stringify(dumped2.error)})`)
    let worst2 = 0
    let count2 = 0
    for (const [mesh, idx] of Object.entries(sampled2.sample)) {
      idx.forEach((_v, k) => {
        const a = sampled2.positions[mesh][k]
        const b = dumped2.meshes[mesh].positions[k]
        worst2 = Math.max(worst2, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]))
        count2++
      })
    }
    const gi = await cdp.evaluate(`window.__mpmTest.boneIndex('grip.R')`)
    const ours = await cdp.evaluate(`window.__mpmTest.attachFrame('grip.R')`)
    const theirs = dumped2.bones.find((b) => b.index === gi)?.matrix
    assert(ours && theirs, 'attach frames available')
    let worstT = 0
    let worstR = 0
    for (let r = 0; r < 3; r++) {
      worstT = Math.max(worstT, Math.abs(ours[r][3] - theirs[r][3]))
      for (let c = 0; c < 3; c++) worstR = Math.max(worstR, Math.abs(ours[r][c] - theirs[r][c]))
    }
    log(`parity with hands and weapon: vertices ${worst2.toExponential(3)} m over ${count2}; grip.R attach frame translation ${worstT.toExponential(3)} m, rotation ${worstR.toExponential(3)}`)
    assert(worst2 < 1e-4, `vertex parity with hand poses under 1e-4 m (${worst2})`)
    assert(worstT < 1e-5 && worstR < 1e-5, `grip.R attach frame within 1e-5 (${worstT}, ${worstR})`)
    parity2 = { worst: worst2, count: count2, attachT: worstT, attachR: worstR }

    // bake at 40 mm with the sword merged
    log('bake at 40 mm (this takes a while)')
    const baked = await cdp.evaluate('window.__mpmTest.bake(40)', 30 * 60 * 1000)
    assert(baked.stl && !baked.error, `bake ran (${JSON.stringify(baked.error ?? null)})`)
    const stl = checkStl(path.join(projectDir, baked.stl))
    log(
      `bake: ${baked.seconds} s in Blender (${baked.wall_s.toFixed(1)} s in all); STL ${stl.triangles} triangles, ${stl.vertices} vertices, ` +
        `${stl.open} open edges, ${stl.over} edges with >2 faces, ${stl.degenerate} degenerate, size ${stl.dims.map((d) => d.toFixed(2)).join(' x ')} mm`
    )
    assert(stl.open === 0, `no open edges (${stl.open})`)
    assert(stl.over === 0, `no edges with more than two faces (${stl.over})`)
    assert(stl.dims[2] <= 40.05, `height <= 40.05 mm (${stl.dims[2]})`)
    bakeInfo = { seconds: baked.seconds, wall: baked.wall_s, stl }
    await cdp.waitFor('window.__mpmTest.state().viewer.bakedLoaded', 'the bake preview', 60_000)
    await sleep(700)
    await cdp.screenshot('11-export.png')
    ok = true
    log(
      `PASS (parity ${parity.worst.toExponential(3)} m; with hands ${parity2.worst.toExponential(3)} m, attach ${parity2.attachT.toExponential(2)} / ${parity2.attachR.toExponential(2)}; ` +
        `auto-grip ${autoGripMs.toFixed(1)} ms; bake ${bakeInfo.seconds} s; STL ${bakeInfo.stl.open} open / ${bakeInfo.stl.over} non-manifold, height ${bakeInfo.stl.dims[2].toFixed(2)} mm)`
    )
  } catch (e) {
    if (cdp) {
      const state = await cdp.evaluate('JSON.stringify(window.__mpmTest.state(), null, 1)', 5000).catch(() => null)
      if (state) log('state at failure:', state)
      await cdp.screenshot('failure.png').catch(() => {})
    }
    throw e
  } finally {
    if (cdp) {
      await cdp.evaluate('window.close(), true', 5000).catch(() => {})
      cdp.close()
    }
    if (!(await waitExit(child, 15_000))) {
      log('app did not quit; killing it')
      killTree(child)
      await waitExit(child, 5000)
    }
    clearTimeout(watchdog)
    if (ok && !args.has('--keep')) rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    else log('kept', tmp)
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error('[e2e] FAIL:', e instanceof Error ? e.message : e)
    process.exit(1)
  }
)
