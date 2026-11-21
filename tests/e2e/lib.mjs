// SPDX-License-Identifier: GPL-3.0-or-later
// Shared helpers for the end-to-end drivers (drive.mjs: the full scripted flow; real.mjs: a report on any model):
// a tiny Chrome DevTools Protocol client, app build/launch/kill, and a binary STL check.
import { spawn, spawnSync } from 'node:child_process'
import { createWriteStream, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const PORT = Number(process.env.MPM_E2E_PORT || 9333)
const DEFAULT_BLENDER = {
  win32: 'C:/Program Files/Blender Foundation/Blender 5.2/blender.exe',
  darwin: '/Applications/Blender.app/Contents/MacOS/Blender',
  linux: 'blender'
}
export const BLENDER = process.env.MPM_BLENDER || DEFAULT_BLENDER[process.platform] || 'blender'

export const JOB_TIMEOUT_MS = 10 * 60 * 1000
/** The whole run, build excluded. */
export const RUN_TIMEOUT_MS = 60 * 60 * 1000
export const SCREENSHOT_TIMEOUT_MS = 5_000
export const SCREENSHOT_ATTEMPTS = 8
/** Makes the page draw a new frame (the R3F canvas redraws on resize), then waits two frames. */
export const REPAINT =
  "window.dispatchEvent(new Event('resize')), new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))"
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function withTimeout(promise, ms, what) {
  let timer
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timeout after ${ms} ms: ${what}`)), ms)
    })
  ])
}
export const log = (...a) => console.log('[e2e]', ...a)

export function assert(cond, message) {
  if (!cond) throw new Error(`assertion failed: ${message}`)
}

// ---------------------------------------------------------------------------------------------------
// CDP client

export class Cdp {
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
  async screenshot(name, dir = path.join(REPO, 'tests', 'e2e', 'out')) {
    const file = path.join(dir, name)
    for (let attempt = 1; attempt <= SCREENSHOT_ATTEMPTS; attempt++) {
      await this.evaluate(REPAINT, 10_000).catch(() => {})
      try {
        const { data } = await withTimeout(this.send('Page.captureScreenshot', { format: 'png' }), SCREENSHOT_TIMEOUT_MS, `screenshot ${name}`)
        writeFileSync(file, Buffer.from(data, 'base64'))
        log('screenshot', file)
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

export function build() {
  log('npm run build')
  // One command string: npm is a .cmd script on Windows and needs the shell.
  const res = spawnSync('npm run build', { cwd: REPO, stdio: 'inherit', shell: true })
  if (res.status !== 0) throw new Error(`npm run build failed (exit ${res.status})`)
}

export function launch(userDataDir, logFile) {
  const electron = createRequire(import.meta.url)('electron')
  const env = { ...process.env, MPM_E2E: '1', MPM_BLENDER: BLENDER }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  const child = spawn(electron, ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDataDir}`], {
    cwd: REPO,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  const out = createWriteStream(logFile)
  child.stdout.pipe(out)
  child.stderr.pipe(out)
  return child
}

export async function pageTarget(timeoutMs = 60_000) {
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

export function waitExit(child, ms) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

export function killTree(child) {
  if (child.exitCode !== null || child.pid === undefined) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  else child.kill('SIGKILL')
}

// ---------------------------------------------------------------------------------------------------
// Pose step helpers

/** Waits until the viewer has shown a new pose (viewer.poseSeq increased), then a little more. */
export async function waitPose(cdp) {
  const before = await cdp.evaluate('window.__mpmTest.state().viewer.poseSeq')
  await cdp
    .waitFor(`window.__mpmTest.state().viewer.poseSeq > ${before} && window.__mpmTest.state().viewer.pose === 'pose'`, 'the posed rig', 10_000)
    .catch(() => {}) // the pose may already have been shown before `before` was read
  await sleep(500)
}

export async function waitUntil(check, what, timeoutMs) {
  const end = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(250)
  }
}

// ---------------------------------------------------------------------------------------------------
// Binary STL check: identical vertices merged, then every edge must have exactly two faces.

export function checkStl(file) {
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
