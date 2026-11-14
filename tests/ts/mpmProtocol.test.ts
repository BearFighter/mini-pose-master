// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { resolveMpmUrl, withCors, type MpmRoots } from '../../electron/main/mpmProtocol'

const PROJECT = path.resolve('fixture-root', 'project')
const LIBRARY = path.resolve('fixture-root', 'library')
const roots: MpmRoots = { project: PROJECT, library: LIBRARY }

describe('resolveMpmUrl', () => {
  it('resolves a path inside the project root', () => {
    const url = 'mpm://project/' + encodeURIComponent('models/hero.png')
    expect(resolveMpmUrl(url, roots)).toBe(path.join(PROJECT, 'models', 'hero.png'))
  })

  it('rejects raw .. traversal', () => {
    expect(resolveMpmUrl('mpm://project/../secret.txt', roots)).toBeNull()
    expect(resolveMpmUrl('mpm://project/models/../../secret.txt', roots)).toBeNull()
  })

  it('rejects %2e%2e traversal', () => {
    expect(resolveMpmUrl('mpm://project/%2e%2e/secret.txt', roots)).toBeNull()
    expect(resolveMpmUrl('mpm://project/%2e%2e%2fsecret.txt', roots)).toBeNull()
  })

  it('returns null when the project root is null', () => {
    expect(resolveMpmUrl('mpm://project/hero.png', { project: null, library: LIBRARY })).toBeNull()
  })

  it('rejects absolute paths in the URL', () => {
    expect(resolveMpmUrl('mpm://project/' + encodeURIComponent(path.resolve('/etc/passwd')), roots)).toBeNull()
    expect(resolveMpmUrl('mpm://project/' + encodeURIComponent('/etc/passwd'), roots)).toBeNull()
  })

  it('ignores a cache-busting query and a fragment', () => {
    expect(resolveMpmUrl('mpm://project/rig/preview.glb?v=12', roots)).toBe(path.join(PROJECT, 'rig', 'preview.glb'))
    expect(resolveMpmUrl('mpm://project/' + encodeURIComponent('rig/rig.json') + '?v=3#x', roots)).toBe(
      path.join(PROJECT, 'rig', 'rig.json')
    )
    expect(resolveMpmUrl('mpm://project/' + encodeURIComponent('a?b.png'), roots)).toBe(path.join(PROJECT, 'a?b.png'))
    expect(resolveMpmUrl('mpm://project/..?v=1', roots)).toBeNull()
  })

  it('resolves library and project roots independently', () => {
    const lib = 'mpm://library/' + encodeURIComponent('packs/a/index.json')
    expect(resolveMpmUrl(lib, roots)).toBe(path.join(LIBRARY, 'packs', 'a', 'index.json'))
    expect(resolveMpmUrl(lib, { project: PROJECT, library: LIBRARY })).toBe(path.join(LIBRARY, 'packs', 'a', 'index.json'))
    expect(resolveMpmUrl('mpm://project/packs/a/index.json', { project: null, library: LIBRARY })).toBeNull()
    expect(resolveMpmUrl('mpm://library/x.png', { project: PROJECT, library: LIBRARY })).toBe(path.join(LIBRARY, 'x.png'))
  })
})

describe('withCors', () => {
  it('adds Access-Control-Allow-Origin and keeps status, headers and body', async () => {
    const res = withCors(new Response('hello', { status: 200, headers: { 'Content-Type': 'text/plain' } }))
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(res.headers.get('Content-Type')).toBe('text/plain')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('hello')
  })
})
