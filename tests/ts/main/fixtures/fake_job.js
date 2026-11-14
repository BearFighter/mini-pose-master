// SPDX-License-Identifier: GPL-3.0-or-later
// Fake Blender for the JobRunner tests. Run as `node fake_job.js <Blender arguments>`; it checks the
// Blender command line and job.json like a real job would, then plays the scenario named by the
// MPM_FAKE_JOB environment variable.
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')

const argv = process.argv.slice(2)
const out = (line) => process.stdout.write(line + '\n')
const tagged = (tag, obj) => out('@@' + tag + ' ' + JSON.stringify(obj))
const hang = () => setInterval(() => {}, 1000)

function badArgs(message) {
  tagged('error', { code: 'E_ARGS', message, detail: { argv } })
  process.exitCode = 1
}

function main() {
  const head = ['-b', '--factory-startup', '--offline-mode', '--python-exit-code', '1', '-P']
  if (argv.length !== head.length + 3 || head.some((arg, i) => argv[i] !== arg) || argv[head.length + 1] !== '--') {
    return badArgs('unexpected Blender command line')
  }
  const script = argv[head.length]
  const jobFile = argv[head.length + 2]
  if (!path.isAbsolute(script) || !path.isAbsolute(jobFile)) return badArgs('script and job.json must be absolute')
  let job
  try {
    job = JSON.parse(fs.readFileSync(jobFile, 'utf8'))
  } catch (e) {
    return badArgs('cannot read job file: ' + e.message)
  }
  if (job.schema !== 'mpm.job/1' || path.basename(script) !== job.type + '.py') return badArgs('job.json does not match')

  switch (process.env.MPM_FAKE_JOB) {
    case 'result':
      tagged('progress', { stage: 'load', fraction: 0.1, message: 'loading' })
      out('plain log line')
      process.stderr.write('stderr line\n')
      // One progress line split over two writes, with ASCII-escaped text and a CRLF ending.
      process.stdout.write('@@progress {"stage":"work","fraction":0.5,')
      setTimeout(() => {
        process.stdout.write('"message":"caf\\u00e9 \\u2192 ok"}\r\n')
        tagged('result', { id: job.id, type: job.type, project_dir: job.project_dir, args: job.args, script, jobFile })
        process.exitCode = 0
      }, 50)
      return
    case 'error':
      tagged('progress', { stage: 'import', fraction: 0.05, message: 'importing' })
      tagged('error', { code: 'E_NO_MESH', message: 'the file contains no mesh', detail: { path: 'x.fbx' } })
      process.exitCode = 1
      return
    case 'noresult':
      out('finished without a result')
      process.exitCode = 0
      return
    case 'crash':
      for (let i = 1; i <= 50; i++) out('line ' + i)
      process.exitCode = 3
      return
    case 'double':
      tagged('result', { n: 1 })
      tagged('result', { n: 2 })
      process.exitCode = 0
      return
    case 'slow':
      tagged('progress', { stage: 'start', fraction: 0, message: job.id })
      setTimeout(() => {
        tagged('result', { id: job.id })
        process.exitCode = 0
      }, 150)
      return
    case 'hang':
      tagged('progress', { stage: 'pids', fraction: 0, message: String(process.pid) })
      hang()
      return
    case 'tree': {
      // A grandchild (like a helper Blender may start) and a parent that ignores SIGTERM,
      // so the runner needs both the tree kill and the SIGKILL follow-up.
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
      process.on('SIGTERM', () => {})
      tagged('progress', { stage: 'pids', fraction: 0, message: process.pid + ' ' + child.pid })
      hang()
      return
    }
    default:
      return badArgs('unknown MPM_FAKE_JOB scenario: ' + process.env.MPM_FAKE_JOB)
  }
}

main()
