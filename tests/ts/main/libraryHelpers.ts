// SPDX-License-Identifier: GPL-3.0-or-later
// Library test helpers: a local node:http server, a fake JobRunner that plays the engine's
// convert_clip, and a synthetic BVH writer (the tests/engine/test_convert.py skeleton, ported).
// No third-party data anywhere.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import zlib from 'node:zlib'
import type { JobEvent, JobErrorPayload } from '../../../src/shared/ipc'
import type { JobSpec } from '../../../electron/main/jobs'
import type { JobRunnerLike, Library } from '../../../electron/main/library'

export const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex')

// ---------------------------------------------------------------------------------------------------
// HTTP server

export type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void

export interface TestServer {
  base: string
  hits: Map<string, number>
  /** Routes by path; anything else is 404. */
  routes: Map<string, Handler>
  close(): Promise<void>
}

export async function startServer(): Promise<TestServer> {
  const routes = new Map<string, Handler>()
  const hits = new Map<string, number>()
  const sockets = new Set<import('node:net').Socket>()
  const server = http.createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0]
    hits.set(url, (hits.get(url) ?? 0) + 1)
    const handler = routes.get(url)
    if (!handler) {
      res.writeHead(404).end('not found')
      return
    }
    handler(req, res)
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    base: `http://127.0.0.1:${port}`,
    hits,
    routes,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
      })
  }
}

export function serveBytes(body: string | Uint8Array): Handler {
  return (_req, res) => {
    const data = typeof body === 'string' ? Buffer.from(body) : Buffer.from(body)
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(data.length) })
    res.end(data)
  }
}

/** Sends `body` in `chunk`-byte pieces every `delayMs`. */
export function serveSlowly(body: Uint8Array, chunk: number, delayMs: number): Handler {
  return (_req, res) => {
    res.writeHead(200, { 'content-length': String(body.length) })
    let offset = 0
    const timer = setInterval(() => {
      if (res.destroyed) return clearInterval(timer)
      res.write(Buffer.from(body.subarray(offset, offset + chunk)))
      offset += chunk
      if (offset >= body.length) {
        clearInterval(timer)
        res.end()
      }
    }, delayMs)
    res.on('close', () => clearInterval(timer))
  }
}

// ---------------------------------------------------------------------------------------------------
// Fake JobRunner

/** What a fake convert_clip job does: a result payload, an engine error, or 'hold' (wait for cancel). */
export type Outcome = { result: unknown } | { error: JobErrorPayload } | 'hold'

/** Writes index.json the way clipio.add_to_pack does (ids = file stems) and returns the clip ids. */
export function fakeConvert(spec: JobSpec, ids?: string[]): { clips: string[]; failed: unknown[] } {
  const args = spec.args as { files?: string[]; pack_dir: string; pack: Record<string, unknown> }
  const clips = ids ?? (args.files ?? []).map((f) => path.parse(f).name)
  const indexFile = path.join(args.pack_dir, 'index.json')
  const index = existsSync(indexFile)
    ? JSON.parse(readFileSync(indexFile, 'utf8'))
    : { schema: 'mpm.pack/1', pack: args.pack.pack, converter_version: args.pack.converter_version, clips: [] }
  for (const id of clips) index.clips.push({ id })
  mkdirSync(args.pack_dir, { recursive: true })
  writeFileSync(indexFile, JSON.stringify(index))
  return { clips, failed: [] }
}

export class FakeRunner implements JobRunnerLike {
  readonly specs: JobSpec[] = []
  readonly held = new Set<string>()
  library: Library | null = null
  private n = 0

  constructor(public behave: (spec: JobSpec, index: number) => Outcome | Promise<Outcome> = (spec) => ({ result: fakeConvert(spec) })) {}

  private emit(event: JobEvent): void {
    this.library?.onJobEvent(event)
  }

  run(spec: JobSpec): string {
    const jobId = `job-${++this.n}`
    const index = this.specs.length
    this.specs.push(spec)
    // Like JobRunner: <dir>/cache/jobs/<id>.json and .log
    const jobsDir = path.join(spec.dir, 'cache', 'jobs')
    mkdirSync(jobsDir, { recursive: true })
    writeFileSync(path.join(jobsDir, `${jobId}.json`), JSON.stringify({ schema: 'mpm.job/1', id: jobId }))
    writeFileSync(path.join(jobsDir, `${jobId}.log`), 'log\n')
    setImmediate(async () => {
      this.emit({ jobId, kind: 'progress', payload: { stage: 'convert', fraction: 0.5, message: '' } })
      const outcome = await this.behave(spec, index)
      if (outcome === 'hold') {
        this.held.add(jobId)
        return
      }
      if ('result' in outcome) this.emit({ jobId, kind: 'result', payload: outcome.result })
      else this.emit({ jobId, kind: 'error', payload: outcome.error })
    })
    return jobId
  }

