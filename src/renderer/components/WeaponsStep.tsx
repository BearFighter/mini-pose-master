// SPDX-License-Identifier: GPL-3.0-or-later
// Weapons step: add a weapon (a file, or a prop that came with the model; converted to
// weapons/<name>.glb), units, attach hand, gizmo move/rotate,
// scale with the print length, grip point, two-handed support grip, print separately, remove.
import { useState } from 'react'
import type { WeaponEntry } from '../../shared/project'
import type { WeaponSupport } from '../../shared/weaponPose'
import { lengthMm, unitMm } from '../lib/weapons'
import { useStore } from '../store'
import { fire } from '../store/flow'
import { redoPose, undoPose } from '../store/poseActions'
import { usePoseResult } from '../viewer/Viewer'
import type { WeaponTool } from '../store/weapons'
import {
  chooseAndAddWeapon,
  flipSupportAxis,
  gripToolFor,
  removeWeapon,
  setAttachSide,
  setFollowMode,
  setPrintSeparately,
  setTwoHanded,
  setWeaponScale,
  setWeaponUnits,
  UNIT_CHOICES
} from '../store/weaponActions'
import { IconPlus, IconRedo, IconRig, IconTrash, IconUndo } from './icons'
import { Section, StepHeader, Warnings, EmptyState } from './common'
import { PropList } from './PropList'

function ScaleField({ weapon }: { weapon: WeaponEntry }) {
  const [text, setText] = useState<string | null>(null)
  const apply = () => {
    if (text === null) return
    const v = Number(text)
    if (Number.isFinite(v) && v > 0) setWeaponScale(weapon.id, v)
    setText(null)
  }
  return (
    <input
      className="num"
      type="number"
      min={0.25}
      max={4}
      step={0.05}
      value={text ?? String(Number(weapon.offset.s.toFixed(3)))}
      onChange={(e) => setText(e.target.value)}
      onBlur={apply}
      onKeyDown={(e) => e.key === 'Enter' && apply()}
    />
  )
}

const HAND_NAME = { R: 'right', L: 'left' } as const

