// SPDX-License-Identifier: GPL-3.0-or-later
// Export step: bake settings (contracts section 14, saved in project.bake), "Bake STL" with progress and
// Cancel, then the result (size, triangles, thin walls, gates, weapon STLs) and the preview.
import type { BakeSettings } from '../../shared/project'
import { useStore } from '../store'
import { DEFAULT_BAKE } from '../store/bake'
import { runBake, showInFolder } from '../store/exportActions'
import { cancelActiveJob } from '../store/actions'
import { fire } from '../store/flow'
import { ProgressBar, Section, StepHeader, percent, EmptyState } from './common'
import { IconCube, IconFolder, IconRig } from './icons'

function NumberField({
  label,
  value,
  min,
  max,
  step,
  onChange,
  title
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
  title?: string
}) {
  return (
    <label className="field inline" title={title}>
      <span>{label}</span>
      <input
        className="num"
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => {
          const v = Number(e.target.value)
          if (Number.isFinite(v)) onChange(Math.min(max, Math.max(min, v)))
        }}
      />
    </label>
  )
}

function Settings({ bake }: { bake: BakeSettings }) {
  const update = useStore((s) => s.updateBake)
  const heroic = bake.scale.mode === 'heroic'
  const size = bake.scale.mode === 'heroic' ? bake.scale.size_mm : bake.scale.height_mm
  return (
    <Section title="Settings">
      <div className="settings-grid">
        <label className="field inline">
          <span>Scale</span>
          <select
            value={bake.scale.mode}
            onChange={(e) =>
              update({ scale: e.target.value === 'heroic' ? { mode: 'heroic', size_mm: 32 } : { mode: 'height_mm', height_mm: 40 } })
            }
          >
            <option value="height_mm">Standing height</option>
            <option value="heroic">Heroic (eye height)</option>
          </select>
        </label>
        <NumberField
          label={heroic ? 'Eye height mm' : 'Height mm'}
          value={size}
          min={5}
          max={500}
          step={1}
          onChange={(v) => update({ scale: heroic ? { mode: 'heroic', size_mm: v } : { mode: 'height_mm', height_mm: v } })}
        />
        <NumberField label="Detail" value={bake.detail} min={0} max={4} step={0.5} onChange={(v) => update({ detail: v })} title="Surface detail (subdivision of normal-mapped meshes)" />
        <NumberField label="Sole flatten mm" value={bake.flatten_mm} min={0} max={5} step={0.1} onChange={(v) => update({ flatten_mm: v })} />
        <NumberField label="Base mm (0 = none)" value={bake.base_mm} min={0} max={100} step={1} onChange={(v) => update({ base_mm: v })} />
        <NumberField label="Min wall mm" value={bake.min_wall_mm} min={0.1} max={3} step={0.05} onChange={(v) => update({ min_wall_mm: v })} />
        <NumberField label="Max triangles" value={bake.max_tris} min={10_000} max={10_000_000} step={10_000} onChange={(v) => update({ max_tris: Math.round(v) })} />
      </div>
      <label className="toggle-line" title="Fingers, blades and other parts thinner than the minimum wall are made thicker until they reach it.">
        <input type="checkbox" checked={bake.thicken_thin !== false} onChange={(e) => update({ thicken_thin: e.target.checked })} /> Thicken parts
        thinner than the minimum wall
      </label>
      <label className="toggle-line">
        <input type="checkbox" checked={bake.weapons_separate} onChange={(e) => update({ weapons_separate: e.target.checked })} /> Print all weapons
        separately
      </label>
    </Section>
  )
}

function Result() {
  const result = useStore((s) => s.bakeResult)
  const showBaked = useStore((s) => s.showBaked)
  const setShowBaked = useStore((s) => s.setShowBaked)
  if (!result) return null
  const r = result.report
  const g = result.gates
  return (
    <Section title="Result">
      <p className="result-head">
        <strong>{r.final_dims_mm.map((d) => d.toFixed(1)).join(' x ')} mm</strong>{' '}
        <span className="muted">
          · {r.tris.toLocaleString('en-US')} triangles · {r.stl_mb} MB
        </span>
      </p>
      <dl className="summary">
        <dt>Thinner than {r.min_thickness_mm} mm</dt>
        <dd className={r.thin_area_pct > 5 ? 'warn' : ''}>
          {r.thin_area_pct}% of the surface
          {r.thin_area_pct_before !== undefined && r.thin_area_pct_before !== r.thin_area_pct ? ` (was ${r.thin_area_pct_before}% before thickening)` : ''}
        </dd>
        <dt>Pieces</dt>
        <dd className={r.pieces > 1 ? 'warn' : ''}>{r.pieces}</dd>
        <dt>Follow check</dt>
        <dd>
          {percent(g.follow.moved_fraction)} moved, drift {percent(g.follow.worst_drift, 2)}, box x{g.follow.grow.toFixed(2)}
        </dd>
        <dt>Detail faces</dt>
        <dd>
          {g.faces.toLocaleString('en-US')}
          {g.levels_lowered ? ` (${g.levels_lowered} subdivision levels lowered)` : ''}
        </dd>
        {g.voxel_coarsened_to ? (
          <>
            <dt>Voxel coarsened to</dt>
            <dd>{g.voxel_coarsened_to}</dd>
          </>
        ) : null}
        <dt>Bake time</dt>
        <dd>{result.seconds} s</dd>
      </dl>
      <pre className="report">{r.summary}</pre>
      <div className="button-row">
        <button onClick={() => fire(showInFolder(result.stl))}>
          <IconFolder size={14} />
          Show {result.stl.split('/').pop()} in folder
        </button>
        {result.weapons.map((w) => (
          <button key={w.id} onClick={() => fire(showInFolder(w.stl))}>
            Show {w.stl.split('/').pop()}
          </button>
        ))}
      </div>
      <label className="toggle-line">
        <input type="checkbox" checked={showBaked} onChange={(e) => setShowBaked(e.target.checked)} /> Show the printable preview (grey
        printable, red too thin)
      </label>
    </Section>
  )
}

export function ExportStep() {
  const rig = useStore((s) => s.rigJson)
  const bake = useStore((s) => s.bake) ?? DEFAULT_BAKE
  const active = useStore((s) => s.active)
  const progress = useStore((s) => s.progress)
  const error = useStore((s) => s.error)
  if (!rig) {
    return (
      <div className="step-panel">
        <StepHeader step="export" />
        <EmptyState icon={<IconRig size={22} />} title="Build the rig first">
          <p>The Rig step places the joints and builds the rig this step needs.</p>
        </EmptyState>
      </div>
    )
  }
  const baking = active?.type === 'bake'
  return (
    <div className="step-panel">
      <StepHeader step="export" />
      <Settings bake={bake} />
      <div className="button-row cta">
        <button className="primary" disabled={active !== null} onClick={() => fire(runBake())}>
          <IconCube size={15} />
          Bake STL
        </button>
      </div>
      {baking && (
        <div className="download">
          <ProgressBar fraction={progress?.fraction ?? null} label={progress?.message || active.label} />
          <button onClick={() => fire(cancelActiveJob())} disabled={!active.jobId}>
            Cancel
          </button>
        </div>
      )}
      {error && (error.code === 'E_FOLLOW_CHECK' || error.code === 'E_BUDGET') && (
        <p className="warn small">
          {error.code}: {error.message}
        </p>
      )}
      <Result />
    </div>
  )
}
