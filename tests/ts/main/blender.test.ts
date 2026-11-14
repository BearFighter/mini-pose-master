// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  archiveSuffix,
  BlenderManager,
  candidatePaths,
  extractArchive,
  isRejected,
  parseBlenderVersion,
  parseIndex,
  parseSha256,
  probe,
  supportedVersion,
  type Candidate,
  type ProbeResult
} from '../../../electron/main/blender'
import { loadSettings, settingsFile } from '../../../electron/main/settings'
import { FIXTURES, removeDir, sleep, tempDir } from './helpers'

const INDEX_HTML = readFileSync(path.join(FIXTURES, 'index.html'), 'utf8')

function lister(listing: Record<string, string[]>) {
  return (dir: string) => listing[dir] ?? []
}

const paths = (candidates: Candidate[]) => candidates.map((c) => c.path)

describe('candidatePaths', () => {
  it('win32: user path, downloaded builds (newest first), Program Files, Steam, PATH', () => {
    const w = path.win32
    const data = 'C:\\Users\\u\\AppData\\Local\\Mini Pose Master'
    const listDirs = lister({
      [w.join(data, 'blender')]: ['5.2.3', '_download', '5.2.4', '5.3.0', 'notes'],
      [w.join(data, 'blender', '5.2.4')]: ['blender-5.2.4-windows-x64'],
      [w.join(data, 'blender', '5.2.3')]: ['blender-5.2.3-windows-x64']
    })
    const env = {
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      // `Path` spelling: Windows env names are case-insensitive.
      Path: [
        'C:\\Tools',
        'C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps',
        '"C:\\Blender 5.2"',
        '',
        'relative\\dir',
        'C:\\Program Files\\Blender Foundation\\Blender 5.2'
      ].join(';')
    }
    const candidates = candidatePaths('win32', env, 'C:\\Users\\u', { userPath: 'D:\\Apps\\Blender\\blender.exe', dataDir: data, listDirs })
    expect(candidates).toEqual([
      { path: 'D:\\Apps\\Blender\\blender.exe', source: 'user' },
      { path: `${data}\\blender\\5.2.4\\blender.exe`, source: 'downloaded' },
      { path: `${data}\\blender\\5.2.4\\blender-5.2.4-windows-x64\\blender.exe`, source: 'downloaded' },
      { path: `${data}\\blender\\5.2.3\\blender.exe`, source: 'downloaded' },
      { path: `${data}\\blender\\5.2.3\\blender-5.2.3-windows-x64\\blender.exe`, source: 'downloaded' },
      { path: 'C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe', source: 'installed' },
      { path: 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Blender\\blender.exe', source: 'installed' },
      { path: 'C:\\Program Files\\Steam\\steamapps\\common\\Blender\\blender.exe', source: 'installed' },
      { path: 'C:\\Tools\\blender.exe', source: 'installed' },
      { path: 'C:\\Blender 5.2\\blender.exe', source: 'installed' }
    ])
  })

  it('win32: rejects blender-launcher.exe and WindowsApps, even as the user path', () => {
    const env = { ProgramFiles: 'C:\\Program Files', PATH: 'C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps' }
    const launcher = candidatePaths('win32', env, 'C:\\Users\\u', {
      userPath: 'C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender-launcher.exe'
    })
    expect(paths(launcher)).not.toContain('C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender-launcher.exe')
    expect(paths(launcher).some((p) => p.toLowerCase().includes('windowsapps'))).toBe(false)
    const store = candidatePaths('win32', env, 'C:\\Users\\u', {
      userPath: 'C:\\Program Files\\WindowsApps\\BlenderFoundation.Blender_5.2\\Blender\\blender.exe'
    })
    expect(store[0].source).toBe('installed')
  })

  it('win32: falls back to the default Program Files folders', () => {
    expect(paths(candidatePaths('win32', {}, 'C:\\Users\\u'))).toEqual([
      'C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe',
      'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Blender\\blender.exe',
      'C:\\Program Files\\Steam\\steamapps\\common\\Blender\\blender.exe'
    ])
  })

  it('darwin: user path, downloaded, /Applications, ~/Applications', () => {
    const data = '/Users/u/Library/Application Support/Mini Pose Master'
    const listDirs = lister({ [`${data}/blender`]: ['5.2.1'] })
    expect(paths(candidatePaths('darwin', { PATH: '/usr/bin' }, '/Users/u', { userPath: '/opt/b/Blender.app/Contents/MacOS/Blender', dataDir: data, listDirs }))).toEqual([
      '/opt/b/Blender.app/Contents/MacOS/Blender',
      `${data}/blender/5.2.1/Blender.app/Contents/MacOS/Blender`,
      '/Applications/Blender.app/Contents/MacOS/Blender',
      '/Users/u/Applications/Blender.app/Contents/MacOS/Blender'
    ])
  })

  it('linux: PATH without snap/flatpak, then ~/blender-5.2*/blender (newest first)', () => {
    const data = '/home/u/.local/share/mini-pose-master'
    const listDirs = lister({
      '/home/u': ['blender-4.5.1-linux-x64', 'blender-5.2.1-linux-x64', 'Documents', 'blender-5.2.4-linux-x64', 'blender-5.20.0'],
      [`${data}/blender`]: ['5.2.2'],
      [`${data}/blender/5.2.2`]: ['blender-5.2.2-linux-x64']
    })
    const env = { PATH: '/usr/local/bin:/snap/bin:/var/lib/flatpak/exports/bin:/home/u/.local/share/flatpak/exports/bin:/usr/bin' }
    expect(candidatePaths('linux', env, '/home/u', { userPath: '/snap/blender/123/blender', dataDir: data, listDirs })).toEqual([
      { path: `${data}/blender/5.2.2/blender`, source: 'downloaded' },
      { path: `${data}/blender/5.2.2/blender-5.2.2-linux-x64/blender`, source: 'downloaded' },
      { path: '/usr/local/bin/blender', source: 'installed' },
      { path: '/usr/bin/blender', source: 'installed' },
      { path: '/home/u/blender-5.2.4-linux-x64/blender', source: 'installed' },
      { path: '/home/u/blender-5.2.1-linux-x64/blender', source: 'installed' }
    ])
  })
})

describe('isRejected', () => {
  it('applies the section 19 rules', () => {
    expect(isRejected('C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender-launcher.exe')).toBe(true)
    expect(isRejected('C:\\Program Files\\Blender Foundation\\Blender 5.2\\Blender-Launcher.EXE')).toBe(true)
    expect(isRejected('C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\blender.exe')).toBe(true)
    expect(isRejected('/snap/bin/blender')).toBe(true)
    expect(isRejected('/var/lib/flatpak/exports/bin/org.blender.Blender')).toBe(true)
    expect(isRejected('C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe')).toBe(false)
    expect(isRejected('/home/u/blender-5.2.4-linux-x64/blender')).toBe(false)
    expect(isRejected('/Applications/Blender.app/Contents/MacOS/Blender')).toBe(false)
  })
})

describe('version check', () => {
  it('accepts Blender 5.2.N only', () => {
    expect(supportedVersion('Blender 5.2.4')).toBe('5.2.4')
    expect(supportedVersion('Blender 5.2.0 LTS\n\tbuild date: 2026-07-14\n')).toBe('5.2.0')
    expect(supportedVersion('\r\nBlender 5.2.11\r\n')).toBe('5.2.11')
    expect(supportedVersion('Blender 4.5.1')).toBeNull()
    expect(supportedVersion('Blender 5.3.0')).toBeNull()
    expect(supportedVersion('Blender 5.20.1')).toBeNull()
    expect(supportedVersion('Warning: something\nBlender 5.2.1')).toBeNull()
    expect(supportedVersion('v24.11.0')).toBeNull()
    expect(supportedVersion('')).toBeNull()
  })

  it('parses any version for error messages', () => {
    expect(parseBlenderVersion('Blender 4.5.1 LTS')).toEqual({ major: 4, minor: 5, patch: 1, version: '4.5.1' })
  })

  it('probe rejects an executable that is not Blender', async () => {
    const result: ProbeResult = await probe(process.execPath)
    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
  })
})

describe('parseIndex', () => {
  it('picks 5.2.4 per platform from the release listing', () => {
    expect(parseIndex(INDEX_HTML, 'win32', 'x64')).toEqual({ version: '5.2.4', file: 'blender-5.2.4-windows-x64.zip' })
    expect(parseIndex(INDEX_HTML, 'darwin', 'arm64')).toEqual({ version: '5.2.4', file: 'blender-5.2.4-macos-arm64.dmg' })
    expect(parseIndex(INDEX_HTML, 'linux', 'x64')).toEqual({ version: '5.2.4', file: 'blender-5.2.4-linux-x64.tar.xz' })
  })

  it('has nothing for platforms without a 5.2 build', () => {
    expect(parseIndex(INDEX_HTML, 'darwin', 'x64')).toBeNull()
    expect(parseIndex(INDEX_HTML, 'linux', 'arm64')).toBeNull()
    expect(archiveSuffix('darwin', 'x64')).toBeNull()
  })

  it('takes the highest patch that has this platform, comparing numerically', () => {
    const html = [
      '<a href="blender-5.2.9-windows-x64.zip">x</a>',
      '<a href="blender-5.2.10-windows-x64.zip">x</a>',
      '<a href="blender-5.2.11-linux-x64.tar.xz">x</a>',
      '<a href="blender-5.2.12-windows-x64.msi">x</a>',
      '<a href="blender-5.2.13-windows-x64.zip.sha256">x</a>',
      '<a href="blender-5.20.0-windows-x64.zip">x</a>',
      "<a href='/release/Blender5.2/blender-5.2.8-linux-x64.tar.xz'>x</a>"
    ].join('\n')
    expect(parseIndex(html, 'win32', 'x64')).toEqual({ version: '5.2.10', file: 'blender-5.2.10-windows-x64.zip' })
    expect(parseIndex(html, 'linux', 'x64')).toEqual({ version: '5.2.11', file: 'blender-5.2.11-linux-x64.tar.xz' })
    expect(parseIndex(html, 'darwin', 'arm64')).toBeNull()
  })
})

describe('parseSha256', () => {
  const a = 'a'.repeat(64)
  const b = '0123456789abcdef'.repeat(4)
  const c = 'C0FFEE00'.repeat(8)
  const text = [
    `${a}  blender-5.2.4-linux-x64.tar.xz`,
    `${b}  blender-5.2.4-macos-arm64.dmg`,
    `${c} *blender-5.2.4-windows-x64.zip\r`,
    ''
  ].join('\n')

  it('finds the line for the file', () => {
    expect(parseSha256(text, 'blender-5.2.4-linux-x64.tar.xz')).toBe(a)
    expect(parseSha256(text, 'blender-5.2.4-macos-arm64.dmg')).toBe(b)
    expect(parseSha256(text, 'blender-5.2.4-windows-x64.zip')).toBe(c.toLowerCase())
  })

  it('returns null for a missing file or a broken line', () => {
    expect(parseSha256(text, 'blender-5.2.4-windows-x64.msi')).toBeNull()
    expect(parseSha256('abc  blender-5.2.4-linux-x64.tar.xz', 'blender-5.2.4-linux-x64.tar.xz')).toBeNull()
  })

  it('reads the BSD format too', () => {
    expect(parseSha256(`SHA256 (blender-5.2.4-linux-x64.tar.xz) = ${a}`, 'blender-5.2.4-linux-x64.tar.xz')).toBe(a)
  })
})

// ---------------------------------------------------------------------------------------------------
// BlenderManager with injected fetch / extract / probe (no network, no real Blender)

const HOST_SUFFIX = archiveSuffix(process.platform, process.arch)
const RELEASE = 'https://example.invalid/release/Blender5.2/'

function binaryLayout(dest: string, version: string): string {
  if (process.platform === 'darwin') return path.join(dest, 'Blender.app', 'Contents', 'MacOS', 'Blender')
  const folder = `blender-${version}-${HOST_SUFFIX!.replace(/\.(zip|tar\.xz)$/, '')}`
  return path.join(dest, folder, process.platform === 'win32' ? 'blender.exe' : 'blender')
}

function fakeFetch(files: Record<string, string | Uint8Array>, opts: { chunk?: number; delayMs?: number } = {}) {
  const calls: string[] = []
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    calls.push(url)
    init?.signal?.throwIfAborted()
    const body = files[url.slice(RELEASE.length)]
    if (body === undefined) return new Response('not found', { status: 404 })
    if (typeof body === 'string') return new Response(body, { status: 200 })
    const chunk = opts.chunk ?? 64 * 1024
    let offset = 0
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (opts.delayMs) await sleep(opts.delayMs)
        if (offset >= body.length) return controller.close()
        controller.enqueue(body.slice(offset, offset + chunk))
        offset += chunk
      }
    })
    return new Response(stream, { status: 200, headers: { 'content-length': String(body.length) } })
  }
  return { impl: impl as typeof fetch, calls }
}

