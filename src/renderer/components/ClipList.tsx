// SPDX-License-Identifier: GPL-3.0-or-later
// The selected pack's clips: search over id/move/style/tags, tag chips, rows with a thumbnail,
// virtualised above 200 rows. Thumbnails are loaded from the library first and made only if missing.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { PackClip } from '../../shared/clip'
import { allTags, filterClips, thumbFrame, thumbUrl, visibleRange } from '../lib/clips'
import { useStore } from '../store'
import { fire } from '../store/flow'
import { selectClip } from '../store/poseActions'
import { thumbQueue } from '../viewer/thumbService'
import { IconSearch } from './icons'

export const VIRTUALIZE_ABOVE = 200
const ROW_HEIGHT = 56
const TAG_CHIPS = 12

function Thumb({ packId, clip, version }: { packId: string; clip: PackClip; version: number }) {
  const frame = thumbFrame(clip)
  const [src, setSrc] = useState(() => thumbUrl(packId, clip.id, frame, version))
  const [state, setState] = useState<'try' | 'making' | 'none'>('try')
  const withdraw = useRef<(() => void) | null>(null)

  useEffect(() => () => withdraw.current?.(), [])

  const onError = () => {
    if (state !== 'try') {
      setState('none')
      return
    }
    setState('making')
    withdraw.current = thumbQueue.request({ packId, clipId: clip.id, frame }, (ok) => {
      withdraw.current = null
      if (ok) {
        setState('try')
        setSrc(thumbUrl(packId, clip.id, frame, Date.now()))
      } else setState('none')
    })
  }

  if (state === 'none') return <div className="thumb empty" />
  return <img className={state === 'making' ? 'thumb making' : 'thumb'} src={src} alt="" onError={onError} draggable={false} />
}

function ClipRow({ packId, clip, active, version }: { packId: string; clip: PackClip; active: boolean; version: number }) {
  const busy = useStore((s) => s.loadingClip === `${packId}/${clip.id}`)
  return (
    <button className={active ? 'clip-row active' : 'clip-row'} onClick={() => fire(selectClip(packId, clip.id))} title={clip.id} style={{ height: ROW_HEIGHT }}>
      <Thumb packId={packId} clip={clip} version={version} />
      <span className="clip-text">
        <span className="clip-move">
          {clip.move || clip.id}
          {clip.style ? <span className="muted"> · {clip.style}</span> : null}
        </span>
        <span className="muted small">
          {clip.frames} frames{busy ? ' · loading…' : ''}
        </span>
      </span>
    </button>
  )
}

export function ClipList() {
  const packId = useStore((s) => s.selectedPack)
  const index = useStore((s) => s.packIndex)
  const text = useStore((s) => s.clipText)
  const tags = useStore((s) => s.clipTags)
  const version = useStore((s) => s.libraryVersion)
  const source = useStore((s) => s.poseInputs.source)
  const setClipFilter = useStore((s) => s.setClipFilter)
  const toggleClipTag = useStore((s) => s.toggleClipTag)
  const scroller = useRef<HTMLDivElement>(null)
  const [scroll, setScroll] = useState({ top: 0, height: 400 })

  const clips = useMemo(() => (index ? filterClips(index.clips, text, tags) : []), [index, text, tags])
  const tagList = useMemo(() => (index ? allTags(index.clips).slice(0, TAG_CHIPS) : []), [index])
  const virtual = clips.length > VIRTUALIZE_ABOVE

  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const update = () => setScroll({ top: el.scrollTop, height: el.clientHeight })
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [index])

  if (!packId) return <p className="muted small pad">Choose an installed pack to see its clips.</p>
  if (!index) return <p className="muted small pad">Loading the clips…</p>

  const [first, last] = virtual ? visibleRange(scroll.top, scroll.height, ROW_HEIGHT, clips.length) : [0, clips.length]
  const isActive = (c: PackClip) => source?.pack === packId && source.clip === c.id

  return (
    <div className="clip-list">
      <div className="search-field clip-search">
        <IconSearch size={14} />
        <input
          type="search"
          placeholder={`Search ${index.clips.length} clips`}
          value={text}
          onChange={(e) => setClipFilter(e.target.value)}
        />
      </div>
      {tagList.length > 0 && (
        <div className="chips">
          {tagList.map((t) => (
            <button key={t} className={tags.includes(t) ? 'chip on' : 'chip'} onClick={() => toggleClipTag(t)}>
              {t}
            </button>
          ))}
        </div>
      )}
      <div className="clip-scroller" ref={scroller} onScroll={(e) => setScroll({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })}>
        {clips.length === 0 ? (
          <p className="muted small pad">No clip matches.</p>
        ) : virtual ? (
          <div style={{ height: clips.length * ROW_HEIGHT, position: 'relative' }}>
            {clips.slice(first, last).map((c, k) => (
              <div key={c.id} style={{ position: 'absolute', top: (first + k) * ROW_HEIGHT, left: 0, right: 0 }}>
                <ClipRow packId={packId} clip={c} active={isActive(c)} version={version} />
              </div>
            ))}
          </div>
        ) : (
          clips.map((c) => <ClipRow key={c.id} packId={packId} clip={c} active={isActive(c)} version={version} />)
        )}
      </div>
    </div>
  )
}
