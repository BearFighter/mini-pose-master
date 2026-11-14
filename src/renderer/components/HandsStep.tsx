// SPDX-License-Identifier: GPL-3.0-or-later
// Hands step: per side a preset, finger sliders (flex x3, spread, thumb roll; live preview, one undo step
// on release), keep (locked) per finger, copy / reset, and auto-grip onto the weapon that hand holds.
import { useState } from 'react'
import { vecB2T } from '../../shared/coords'
import type { FingerName, FingerPose, HandPose } from '../../shared/handPose'
import { FINGERS } from '../../shared/handPose'
import { MAX_FLEX } from '../lib/autoGrip'
import { cloneHand, FLEX_RANGE, HAND_PRESETS, handFromPreset, presetByName, ROLL_RANGE, SPREAD_RANGE, withFinger } from '../lib/hands'
import { useStore } from '../store'
import { fire } from '../store/flow'
import { choosePreset, commitHand, copyHandSide, previewHand, resetHand, runAutoGrip, setFingerKeep, weaponsForHand } from '../store/handActions'
import { currentPose, redoPose, undoPose } from '../store/poseActions'
import { posedJoints } from '../../shared/fk'
import { Section } from './common'

/** A slider that previews while dragged and commits once on release. */
function AngleSlider({
  label,
  value,
  range,
  onPreview,
  onCommit
}: {
  label: string
  value: number
  range: [number, number]
  onPreview: (v: number) => void
  onCommit: (v: number) => void
}) {
  const [live, setLive] = useState<number | null>(null)
  const shown = live ?? value
  const commit = (v: number) => {
    setLive(null)
    onCommit(v)
  }
  return (
    <label className="angle" title={label}>
      <span className="angle-label">{label}</span>
      <input
        type="range"
        min={range[0]}
        max={range[1]}
        step={1}
        value={shown}
        onChange={(e) => {
          const v = Number(e.target.value)
          setLive(v)
          onPreview(v)
        }}
        onPointerUp={(e) => commit(Number((e.target as HTMLInputElement).value))}
        onKeyUp={(e) => commit(Number((e.target as HTMLInputElement).value))}
        onBlur={() => live !== null && commit(live)}
      />
      <span className="angle-value">{Math.round(shown)}°</span>
    </label>
  )
}

function FingerRow({ side, hand, finger, locked }: { side: 'L' | 'R'; hand: HandPose; finger: FingerName; locked: boolean }) {
  const f = hand.fingers[finger]
  const thumb = finger === 'thumb'
  const change = (patch: Partial<FingerPose>) => withFinger(hand, finger, patch)
  const flex = (k: number, v: number): Partial<FingerPose> => {
    const fl = [...f.flex] as [number, number, number]
    fl[k] = v
    return { flex: fl }
  }
  return (
    <div className="finger">
      <div className="finger-head">
        <strong>{finger}</strong>
        <label className="toggle-line small" title="Auto-grip leaves this finger as it is">
          <input type="checkbox" checked={locked} onChange={(e) => setFingerKeep(side, finger, e.target.checked)} /> keep
        </label>
      </div>
      {[0, 1, 2].map((k) => (
        <AngleSlider
          key={k}
          label={`flex ${k + 1}`}
          value={f.flex[k] ?? 0}
          range={[FLEX_RANGE[0], Math.max(FLEX_RANGE[1], MAX_FLEX[thumb ? 'thumb' : 'finger'][k])]}
          onPreview={(v) => previewHand(side, change(flex(k, v)))}
          onCommit={(v) => commitHand(side, change(flex(k, v)))}
        />
      ))}
      <AngleSlider
        label="spread"
        value={f.spread ?? 0}
        range={SPREAD_RANGE}
        onPreview={(v) => previewHand(side, change({ spread: v }))}
        onCommit={(v) => commitHand(side, change({ spread: v }))}
      />
      {thumb && (
        <AngleSlider
          label="roll"
          value={f.roll ?? 0}
          range={ROLL_RANGE}
          onPreview={(v) => previewHand(side, change({ roll: v }))}
          onCommit={(v) => commitHand(side, change({ roll: v }))}
        />
      )}
    </div>
  )
}