function WeaponCard({ weapon }: { weapon: WeaponEntry }) {
  const rig = useStore((s) => s.rigJson)
  const bake = useStore((s) => s.bake)
  const info = useStore((s) => s.weaponInfo[weapon.id])
  const selected = useStore((s) => s.weaponSelection === weapon.id)
  const tool = useStore((s) => s.weaponTool)
  const selectWeapon = useStore((s) => s.selectWeapon)
  const setTool = useStore((s) => s.setWeaponTool)
  const busy = useStore((s) => s.active !== null)
  const pose = usePoseResult()
  const side = weapon.attach_bone === 'grip.L' ? 'L' : 'R'
  const other = side === 'R' ? 'L' : 'R'
  const twoHanded = !!weapon.support?.enabled
  const follow = (weapon.support as WeaponSupport | undefined)?.mode ?? 'both'
  const short = pose?.supportShort[weapon.id]
  const name = weapon.file.split('/').pop() ?? weapon.file
  const length = info && rig ? lengthMm(info.dims_m, weapon.offset.s, unitMm(rig, bake)) : null
  const units = weapon.unit_scale ?? info?.unit_scale_used ?? 1
  const pick = (t: WeaponTool) => {
    selectWeapon(weapon.id)
    setTool(t)
  }
  const toolButton = (t: WeaponTool, label: string, title: string, icon?: React.ReactNode) => (
    <button className={selected && tool === t ? 'on' : ''} onClick={() => pick(t)} title={title}>
      {icon}
      {label}
    </button>
  )
  const gripButton = (hand: 'L' | 'R') => {
    const t = gripToolFor(weapon, hand)
    return (
      <button
        key={hand}
        className={selected && tool === t ? 'on grip-button' : 'grip-button'}
        onClick={() => pick(t)}
        title={`Click the weapon where the ${HAND_NAME[hand]} hand holds it`}
      >
        <span className={`grip-swatch grip-${hand}`} aria-hidden="true" />
        Set {HAND_NAME[hand]}-hand grip
      </button>
    )
  }
  const clickHand = selected && tool === 'grip' ? side : selected && tool === 'support' ? other : null

  return (
    <Section
      title={name}
      actions={
        <button className="icon danger" title="Remove the weapon" aria-label="Remove the weapon" onClick={() => removeWeapon(weapon.id)}>
          <IconTrash size={14} />
        </button>
      }
    >
      {!selected && (
        <button className="link" onClick={() => selectWeapon(weapon.id)}>
          Select to move or set its grips
        </button>
      )}
      <div className="field">
        <span>Held with</span>
        <div className="tabs segmented" role="tablist" aria-label="Held with">
          <button role="tab" aria-selected={!twoHanded} className={twoHanded ? 'tab' : 'tab active'} onClick={() => setTwoHanded(weapon.id, false)}>
            One hand
          </button>
          <button role="tab" aria-selected={twoHanded} className={twoHanded ? 'tab active' : 'tab'} onClick={() => setTwoHanded(weapon.id, true)}>
            Two hands
          </button>
        </div>
      </div>
      <div className="field-row">
        <label className="field inline">
          <span>{twoHanded ? 'Main hand' : 'Hand'}</span>
          <select value={side} onChange={(e) => setAttachSide(weapon.id, e.target.value as 'L' | 'R')}>
            <option value="R">Right hand</option>
            <option value="L">Left hand</option>
          </select>
        </label>
        <label className="field inline">
          <span>Scale</span>
          <ScaleField weapon={weapon} />
        </label>
        {length !== null && (
          <span className="muted small length" title="Length at print scale">
            {length.toFixed(1)} mm
          </span>
        )}
      </div>
      {weapon.source && (
        <label className="field inline" title="Convert the weapon again with other units">
          <span>Units</span>
          <select value={String(units)} disabled={busy} onChange={(e) => fire(setWeaponUnits(weapon.id, Number(e.target.value)))}>
            {UNIT_CHOICES.map((u) => (
              <option key={u.value} value={String(u.value)}>
                {u.label}
              </option>
            ))}
            {!UNIT_CHOICES.some((u) => Math.abs(u.value - units) < 1e-12) && <option value={String(units)}>x{units}</option>}
          </select>
        </label>
      )}
      {info && <Warnings items={info.warnings} />}
      <div className="button-row">
        {toolButton('move', 'Move', 'Move the weapon in the hand')}
        {toolButton('rotate', 'Rotate', 'Turn the weapon in the hand')}
        {!twoHanded && toolButton('grip', 'Set grip point', 'Click the weapon where the hand should hold it')}
      </div>
      {twoHanded && <div className="button-row grip-row">{(['R', 'L'] as const).map(gripButton)}</div>}
      {clickHand && <p className="hint small tip">Click the weapon where the {HAND_NAME[clickHand]} hand holds it.</p>}
      {twoHanded && short !== undefined && short > 0.001 && (
        <p className="warn small">
          {other === 'L' ? 'Left' : 'Right'} hand can't reach by {(short * 1000).toFixed(0)} mm
        </p>
      )}
      {twoHanded && (
        <details className="advanced">
          <summary>Advanced</summary>
          <label className="field inline" title="Both hands: the pose aims the weapon from the main hand at the other hand. Main hand only: the weapon stays fixed in the main hand and the other hand reaches for its grip.">
            <span>Weapon follows</span>
            <select value={follow} onChange={(e) => setFollowMode(weapon.id, e.target.value as 'both' | 'reach')}>
              <option value="both">Both hands (default)</option>
              <option value="reach">The main hand only</option>
            </select>
          </label>
          <div className="button-row">
            <button onClick={() => flipSupportAxis(weapon.id)} title={`Turn the ${HAND_NAME[other]} hand around the weapon's axis`}>
              Flip {HAND_NAME[other]}-hand grip axis
            </button>
          </div>
        </details>
      )}
      <label className="toggle-line">
        <input type="checkbox" checked={weapon.merge === false} onChange={(e) => setPrintSeparately(weapon.id, e.target.checked)} /> Print
        separately
      </label>
    </Section>
  )
}

export function WeaponsStep() {
  const rig = useStore((s) => s.rigJson)
  const weapons = useStore((s) => s.weapons)
  const busy = useStore((s) => s.active !== null)
  const canUndo = useStore((s) => s.undo.length > 0)
  const canRedo = useStore((s) => s.redo.length > 0)
  if (!rig) {
    return (
      <div className="step-panel">
        <StepHeader step="weapons" />
        <EmptyState icon={<IconRig size={22} />} title="Build the rig first">
          <p>The Rig step places the joints and builds the rig this step needs.</p>
        </EmptyState>
      </div>
    )
  }
  const free = ['grip.R', 'grip.L'].some((b) => !weapons.some((w) => w.attach_bone === b))
  return (
    <div className="step-panel">
      <StepHeader step="weapons">
        <button className="icon-button" onClick={undoPose} disabled={!canUndo} title="Undo (Ctrl+Z)" aria-label="Undo">
          <IconUndo size={16} />
        </button>
        <button className="icon-button" onClick={redoPose} disabled={!canRedo} title="Redo (Ctrl+Shift+Z)" aria-label="Redo">
          <IconRedo size={16} />
        </button>
      </StepHeader>
      <div className="button-row cta">
        <button className="primary" disabled={busy || !free} onClick={() => fire(chooseAndAddWeapon())} title={free ? '' : 'Both hands hold a weapon'}>
          <IconPlus size={15} />
          Add weapon…
        </button>
      </div>
      <p className="muted small">FBX, glTF/GLB, OBJ or STL. One weapon per hand; it is printed with the figure unless it is printed separately.</p>
      <PropList free={free} />
      {weapons.map((w) => (
        <WeaponCard key={w.id} weapon={w} />
      ))}
    </div>
  )
}
