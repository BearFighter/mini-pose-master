// SPDX-License-Identifier: GPL-3.0-or-later
// Runs the real app on YOUR model (a bought FBX, glTF, OBJ...) through the whole flow and reports what
// happened at each step: import -> find joints (marker confidence) -> rig (follow check) -> test pose ->
// optional mocap clip frame -> optional weapon + auto-grip -> bake and an STL check.
// Nothing is written inside the repo: the project, screenshots and report.json all go to --out.
//
//   node tests/e2e/real.mjs (--model <file> | --kit <name>) --out <dir> [--clip <file.bvh> --frame <source frame>]
//                           [--weapon <file> | --prop-weapon] [--height 40] [--no-build] [--no-bake]
//
// --kit reads the model and its per-part choice from the local, git-ignored tests/local/kits.json
// (see tests/engine/kits.py). --prop-weapon puts the kit's own first prop (a gun shipped beside the
// character) in the right hand.
//
// Env: MPM_BLENDER, MPM_E2E_PORT (see lib.mjs).
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { BLENDER, Cdp, REPO, assert, build, checkStl, killTree, launch, log, pageTarget, sleep, waitExit, waitPose } from './lib.mjs'

function option(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback
}
const flag = (name) => process.argv.includes(`--${name}`)

function kitConfig(name) {
  const file = process.env.MPM_KITS || path.join(REPO, 'tests', 'local', 'kits.json')
  if (!existsSync(file)) throw new Error(`no kit config at ${file}`)
  const kit = JSON.parse(readFileSync(file, 'utf8')).kits?.[name]
  if (!kit) throw new Error(`kit ${name} is not in ${file}`)
  return kit
}
const KIT = option('kit') ? kitConfig(option('kit')) : null
const MODEL = KIT ? path.resolve(KIT.model) : option('model') && path.resolve(option('model'))
const OBJECTS = KIT?.objects ?? null
const OUT = option('out') && path.resolve(option('out'))
const CLIP = option('clip') && path.resolve(option('clip'))
const FRAME = option('frame') !== null ? Number(option('frame')) : null
const WEAPON = option('weapon') && path.resolve(option('weapon'))
const HEIGHT = Number(option('height', '40'))

/** The clip frame (15 fps, frames picked) nearest to a source frame of the BVH. */
function clipFrame(bvh, sourceFrame) {
  const m = /Frame Time:\s*([0-9.eE+-]+)/.exec(readFileSync(bvh, 'utf8').slice(0, 1 << 20))
  const fps = m ? 1 / Number(m[1]) : 30
  return Math.round((sourceFrame * 15) / fps)
}

function projectFile(dir) {
  const f = readdirSync(dir).find((n) => n.endsWith('.mposer'))
  return f ? JSON.parse(readFileSync(path.join(dir, f), 'utf8')) : null
}