describe.skipIf(HOST_SUFFIX === null)('BlenderManager.download (injected network)', () => {
  let dataDir: string
  const archiveName = `blender-5.2.4-${HOST_SUFFIX}`
  const archive = new Uint8Array(Buffer.from('fake blender archive ' + 'x'.repeat(300_000)))
  const sha = createHash('sha256').update(archive).digest('hex')
  const shaFile = (hex: string) => [`${'1'.repeat(64)}  blender-5.2.4-other.zip`, `${hex}  ${archiveName}`].join('\n')
  let extracted: string[]

  beforeEach(() => {
    dataDir = tempDir('blender')
    extracted = []
  })
  afterEach(() => removeDir(dataDir))

  function manager(fetchImpl: typeof fetch, extra: { freeBytes?: number } = {}) {
    return new BlenderManager({
      dataDir,
      releaseUrl: RELEASE,
      fetch: fetchImpl,
      freeBytes: async () => extra.freeBytes ?? 100 * 1024 ** 3,
      extract: async (file, dest) => {
        expect(readFileSync(file)).toEqual(Buffer.from(archive))
        extracted.push(dest)
        const binary = binaryLayout(dest, '5.2.4')
        mkdirSync(path.dirname(binary), { recursive: true })
        writeFileSync(binary, 'not really blender')
      },
      probe: async (binary) =>
        binary.startsWith(path.join(dataDir, 'blender', '5.2.4')) ? { ok: true, version: '5.2.4' } : { ok: false, error: 'not Blender' }
    })
  }

  it('downloads, verifies, extracts, probes and saves the newest 5.2.N', async () => {
    const net = fakeFetch({ '': INDEX_HTML, 'blender-5.2.4.sha256': shaFile(sha), [archiveName]: archive })
    const m = manager(net.impl)
    const progress: { bytes: number; total: number }[] = []
    const status = await m.download((p) => progress.push(p), new AbortController().signal)

    const binary = binaryLayout(path.join(dataDir, 'blender', '5.2.4'), '5.2.4')
    expect(status).toEqual({ found: true, path: binary, version: '5.2.4', source: 'downloaded' })
    expect(net.calls).toEqual([RELEASE, `${RELEASE}blender-5.2.4.sha256`, `${RELEASE}${archiveName}`])
    expect(extracted).toEqual([path.join(dataDir, 'blender', '5.2.4')])
    expect(progress.length).toBeGreaterThanOrEqual(1)
    expect(progress[progress.length - 1]).toEqual({ bytes: archive.length, total: archive.length })
    for (let i = 1; i < progress.length; i++) expect(progress[i].bytes).toBeGreaterThanOrEqual(progress[i - 1].bytes)
    expect(await loadSettings(settingsFile(dataDir))).toEqual({ blenderPath: binary })
    expect(existsSync(path.join(dataDir, 'blender', '_download'))).toBe(false)

    // Detection now finds it as the user path, reported as downloaded.
    expect(await m.status()).toEqual(status)
    expect(await m.requirePath()).toBe(binary)
  })

  it('rejects a checksum mismatch and removes the files', async () => {
    const net = fakeFetch({ '': INDEX_HTML, 'blender-5.2.4.sha256': shaFile('f'.repeat(64)), [archiveName]: archive })
    await expect(manager(net.impl).download(() => {}, new AbortController().signal)).rejects.toThrow(/SHA-256/)
    expect(extracted).toEqual([])
    expect(existsSync(path.join(dataDir, 'blender', '_download'))).toBe(false)
    expect(existsSync(path.join(dataDir, 'blender', '5.2.4'))).toBe(false)
    expect(await loadSettings(settingsFile(dataDir))).toEqual({})
  })

  it('needs 2.5 GB of free space before downloading anything', async () => {
    const net = fakeFetch({ '': INDEX_HTML })
    await expect(manager(net.impl, { freeBytes: 1024 ** 3 }).download(() => {}, new AbortController().signal)).rejects.toThrow(/2\.5 GB/)
    expect(net.calls).toEqual([])
  })

  it('cancel stops the transfer and removes the partial files', async () => {
    const net = fakeFetch(
      { '': INDEX_HTML, 'blender-5.2.4.sha256': shaFile(sha), [archiveName]: archive },
      { chunk: 1000, delayMs: 10 }
    )
    const controller = new AbortController()
    let sawProgress = false
    const pending = manager(net.impl).download(() => {
      if (!sawProgress) {
        sawProgress = true
        controller.abort()
      }
    }, controller.signal)
    await expect(pending).rejects.toThrow(/cancelled/)
    expect(sawProgress).toBe(true)
    expect(extracted).toEqual([])
    expect(existsSync(path.join(dataDir, 'blender', '_download'))).toBe(false)
    expect(await loadSettings(settingsFile(dataDir))).toEqual({})
  })

  it('reports a missing build for the platform', async () => {
    const net = fakeFetch({ '': '<a href="blender-5.2.4-macos-x64.dmg">x</a>' })
    await expect(manager(net.impl).download(() => {}, new AbortController().signal)).rejects.toThrow(/No Blender 5\.2/)
  })
})