function HandPanel({ side }: { side: 'L' | 'R' }) {
  const rig = useStore((s) => s.rigJson)
  const hand = useStore((s) => s.hands[side])
  const locked = useStore((s) => s.hands.locked[side])
  const weapons = useStore((s) => s.weapons)
  const report = useStore((s) => s.gripReport[side])
  const busy = useStore((s) => s.active !== null)
  const requestFocus = useStore((s) => s.requestFocus)
  const [open, setOpen] = useState<FingerName | null>('index')
  const title = side === 'L' ? 'Left hand' : 'Right hand'
  if (!rig) return null
  if (!rig.hands[side]) {
    return (
      <Section title={title}>
        <p className="muted small">This rig has no finger bones on this side.</p>
      </Section>
    )
  }
  const shown = hand ?? handFromPreset(presetByName('relaxed') ?? HAND_PRESETS[0])
  const canGrip = weaponsForHand(weapons, side).length > 0
  const zoom = () => {
    const pose = currentPose(false)
    if (!pose) return
    const j = posedJoints(rig, pose.deltas)[`middle_0_${side}`] ?? posedJoints(rig, pose.deltas)[`wrist_${side}`]
    if (!j) return
    const t = vecB2T([j.x, j.y, j.z])
    requestFocus([t.x, t.y, t.z], 0.12 * (rig.height_m || 1.8))
  }
  return (
    <Section title={title}>
      <div className="field-row">
        <select value={hand ? (presetByName(hand.name) ? hand.name : '') : ''} onChange={(e) => e.target.value && choosePreset(side, e.target.value)}>
          <option value="">{hand ? 'custom' : 'no hand pose (rest)'}</option>
          {HAND_PRESETS.map((p) => (
            <option key={p.name} value={p.name}>
              {p.label}
            </option>
          ))}
        </select>
        <button onClick={zoom} title="Zoom to this hand">
          Zoom
        </button>
      </div>
      <div className="button-row">
        <button className="primary" disabled={!canGrip || busy} onClick={() => fire(runAutoGrip(side))} title={canGrip ? '' : 'Attach a weapon to this hand first'}>
          Auto-grip
        </button>
        <button onClick={() => copyHandSide(side)}>{side === 'L' ? 'Copy hand L→R' : 'Copy hand R→L'}</button>
        <button onClick={() => resetHand(side)} disabled={!hand}>
          Reset hand
        </button>
      </div>
      {report && (
        <ul className="grip-report small">
          {FINGERS.map((f) => {
            const r = report.fingers[f]
            return (
              <li key={f} className={r.touching ? 'ok' : r.locked ? 'muted' : 'warn'}>
                {f}: {r.locked ? 'kept' : r.touching ? 'touching' : r.maxed ? 'not touching (max flex)' : 'not touching'}
              </li>
            )
          })}
          <li className="muted">auto-grip took {report.ms.toFixed(0)} ms</li>
        </ul>
      )}
      <div className="finger-tabs">
        {FINGERS.map((f) => (
          <button key={f} className={open === f ? 'chip on' : 'chip'} onClick={() => setOpen(open === f ? null : f)}>
            {f}
            {locked.includes(f) ? ' (kept)' : ''}
          </button>
        ))}
      </div>
      {open && <FingerRow side={side} hand={hand ? hand : cloneHand(shown)} finger={open} locked={locked.includes(open)} />}
    </Section>
  )
}

export function HandsStep() {
  const rig = useStore((s) => s.rigJson)
  const canUndo = useStore((s) => s.undo.length > 0)
  const canRedo = useStore((s) => s.redo.length > 0)
  if (!rig) {
    return (
      <div className="step-panel">
        <h2>Hands</h2>
        <p className="muted">Build the rig first (Rig step).</p>
      </div>
    )
  }
  return (
    <div className="step-panel">
      <div className="step-head">
        <h2>Hands</h2>
        <span className="spacer" />
        <button onClick={undoPose} disabled={!canUndo} title="Undo (Ctrl+Z)">
          Undo
        </button>
        <button onClick={redoPose} disabled={!canRedo} title="Redo (Ctrl+Shift+Z)">
          Redo
        </button>
      </div>
      <HandPanel side="R" />
      <HandPanel side="L" />
    </div>
  )
}