async function main() {
  if (!MODEL || !OUT) throw new Error('usage: node tests/e2e/real.mjs --model <file> --out <dir> [...]')
  if (!existsSync(MODEL)) throw new Error(`model not found: ${MODEL}`)
  if (path.isAbsolute(BLENDER) && !existsSync(BLENDER)) throw new Error(`Blender not found at ${BLENDER} (set MPM_BLENDER)`)
  if (!flag('no-build')) build()
  mkdirSync(OUT, { recursive: true })
  const userData = path.join(OUT, 'user-data')
  const projects = path.join(OUT, 'projects')
  mkdirSync(userData, { recursive: true })
  mkdirSync(projects, { recursive: true })
  const report = { model: path.basename(MODEL), steps: {} }
  const shot = (cdp, name) => cdp.screenshot(name, OUT).catch((e) => log(`screenshot ${name} failed: ${e.message}`))

  const child = launch(userData, path.join(OUT, 'electron.log'))
  let cdp = null
  let step = 'start'
  try {
    cdp = await Cdp.connect((await pageTarget()).webSocketDebuggerUrl)
    await cdp.send('Runtime.enable')
    await cdp.send('Page.enable')
    await cdp.waitFor('!!window.__mpmTest', 'the test hook')
    await cdp.waitFor('window.__mpmTest.state().blender !== null', 'the Blender status')
    const name = path.basename(MODEL, path.extname(MODEL)).replace(/[^\w-]+/g, '_')
    let state = await cdp.evaluate(`window.__mpmTest.newProject(${JSON.stringify(projects)}, ${JSON.stringify(name)})`)
    const projectDir = state.project.dir

    step = 'import'
    let t = Date.now()
    state = await cdp.evaluate(`window.__mpmTest.importModel(${JSON.stringify(MODEL)}, ${JSON.stringify(OBJECTS ?? undefined) ?? 'undefined'})`)
    assert(!state.error, `import: ${JSON.stringify(state.error)}`)
    await cdp.waitFor('window.__mpmTest.state().viewer.previewLoaded', 'the preview model', 120_000)
    report.steps.import = {
      ...state.import,
      all_objects: (state.import?.all_objects ?? []).filter((o) => !o.included).map((o) => `${o.name}${o.prop ? ' (prop)' : ''}`),
      seconds: (Date.now() - t) / 1000,
      source: projectFile(projectDir)?.source
    }
    const props = state.import?.props ?? []
    log('import:', JSON.stringify(report.steps.import))
    await shot(cdp, '01-import.png')

    step = 'find joints'
    t = Date.now()
    state = await cdp.evaluate('window.__mpmTest.findJoints()')
    assert(!state.error, `find joints: ${JSON.stringify(state.error)}`)
    const markers = projectFile(projectDir)?.rigDraft?.markers ?? {}
    const conf = Object.entries(markers).map(([k, v]) => [k, v.confidence ?? 0]).sort((a, b) => a[1] - b[1])
    report.steps.markers = {
      count: conf.length,
      sure: conf.filter(([, c]) => c >= 0.8).length,
      check: conf.filter(([, c]) => c >= 0.5 && c < 0.8).length,
      unsure: conf.filter(([, c]) => c < 0.5).length,
      lowest: conf.slice(0, 10).map(([k, c]) => `${k} ${(c * 100).toFixed(0)}%`),
      seconds: (Date.now() - t) / 1000
    }
    log('markers:', JSON.stringify(report.steps.markers))
    await sleep(1000)
    await shot(cdp, '02-markers.png')

    step = 'rig'
    t = Date.now()
    state = await cdp.evaluate('window.__mpmTest.buildRig()')
    assert(!state.error, `rig: ${JSON.stringify(state.error)}`)
    await cdp.waitFor('window.__mpmTest.state().rig.loaded', 'the rig model', 300_000)
    state = await cdp.evaluate('window.__mpmTest.state()')
    report.steps.rig = { ...state.rig, seconds: (Date.now() - t) / 1000 }
    log('rig:', JSON.stringify(report.steps.rig))
    state = await cdp.evaluate('window.__mpmTest.testPose(true)')
    await cdp.waitFor(`window.__mpmTest.state().viewer.pose === 'test'`, 'the test pose')
    await sleep(800)
    await shot(cdp, '03-test-pose.png')
    await cdp.evaluate('window.__mpmTest.testPose(false)')
    for (const s of ['L', 'R']) {
      await cdp.evaluate(`window.__mpmTest.focusJoint('wrist_${s}', 0.22)`).catch(() => {})
      await sleep(800)
      await shot(cdp, `03-hand-${s}.png`)
    }

    if (CLIP) {
      step = 'pose'
      const imported = await cdp.evaluate(`window.__mpmTest.importClip(${JSON.stringify(CLIP)})`)
      const clipId = imported.clipIds[0]
      await cdp.evaluate(`window.__mpmTest.selectClip(${JSON.stringify(imported.packId)}, ${JSON.stringify(clipId)})`)
      const frame = FRAME === null ? 0 : clipFrame(CLIP, FRAME)
      state = await cdp.evaluate(`window.__mpmTest.scrubTo(${frame})`)
      await waitPose(cdp)
      report.steps.pose = { clip: clipId, sourceFrame: FRAME, clipFrame: frame, notice: state.pose?.notice ?? null }
      log('pose:', JSON.stringify(report.steps.pose))
      await shot(cdp, '04-pose.png')
    }

    const propWeapon = flag('prop-weapon') && props.length ? props[0].file : null
    if (WEAPON || propWeapon) {
      step = 'weapon'
      await cdp.evaluate(`window.__mpmTest.setStep('weapons')`)
      const weapon = propWeapon
        ? await cdp.evaluate(`window.__mpmTest.addPropWeapon(${JSON.stringify(propWeapon)})`)
        : await cdp.evaluate(`window.__mpmTest.addWeapon(${JSON.stringify(WEAPON)})`)
      await sleep(1500)
      await shot(cdp, '05-weapon.png')
      await cdp.evaluate(`window.__mpmTest.setStep('hands')`)
      await cdp.evaluate(`window.__mpmTest.preset('R', 'sword')`)
      const grip = await cdp.evaluate(`window.__mpmTest.autoGrip('R')`)
      report.steps.weapon = {
        id: weapon.id,
        from: propWeapon ?? WEAPON,
        autoGrip: Object.fromEntries(
          Object.entries(grip.fingers).map(([f, r]) => [
            f,
            `${r.touching ? 'touching' : r.maxed ? 'max flex' : 'open'}${r.reopened ? ' (reopened)' : ''} d=${((r.minDistance_m ?? 0) * grip.unitMm).toFixed(3)} mm print`
          ])
        ),
        ms: grip.ms
      }
      log('weapon:', JSON.stringify(report.steps.weapon))
      await cdp.evaluate(`window.__mpmTest.focusJoint('wrist_R', 0.2)`).catch(() => {})
      await sleep(800)
      await shot(cdp, '06-grip.png')
    }

    if (!flag('no-bake')) {
      step = 'bake'
      await cdp.evaluate(`window.__mpmTest.setStep('export')`)
      t = Date.now()
      const baked = await cdp.evaluate(`window.__mpmTest.bake(${HEIGHT})`, 60 * 60 * 1000)
      state = await cdp.evaluate('window.__mpmTest.state()')
      assert(!state.error, `bake: ${JSON.stringify(state.error)}`)
      const stl = path.join(projectDir, baked.stl ?? state.bake.stl)
      const check = checkStl(stl)
      report.steps.bake = { seconds: (Date.now() - t) / 1000, stl, check, result: baked }
      log('bake:', JSON.stringify({ seconds: report.steps.bake.seconds, check }))
      await cdp.evaluate('window.__mpmTest.setShowBaked(true)')
      await sleep(1500)
      await shot(cdp, '07-baked.png')
    }
    report.ok = true
    log('DONE')
  } catch (e) {
    report.ok = false
    report.failedAt = step
    report.error = e instanceof Error ? e.message : String(e)
    if (cdp) {
      report.appError = await cdp.evaluate('window.__mpmTest.state().error').catch(() => null)
      await shot(cdp, `error-${step.replace(/\W+/g, '-')}.png`)
    }
    console.error(`[real] FAILED at ${step}: ${report.error}`)
  } finally {
    writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 1))
    cdp?.close()
    killTree(child)
    await waitExit(child, 5000)
    log('report', path.join(OUT, 'report.json'))
    process.exitCode = report.ok ? 0 : 1
  }
}

main()
