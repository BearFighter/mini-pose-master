// SPDX-License-Identifier: GPL-3.0-or-later
// resources/packs.json (docs/contracts.md section 20): zod schema and loader. No Electron APIs here.
import { promises as fs } from 'node:fs'
import { z } from 'zod'
import type { PackEntry } from '../../src/shared/ipc'

/** Pack ids in packs.json. `mine` is reserved for the user's own clips. */
export const PACK_ID_RE = /^[a-z0-9][a-z0-9_-]*$/
/** Downloaded file names: a single path segment. */
export const FILE_NAME_RE = /^[\w.-]+$/
export const MINE_PACK_ID = 'mine'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/**
 * Download URLs must be https. `allowLoopbackHttp` (tests only) also allows http on the loopback
 * interface, where the tests run their local server.
 */
export function isAllowedUrl(url: string, allowLoopbackHttp = false): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol === 'https:') return true
  return allowLoopbackHttp && parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname)
}

const fileName = z
  .string()
  .regex(FILE_NAME_RE, 'must be a plain file name')
  .refine((name) => !/^\.+$/.test(name), 'must be a plain file name')

function packsSchema(allowLoopbackHttp: boolean) {
  const downloadFile = z.object({
    name: fileName,
    url: z.string().refine((url) => isAllowedUrl(url, allowLoopbackHttp), 'must be an https:// URL'),
    sha256: z.string().regex(/^[0-9a-f]{64}$/, 'must be 64 lower-case hex digits'),
    size: z.number().int().positive()
  })
  const download = z.union([
    z.object({ files: z.array(downloadFile).min(1) }),
    z.object({
      user_supplied: z.literal(true),
      accepts: z.array(z.string().min(1)).min(1),
      instructions: z.string().min(1)
    })
  ])
  const pack = z.object({
    id: z.string().regex(PACK_ID_RE).refine((id) => id !== MINE_PACK_ID, `"${MINE_PACK_ID}" is reserved`),
    title: z.string().min(1),
    source: z.string().regex(/^[a-z0-9_]+$/),
    license: z.string().min(1),
    license_url: z.string().min(1),
    nc: z.boolean(),
    exportable: z.boolean(),
    attribution: z.string().min(1).optional(),
    homepage: z.string().min(1).optional(),
    download,
    include: z.array(z.string().min(1)).nullable().optional()
  })
  return z
    .object({
      schema: z.literal('mpm.packs/1'),
      converter_version: z.number().int().positive(),
      packs: z.array(pack)
    })
    .superRefine((file, ctx) => {
      const ids = new Set<string>()
      file.packs.forEach((p, i) => {
        if (ids.has(p.id)) ctx.addIssue({ code: 'custom', path: ['packs', i, 'id'], message: `duplicate pack id ${p.id}` })
        ids.add(p.id)
        // contracts section 9: ND-licensed clip data must never leave the library folder.
        if (/\bND\b/.test(p.license) && p.exportable) {
          ctx.addIssue({ code: 'custom', path: ['packs', i, 'exportable'], message: 'an ND license cannot be exportable' })
        }
        if ('files' in p.download) {
          const names = new Set<string>()
          p.download.files.forEach((f, j) => {
            const key = f.name.toLowerCase()
            if (names.has(key)) {
              ctx.addIssue({ code: 'custom', path: ['packs', i, 'download', 'files', j, 'name'], message: `duplicate file ${f.name}` })
            }
            names.add(key)
          })
        }
      })
    })
}

export type PacksFile = z.infer<ReturnType<typeof packsSchema>>
export type PackDefinition = PacksFile['packs'][number]

// Compile-time check: a validated pack is a PackEntry as the renderer sees it.
const _packIsEntry: (p: PackDefinition) => PackEntry = (p) => p
void _packIsEntry

/** Validates packs.json content. Throws an Error listing the problems. */
export function parsePacks(json: unknown, options: { allowLoopbackHttp?: boolean } = {}): PacksFile {
  const result = packsSchema(options.allowLoopbackHttp ?? false).safeParse(json)
  if (!result.success) throw new Error(`packs.json is invalid:\n${z.prettifyError(result.error)}`)
  return result.data
}

/** Reads and validates a packs.json file. */
export async function loadPacks(file: string): Promise<PacksFile> {
  let json: unknown
  try {
    json = JSON.parse(await fs.readFile(file, 'utf8'))
  } catch (e) {
    throw new Error(`cannot read ${file}: ${(e as Error).message}`)
  }
  return parsePacks(json)
}
