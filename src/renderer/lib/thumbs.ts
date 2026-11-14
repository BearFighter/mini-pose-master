// SPDX-License-Identifier: GPL-3.0-or-later
// Clip thumbnails: rows first try to load thumbs/<clip>_<frame>.png; only on failure do they ask this
// queue, which makes the missing ones lazily and one at a time, only for rows still in view.
export interface ThumbJob {
  packId: string
  clipId: string
  frame: number
}

export interface ThumbDeps {
  /** Renders the stick figure of one clip frame as PNG bytes. */
  render(job: ThumbJob): Promise<Uint8Array>
  /** Stores the PNG (library.saveThumb). */
  save(job: ThumbJob, png: Uint8Array): Promise<void>
}

type Listener = (ok: boolean) => void

const keyOf = (j: ThumbJob): string => `${j.packId}/${j.clipId}/${j.frame}`

export class ThumbQueue {
  /** Requested and not started, in request order; rows that leave the view are removed. */
  private readonly waiting = new Map<string, { job: ThumbJob; listeners: Set<Listener> }>()
  private readonly done = new Set<string>()
  private readonly failed = new Set<string>()
  private current: { key: string; listeners: Set<Listener> } | null = null
  private running: Promise<void> | null = null

  constructor(private readonly deps: ThumbDeps) {}

  /**
   * Asks for a thumbnail. `onDone(true)` once it exists (made by this queue), `onDone(false)` when it
   * could not be made. Returns a function that withdraws the request (the row left the view).
   */
  request(job: ThumbJob, onDone: Listener): () => void {
    const key = keyOf(job)
    if (this.done.has(key)) {
      onDone(true)
      return () => {}
    }
    if (this.failed.has(key)) {
      onDone(false)
      return () => {}
    }
    if (this.current?.key === key) {
      this.current.listeners.add(onDone)
      return () => this.current?.listeners.delete(onDone)
    }
    const entry = this.waiting.get(key) ?? { job, listeners: new Set<Listener>() }
    entry.listeners.add(onDone)
    this.waiting.set(key, entry)
    this.pump()
    return () => {
      const e = this.waiting.get(key)
      if (!e) return
      e.listeners.delete(onDone)
      if (e.listeners.size === 0) this.waiting.delete(key)
    }
  }

  /** Number of requests not started yet. */
  get pending(): number {
    return this.waiting.size
  }

  /** Resolves when the queue has nothing left to do (tests). */
  async whenIdle(): Promise<void> {
    while (this.running) await this.running
  }

  private pump(): void {
    if (this.current) return
    const next = this.waiting.entries().next()
    if (next.done) return
    const [key, { job, listeners }] = next.value
    this.waiting.delete(key)
    this.current = { key, listeners }
    this.running = (async () => {
      let ok = false
      try {
        const png = await this.deps.render(job)
        await this.deps.save(job, png)
        ok = true
      } catch {
        ok = false
      }
      ;(ok ? this.done : this.failed).add(key)
      const ls = this.current?.listeners ?? new Set<Listener>()
      this.current = null
      this.running = null
      for (const l of ls) l(ok)
      this.pump()
    })()
  }
}