describe('BlenderManager platform rules and setPath', () => {
  let dir: string
  beforeEach(() => {
    dir = tempDir('blender-set')
  })
  afterEach(() => removeDir(dir))

  it('macOS x64 gets a clear "no Intel Mac build" error', async () => {
    const m = new BlenderManager({ dataDir: dir, platform: 'darwin', arch: 'x64', fetch: fakeFetch({}).impl })
    await expect(m.download(() => {}, new AbortController().signal)).rejects.toThrow(/no Intel Mac build/)
  })

  it('setPath probes, saves and reports; bad paths throw and change nothing', async () => {
    const good = path.join(dir, 'installed', 'blender.exe')
    const old = path.join(dir, 'old', 'blender.exe')
    for (const file of [good, old]) {
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, '')
    }
    const m = new BlenderManager({
      dataDir: path.join(dir, 'data'),
      probe: async (binary) =>
        binary === good ? { ok: true, version: '5.2.3' } : { ok: false, version: '4.5.1', error: 'Blender 4.5.1 found, but Blender 5.2 is required' }
    })
    const file = settingsFile(path.join(dir, 'data'))

    expect(await m.setPath(good)).toEqual({ found: true, path: good, version: '5.2.3', source: 'installed' })
    expect(await loadSettings(file)).toEqual({ blenderPath: good })

    await expect(m.setPath(old)).rejects.toThrow(/4\.5\.1/)
    await expect(m.setPath(path.join(dir, 'missing.exe'))).rejects.toThrow(/No file/)
    await expect(m.setPath(path.join(dir, 'installed', 'blender-launcher.exe'))).rejects.toThrow(/blender-launcher/)
    expect(await loadSettings(file)).toEqual({ blenderPath: good })

    await m.setPath('')
    expect(await loadSettings(file)).toEqual({})
  })
})

