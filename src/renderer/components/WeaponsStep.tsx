// SPDX-License-Identifier: GPL-3.0-or-later
// Weapons step: add a weapon (converted to weapons/<name>.glb), units, attach hand, gizmo move/rotate,
// scale with the print length, grip point, two-handed support grip, print separately, remove.
import { useState } from 'react'
import type { WeaponEntry } from '../../shared/project'
import { lengthMm, unitMm } from '../lib/weapons'
import { useStore } from '../store'
import { fire } from '../store/flow'
import { redoPose, undoPose } from '../store/poseActions'
import { usePoseResult } from '../viewer/Viewer'
import type { WeaponTool } from '../store/weapons'
import {
  chooseAndAddWeapon,
  flipSupportAxis,
  removeWeapon,
  setAttachSide,
  setPrintSeparately,
  setTwoHanded,
  setWeaponScale,
  setWeaponUnits,
  UNIT_CHOICES
} from '../store/weaponActions'
import { Section, Warnings } from './common'

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
  const twoHanded = !!weapon.support?.enabled
  const short = pose?.supportShort[weapon.id]
  const name = weapon.file.split('/').pop() ?? weapon.file
  const length = info && rig ? lengthMm(info.dims_m, weapon.offset.s, unitMm(rig, bake)) : null
  const toolButton = (t: WeaponTool, label: string, title: string) => (
    <button
      className={selected && tool === t ? 'on' : ''}
      onClick={() => {
        selectWeapon(weapon.id)
        setTool(t)
      }}
      title={title}
    >
      {label}
    </button>
  )

  return (
    <Section
      title={name}
      actions={
        <button className="icon" title="Remove the weapon" onClick={() => removeWeapon(weapon.id)}>
          ×
        </button>
      }
    >
      {!selected && (
        <button className="link" onClick={() => selectWeapon(weapon.id)}>
          Select to move or set its grips
        </button>
      )}
      <div className="field-row">
        <label className="field inline">
          <span>Hand</span>
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
      {info && (
        <label className="field inline">
          <span>Units</span>
          <select
            value={String(info.unit_scale_used)}
            disabled={busy}
            onChange={(e) => fire(setWeaponUnits(weapon.id, Number(e.target.value)))}
          >
            {UNIT_CHOICES.map((u) => (
              <option key={u.value} value={String(u.value)}>
                {u.label}
              </option>
            ))}
            {!UNIT_CHOICES.some((u) => Math.abs(u.value - info.unit_scale_used) < 1e-12) && (
              <option value={String(info.unit_scale_used)}>x{info.unit_scale_used}</option>
            )}
          </select>
        </label>
      )}
      {info && <Warnings items={info.warnings} />}
      <div className="button-row">
        {toolButton('move', 'Move', 'Move the weapon in the hand')}
        {toolButton('rotate', 'Rotate', 'Turn the weapon in the hand')}
        {toolButton('grip', 'Set grip point', 'Click the weapon where the hand should hold it')}
      </div>
      {selected && tool === 'grip' && <p className="hint small">Click the weapon where the {side === 'R' ? 'right' : 'left'} hand holds it.</p>}
      <label className="toggle-line">
        <input type="checkbox" checked={twoHanded} onChange={(e) => setTwoHanded(weapon.id, e.target.checked)} /> Two-handed (
        {side === 'R' ? 'left' : 'right'} hand supports)
      </label>
      {twoHanded && (
        <>
          <div className="button-row">
            {toolButton('support', 'Set support grip', 'Click the weapon where the other hand holds it')}
            <button onClick={() => flipSupportAxis(weapon.id)} title="Turn the support hand around the weapon's axis">
              Flip grip axis
            </button>
          </div>
          {selected && tool === 'support' && <p className="hint small">Click the weapon where the {side === 'R' ? 'left' : 'right'} hand holds it.</p>}
          {short !== undefined && short > 0.001 && (
            <p className="warn small">
              {side === 'R' ? 'Left' : 'Right'} hand can't reach by {(short * 1000).toFixed(0)} mm
            </p>
          )}
        </>
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
        <h2>Weapons</h2>
        <p className="muted">Build the rig first (Rig step).</p>
      </div>
    )
  }
  const free = ['grip.R', 'grip.L'].some((b) => !weapons.some((w) => w.attach_bone === b))
  return (
    <div className="step-panel">
      <div className="step-head">
        <h2>Weapons</h2>
        <span className="spacer" />
        <button onClick={undoPose} disabled={!canUndo} title="Undo (Ctrl+Z)">
          Undo
        </button>
        <button onClick={redoPose} disabled={!canRedo} title="Redo (Ctrl+Shift+Z)">
          Redo
        </button>
      </div>
      <div className="button-row">
        <button className="primary" disabled={busy || !free} onClick={() => fire(chooseAndAddWeapon())} title={free ? '' : 'Both hands hold a weapon'}>
          Add weapon…
        </button>
      </div>
      <p className="muted small">FBX, glTF/GLB, OBJ or STL. One weapon per hand; it is printed with the figure unless it is printed separately.</p>
      {weapons.map((w) => (
        <WeaponCard key={w.id} weapon={w} />
      ))}
    </div>
  )
}