  cancel(jobId: string): void {
    if (!this.held.delete(jobId)) return
    this.emit({ jobId, kind: 'error', payload: { code: 'E_CANCELLED', message: 'cancelled', detail: {} } })
  }
}

// ---------------------------------------------------------------------------------------------------
// Zip writer (deflate, no zip64): enough for Python's zipfile and the central-directory reader

export function makeZip(entries: { name: string; data: string | Buffer }[]): Buffer {
  const parts: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const data = typeof entry.data === 'string' ? Buffer.from(entry.data) : entry.data
    const packed = zlib.deflateRawSync(data)
    const crc = zlib.crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0x0800, 6) // UTF-8 names
    local.writeUInt16LE(8, 8) // deflate
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(packed.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    parts.push(local, name, packed)
    const header = Buffer.alloc(46)
    header.writeUInt32LE(0x02014b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(20, 6)
    header.writeUInt16LE(0x0800, 8)
    header.writeUInt16LE(8, 10)
    header.writeUInt32LE(crc, 16)
    header.writeUInt32LE(packed.length, 20)
    header.writeUInt32LE(data.length, 24)
    header.writeUInt16LE(name.length, 28)
    header.writeUInt32LE(offset, 42)
    central.push(header, name)
    offset += 30 + name.length + packed.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, directory, end])
}

// ---------------------------------------------------------------------------------------------------
// Synthetic BVH (same skeleton and motion as tests/engine/test_convert.py; Bandai joint names)

const SKEL: [string, string | null, [number, number, number]][] = [
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
const ENDS: Record<string, [number, number, number]> = {
  Head: [0, 20, 0],
  Hand_L: [9, 0, 0],
  Hand_R: [-9, 0, 0],
  Toes_L: [0, 0, 6],
  Toes_R: [0, 0, 6]
}

/** A 60-frame, 30 fps BVH: arms down, then the left arm rises, the hips turn and the left leg lifts. */
export function syntheticBvh(): string {
  const kids = new Map<string | null, string[]>()
  for (const [name, parent] of SKEL) kids.set(parent, [...(kids.get(parent) ?? []), name])
  const offset = new Map(SKEL.map(([name, , o]) => [name, o]))
  const lines = ['HIERARCHY']
  const order: string[] = []
  const emit = (name: string, depth: number) => {
    order.push(name)
    const pad = '  '.repeat(depth)
    lines.push(`${pad}${depth === 0 ? 'ROOT' : 'JOINT'} ${name}`, `${pad}{`, `${pad}  OFFSET ${offset.get(name)!.join(' ')}`)
    lines.push(
      pad +
        '  ' +
        (depth === 0 ? 'CHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation' : 'CHANNELS 3 Zrotation Xrotation Yrotation')
    )
    for (const kid of kids.get(name) ?? []) emit(kid, depth + 1)
    const end = ENDS[name]
    if (end) lines.push(`${pad}  End Site`, `${pad}  {`, `${pad}    OFFSET ${end.join(' ')}`, `${pad}  }`)
    lines.push(`${pad}}`)
  }
  emit('Hips', 0)
  const frames = 60
  lines.push('MOTION', `Frames: ${frames}`, `Frame Time: ${(1 / 30).toFixed(7)}`)
  for (let f = 0; f < frames; f++) {
    const t = Math.max(0, (f - 20) / 39)
    const vals = new Map(order.map((n) => [n, [0, 0, 0]]))
    vals.get('UpperArm_L')![0] = -80 + 140 * t
    vals.get('UpperArm_R')![0] = 80
    vals.get('Hips')![2] = 30 * t
    if (f >= 40) {
      vals.get('UpperLeg_L')![1] = -40
      vals.get('LowerLeg_L')![1] = 60
    }
    const row = [0, 95, 2 * f]
    for (const n of order) row.push(...vals.get(n)!)
    lines.push(row.map((v) => v.toFixed(5)).join(' '))
  }
  return lines.join('\n') + '\n'
}