// ---------------------------------------------------------------------------------------------------
// Real extraction with the system tools (macOS needs a .dmg, so it is not covered here)

describe.skipIf(!['win32', 'linux'].includes(process.platform))('extractArchive with the system tar', () => {
  let dir: string
  beforeEach(() => {
    dir = tempDir('extract')
  })
  afterEach(() => removeDir(dir))

  it('unpacks the platform archive format', async () => {
    const win = process.platform === 'win32'
    const folder = win ? 'blender-5.2.4-windows-x64' : 'blender-5.2.4-linux-x64'
    const exe = win ? 'blender.exe' : 'blender'
    const src = path.join(dir, 'src')
    mkdirSync(path.join(src, folder, '5.2', 'scripts'), { recursive: true })
    writeFileSync(path.join(src, folder, exe), 'binary')
    writeFileSync(path.join(src, folder, '5.2', 'scripts', 'x.py'), 'print(1)')
    const archive = path.join(dir, win ? `${folder}.zip` : `${folder}.tar.xz`)
    if (win) {
      const tar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
      execFileSync(tar, ['-a', '-c', '-f', archive, '-C', src, folder])
    } else {
      execFileSync('tar', ['-cJf', archive, '-C', src, folder])
    }
    const dest = path.join(dir, 'out', '5.2.4')
    await extractArchive(archive, dest)
    expect(readFileSync(path.join(dest, folder, exe), 'utf8')).toBe('binary')
    expect(readFileSync(path.join(dest, folder, '5.2', 'scripts', 'x.py'), 'utf8')).toBe('print(1)')
  })

  it('fails clearly on a broken archive', async () => {
    const archive = path.join(dir, process.platform === 'win32' ? 'broken.zip' : 'broken.tar.xz')
    writeFileSync(archive, 'this is not an archive')
    await expect(extractArchive(archive, path.join(dir, 'out'))).rejects.toThrow(/Extracting/)
  })
})
