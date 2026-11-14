// SPDX-License-Identifier: GPL-3.0-or-later
// End-to-end run of the real app through the Chrome DevTools Protocol (no dependencies: Node 24
// has fetch and WebSocket). Builds the app, launches Electron with MPM_E2E=1, a temp user-data
// folder and the installed Blender, then: new project -> import fixtures/out/apose/apose.fbx ->
// find joints -> build rig -> test pose. Screenshots go to tests/e2e/out/*.png.
//
//   node tests/e2e/drive.mjs [--no-build] [--keep]
//
// Env: MPM_BLENDER (default: the standard Blender 5.2 install path), MPM_E2E_PORT (default 9333).
import { spawn, spawnSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const OUT = path.join(REPO, 'tests', 'e2e', 'out')
const PORT = Number(process.env.MPM_E2E_PORT || 9333)
const FIXTURE = path.join(REPO, 'fixtures', 'out', 'apose', 'apose.fbx')
const DEFAULT_BLENDER = {
  win32: 'C:/Program Files/Blender Foundation/Blender 5.2/blender.exe',
  darwin: '/Applications/Blender.app/Contents/MacOS/Blender',
  linux: 'blender'
}
const BLENDER = process.env.MPM_BLENDER || DEFAULT_BLENDER[process.platform] || 'blender'
const args = new Set(process.argv.slice(2))

const JOB_TIMEOUT_MS = 10 * 60 * 1000
/** The whole run, build excluded. */
const RUN_TIMEOUT_MS = 25 * 60 * 1000
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
// The run

async function main() {
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

    // Leave cleanly: nothing unsaved.
    state = await cdp.evaluate('window.__mpmTest.save()')
    assert(state.project.dirty === false, 'saved')
    const markerCount = state.markers

    // Reopen the project: rigDraft markers and the rig come back.
    state = await cdp.evaluate(`window.__mpmTest.openProject(${JSON.stringify(projectDir)})`)
    assert(state.project.dirty === false && state.markers === markerCount, `markers restored from rigDraft (${state.markers})`)
    assert(state.project.rig?.hash === state.rig.hash || state.rig.hash === null, 'project.rig kept')
    await cdp.waitFor('window.__mpmTest.state().rig.loaded', 'the reopened rig', 60_000)
    state = await cdp.evaluate('window.__mpmTest.state()')
    assert(state.rig.hash === state.project.rig.hash, 'reopened rig matches project.rig')
    assert(state.error === null, `no error after reopening (${JSON.stringify(state.error)})`)
    ok = true
    log('PASS')
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
