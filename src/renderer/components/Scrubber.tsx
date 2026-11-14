// SPDX-License-Identifier: GPL-3.0-or-later
// Frame scrubber for the selected clip: slider with key-frame ticks, key/step buttons, play (preview
// only, committed on pause), foot contacts and "Plant feet". Dragging previews; release commits.
import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { commitFrame, previewFrame, setPlanted } from '../store/poseActions'

const FPS = 15

/** The next / previous key frame from `frame` (wrapping to the ends). */
export function nextKey(keys: number[], frame: number, dir: 1 | -1, frames: number): number {
  const sorted = [...keys].sort((a, b) => a - b)
  if (dir > 0) return sorted.find((k) => k > frame) ?? frames - 1
  return [...sorted].reverse().find((k) => k < frame) ?? 0
}

export function Scrubber() {
  const source = useStore((s) => s.poseInputs.source)
  const planted = useStore((s) => s.poseInputs.planted)
  const clip = useStore((s) => s.loadedClip)
  const previewF = useStore((s) => s.posePreview?.frame)
  const [playing, setPlaying] = useState(false)
  const playFrame = useRef(0)

  const ready = !!source && !!clip && clip.packId === source.pack && clip.clipId === source.clip
  const frames = ready ? clip.frames : 0
  const frame = previewF ?? source?.frame ?? 0
  const keys = ready ? clip.entry.key_frames ?? [] : []

  // Play loops at 15 fps as a preview; pausing commits the frame shown.
  useEffect(() => {
    if (!playing || !ready) return
    playFrame.current = frame
    const timer = setInterval(() => {
      playFrame.current = (playFrame.current + 1) % frames
      previewFrame(playFrame.current)
    }, 1000 / FPS)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, ready, frames])

  if (!ready) return null
  const contacts = clip.frame(Math.min(frames - 1, Math.max(0, frame))).contacts

  const go = (f: number) => {
    setPlaying(false)
    commitFrame(Math.max(0, Math.min(frames - 1, f)))
  }
  const togglePlay = () => {
    if (playing) {
      setPlaying(false)
      commitFrame(playFrame.current)
    } else setPlaying(true)
  }

  return (
    <div className="scrubber" onKeyDown={(e) => e.stopPropagation()}>
      <div className="scrub-buttons">
        <button title="Previous key frame" onClick={() => go(nextKey(keys, frame, -1, frames))}>
          ⏮
        </button>
        <button title="Previous frame" onClick={() => go(frame - 1)}>
          ◀
        </button>
        <button title={playing ? 'Pause' : 'Play'} onClick={togglePlay} className={playing ? 'on' : ''}>
          {playing ? '⏸' : '▶'}
        </button>
        <button title="Next frame" onClick={() => go(frame + 1)}>
          ▶|
        </button>
        <button title="Next key frame" onClick={() => go(nextKey(keys, frame, 1, frames))}>
          ⏭
        </button>
      </div>
      <div className="scrub-track">
        <input
          type="range"
          min={0}
          max={Math.max(0, frames - 1)}
          step={1}
          value={frame}
          aria-label="Frame"
          onChange={(e) => {
            setPlaying(false)
            previewFrame(Number(e.target.value))
          }}
          onPointerUp={(e) => commitFrame(Number((e.target as HTMLInputElement).value))}
          onKeyUp={(e) => {
            if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End' || e.key.startsWith('Page')) {
              commitFrame(Number((e.target as HTMLInputElement).value))
            }
          }}
        />
        <div className="ticks">
          {keys.map((k) => (
            <span key={k} className="tick" style={{ left: `${frames > 1 ? (k / (frames - 1)) * 100 : 0}%` }} />
          ))}
        </div>
      </div>
      <span className="scrub-frame">
        {frame} / {frames - 1}
      </span>
      <span className="contacts" title="Feet on the floor in this frame">
        <span className={contacts.L ? 'foot on' : 'foot'}>L</span>
        <span className={contacts.R ? 'foot on' : 'foot'}>R</span>
      </span>
      <label className="toggle-line">
        <input type="checkbox" checked={planted} onChange={(e) => setPlanted(e.target.checked)} /> Plant feet
      </label>
    </div>
  )
}
