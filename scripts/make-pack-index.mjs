#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Prints the `download.files` array of a resources/packs.json entry (contracts section 20) for the
// files in a local copy of a dataset:
//
//   node scripts/make-pack-index.mjs --pack bandai1 --dir <folder> --url-prefix <prefix> [--ext .bvh] [--no-git]
//
// The hashes must match the bytes the URLs serve. When <folder> is inside a git work tree, the
// committed blobs at HEAD are hashed (a checkout with core.autocrlf rewrites line endings, so the
// working files may differ from what raw.githubusercontent.com serves); --no-git hashes the files on
// disk. Read-only: nothing in <folder> is written. Node built-ins only.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

function usage(message) {
  if (message) console.error(`error: ${message}`)
  console.error('usage: node scripts/make-pack-index.mjs --pack <id> --dir <folder> --url-prefix <prefix> [--ext .bvh] [--no-git]')
  process.exit(2)
}

function parseArgs(argv) {
  const opts = { ext: '.bvh', git: true }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = () => {
      const v = argv[++i]
      if (v === undefined) usage(`${arg} needs a value`)
      return v
    }
    if (arg === '--pack') opts.pack = value()
    else if (arg === '--dir') opts.dir = value()
    else if (arg === '--url-prefix') opts.urlPrefix = value()
    else if (arg === '--ext') opts.ext = value().toLowerCase()
    else if (arg === '--no-git') opts.git = false
    else usage(`unknown argument ${arg}`)
  }
  if (!opts.pack || !opts.dir || !opts.urlPrefix) usage('--pack, --dir and --url-prefix are required')
  if (!/^https:\/\//.test(opts.urlPrefix)) usage('--url-prefix must start with https://')
  return opts
}

function git(cwd, args, encoding = 'utf8') {
  return execFileSync('git', ['-C', cwd, ...args], { encoding, maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'pipe'] })
}

function gitTopLevel(dir) {
  try {
    return git(dir, ['rev-parse', '--show-toplevel']).trim()
  } catch {
    return null
  }
}

const opts = parseArgs(process.argv.slice(2))
const dir = path.resolve(opts.dir)
const names = readdirSync(dir)
  .filter((name) => name.toLowerCase().endsWith(opts.ext) && statSync(path.join(dir, name)).isFile())
  .sort()
if (names.length === 0) usage(`no ${opts.ext} files in ${dir}`)

const top = opts.git ? gitTopLevel(dir) : null
let head = null
if (top) {
  head = git(top, ['rev-parse', 'HEAD']).trim()
  const pinned = /\b[0-9a-f]{40}\b/.exec(opts.urlPrefix)?.[0]
  if (pinned && pinned !== head) usage(`--url-prefix pins ${pinned}, but ${top} is at ${head}`)
}

const prefix = opts.urlPrefix.endsWith('/') ? opts.urlPrefix : `${opts.urlPrefix}/`
let differ = 0
const files = names.map((name) => {
  const abs = path.join(dir, name)
  let bytes
  if (top) {
    const rel = path.relative(top, abs).split(path.sep).join('/')
    bytes = git(top, ['cat-file', 'blob', `HEAD:${rel}`], 'buffer')
    if (!bytes.equals(readFileSync(abs))) differ++
  } else {
    bytes = readFileSync(abs)
  }
  return {
    name,
    url: prefix + encodeURIComponent(name),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length
  }
})

const total = files.reduce((sum, f) => sum + f.size, 0)
console.error(
  `${opts.pack}: ${files.length} files, ${(total / 1024 ** 2).toFixed(1)} MB, hashed from ` +
    (top ? `git HEAD ${head}` : 'the files on disk') +
    (differ ? ` (${differ} working files differ from the committed bytes, e.g. line endings)` : '')
)
process.stdout.write(JSON.stringify(files, null, 2) + '\n')
