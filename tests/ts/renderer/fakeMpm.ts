// SPDX-License-Identifier: GPL-3.0-or-later
// An in-memory window.mpm for renderer tests: projects live in a Map, jobs answer with scripted events.
import type { JobEvent, MpmApi, MpmEventName, MpmEventPayloads } from '../../../src/shared/ipc'

type Listener = (payload: unknown) => void

export interface ScriptedJob {
  /** Events to emit (jobId filled in), in order, after job.run has answered. */
  events: Omit<JobEvent, 'jobId'>[]
  /** Emit the events before job.run's promise resolves (tests the early-event buffer). */
  early?: boolean
}

export class FakeMpm {
  readonly projects = new Map<string, unknown>()
  readonly saves: { dir: string; project: unknown }[] = []
  readonly runs: { dir: string; type: string; args: Record<string, unknown> }[] = []
  readonly cancelled: string[] = []
  private listeners = new Map<string, Set<Listener>>()
  private scripts: Record<string, ScriptedJob> = {}
  private nextJob = 1
  /** Makes job.run reject with this message. */
  runError: string | null = null

  script(type: string, job: ScriptedJob): void {
    this.scripts[type] = job
  }

  listenerCount(event: MpmEventName): number {
    return this.listeners.get(event)?.size ?? 0
  }

  emit<E extends MpmEventName>(event: E, payload: MpmEventPayloads[E]): void {
    for (const cb of [...(this.listeners.get(event) ?? [])]) cb(payload)
  }

  readonly api: MpmApi = {
    app: {
      info: async () => ({ version: '0.0.1', platform: 'win32', arch: 'x64', dataDir: 'C:/data' }),
      checkUpdate: async () => ({ available: false }),
      installUpdate: async () => {}
    },
    blender: {
      status: async () => ({ found: true, path: 'C:/blender.exe', version: '5.2.0', source: 'installed' as const }),
      setPath: async () => ({ found: true, path: 'C:/blender.exe', version: '5.2.0', source: 'installed' as const }),
      download: async () => ({ found: true, path: 'C:/blender.exe', version: '5.2.0', source: 'downloaded' as const }),
      cancelDownload: async () => {}
    },
    dialog: {
      openFile: async () => null,
      openFiles: async () => [],
      openFolder: async () => null,
      saveFile: async () => null
    },
    project: {
      create: async ({ name, parentDir }) => {
        const dir = `${parentDir}/${name}`
        if (this.projects.has(dir)) throw new Error(`Error invoking remote method 'mpm:project.create': Error: "${name}" already exists`)
        const project = {
          schemaVersion: 1,
          app: 'Mini Pose Master',
          appVersion: '0.0.1',
          source: null,
          rig: null,
          pose: null,
          hands: null,
          weapons: [],
          bake: null
        }
        this.projects.set(dir, JSON.stringify(project))
        return { dir, project: JSON.parse(JSON.stringify(project)) }
      },
      open: async (path) => {
        const raw = this.projects.get(path)
        if (typeof raw !== 'string') throw new Error(`Error invoking remote method 'mpm:project.open': Error: No project at ${path}`)
        return { dir: path, project: JSON.parse(raw) }
      },
      save: async ({ dir, project }) => {
        this.saves.push({ dir, project })
        this.projects.set(dir, JSON.stringify(project))
      },
      importModel: async ({ dir, file }) => {
        const project = JSON.parse(String(this.projects.get(dir)))
        const name = file.split(/[\\/]/).pop()
        project.source = { file: `source/${name}`, orientation: null }
        project.rig = null
        this.projects.set(dir, JSON.stringify(project))
        return { copied: [`source/${name}`], skipped: [], project }
      },
      addWeapon: async () => ({ weaponFile: 'weapons/x/x.glb', copied: ['weapons/x/x.glb'], skipped: [] })
    },
    job: {
      run: async ({ dir, type, args }) => {
        if (this.runError) throw new Error(`Error invoking remote method 'mpm:job.run': Error: ${this.runError}`)
        this.runs.push({ dir, type, args })
        const jobId = `job-${this.nextJob++}`
        const script = this.scripts[type] ?? { events: [{ kind: 'result', payload: {} }] }
        const fire = () => {
          for (const e of script.events) this.emit('job:event', { ...e, jobId } as JobEvent)
        }
        if (script.early) fire()
        else setTimeout(fire, 0)
        return { jobId }
      },
      cancel: async (jobId) => {
        this.cancelled.push(jobId)
      }
    },
    library: {
      list: async () => [],
      install: async () => ({ clips: 0, failed: [] }),
      installFromFile: async () => ({ clips: 0, failed: [] }),
      reconvert: async () => ({ clips: 0, failed: [] }),
      importClip: async () => ({ packId: 'mine', clipIds: [] }),
      cancel: async () => {},
      remove: async () => {},
      saveThumb: async () => {}
    },
    shell: {
      showItemInFolder: async () => {}
    },
    on: (event, cb) => {
      const set = this.listeners.get(event) ?? new Set<Listener>()
      set.add(cb as Listener)
      this.listeners.set(event, set)
      return () => {
        set.delete(cb as Listener)
      }
    }
  }
}

/** Installs a fresh fake as window.mpm and returns it. */
export function installFakeMpm(): FakeMpm {
  const fake = new FakeMpm()
  ;(globalThis as unknown as { window: { mpm: MpmApi } }).window = { mpm: fake.api }
  return fake
}
