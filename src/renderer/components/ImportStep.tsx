// SPDX-License-Identifier: GPL-3.0-or-later
// Import step: choose a model, see the import summary, choose its parts, fix the orientation.
import { useEffect, useState } from 'react'
import type { ImportJobResult } from '../../shared/jobResults'
import type { Axis, Orientation } from '../../shared/project'
import { AXES, forwardChoices, pickOrientation, sameOrientation, unitScaleChoices, withUp } from '../lib/orientation'
import { partsOf } from '../lib/parts'
import { chooseAndImportModel, fire, rerunImport } from '../store/actions'
import { useStore } from '../store'
import { ProgressBar, Section, StepHeader, Warnings } from './common'
import { PartsPanel } from './PartsPanel'
import { IconFile, IconImport } from './icons'

function ImportSummary({ info }: { info: ImportJobResult }) {
  return (
    <Section title="Summary">
      <dl className="summary">
        <dt>Objects</dt>
        <dd>
          {info.objects.length}
          {info.objects.length > 0 && (
            <span className="muted"> ({info.objects.map((o) => o.name).join(', ')})</span>
          )}
        </dd>
        <dt>Triangles</dt>
        <dd>{info.tri_count.toLocaleString('en-US')}</dd>
        <dt>Height</dt>
        <dd>
          {info.height_m.toFixed(3)} m <span className="muted">({(info.height_m * 100).toFixed(1)} cm)</span>
        </dd>
        <dt>Materials</dt>
        <dd>
          {info.materials.length}
          {info.materials.length > 0 && <span className="muted"> ({info.materials.join(', ')})</span>}
        </dd>
        <dt>Normal maps</dt>
        <dd>{info.normal_maps.length}</dd>
        <dt>Has skeleton</dt>
        <dd>{info.has_armature ? `yes (${info.armature_bones.length} bones)` : 'no'}</dd>
        {info.proxy && (
          <>
            <dt>Dense model</dt>
            <dd>a lighter copy is used while rigging</dd>
          </>
        )}
      </dl>
      <Warnings items={info.warnings} />
    </Section>
  )
}

function OrientationPanel({ current, suggested }: { current: Orientation | null; suggested: (Orientation & { reason?: string | null }) | null }) {
  const busy = useStore((s) => s.active !== null)
  const start = current ?? (suggested ? pickOrientation(suggested) : { up: 'Z' as Axis, forward: '-Y' as Axis, unit_scale: 1 })
  const [o, setO] = useState<Orientation>(start)
  // Follow the project when a job changes the orientation.
  useEffect(() => {
    if (current) setO(current)
  }, [current])

  return (
    <Section title="Orientation">
      <div className="orientation">
        <label className="field inline">
          <span>Up</span>
          <select value={o.up} onChange={(e) => setO(withUp(o, e.target.value as Axis))}>
            {AXES.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
        <label className="field inline">
          <span>Forward</span>
          <select value={o.forward} onChange={(e) => setO({ ...o, forward: e.target.value as Axis })}>
            {forwardChoices(o.up).map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
        <label className="field inline">
          <span>Unit scale</span>
          <select value={String(o.unit_scale)} onChange={(e) => setO({ ...o, unit_scale: Number(e.target.value) })}>
            {unitScaleChoices(o.unit_scale).map((u) => (
              <option key={u.value} value={String(u.value)}>
                {u.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {suggested && (
        <p className="muted small">
          Suggested: up {suggested.up}, forward {suggested.forward}, x{suggested.unit_scale}
          {suggested.reason ? ` (${suggested.reason})` : ''}
        </p>
      )}
      <div className="button-row">
        <button className="primary" disabled={busy || sameOrientation(o, current)} onClick={() => fire(rerunImport(o))}>
          Apply
        </button>
        {suggested && (
          <button disabled={busy} onClick={() => setO(pickOrientation(suggested))}>
            Use suggestion
          </button>
        )}
      </div>
    </Section>
  )
}

export function ImportStep() {
  const source = useStore((s) => s.data?.source ?? null)
  const info = useStore((s) => s.importInfo)
  const active = useStore((s) => s.active)
  const progress = useStore((s) => s.progress)
  const previewError = useStore((s) => s.previewError)
  const busy = active !== null
  const parts = partsOf(info)

  return (
    <div className="step-panel">
      <StepHeader step="import" />
      <div className="button-row cta">
        <button className="primary" disabled={busy} onClick={() => fire(chooseAndImportModel())}>
          <IconImport size={15} />
          Choose model…
        </button>
      </div>
      <p className="muted small">FBX, glTF/GLB, OBJ, STL or PLY. The model and its textures are copied into the project.</p>
      {source && (
        <p className="file-line">
          <IconFile size={14} />
          <span className="muted">Model</span>
          <code>{source.file}</code>
        </p>
      )}
      {active?.type === 'import' && <ProgressBar fraction={progress?.fraction ?? null} label={progress?.message || active.label} />}
      {info && <ImportSummary info={info} />}
      {parts.length > 0 && <PartsPanel parts={parts} />}
      {!info && source && !busy && (
        <div className="hint callout">
          <p>The import summary is shown after an import.</p>
          <button onClick={() => fire(rerunImport())}>Run the import again</button>
        </div>
      )}
      {previewError && !busy && <p className="muted small">{previewError}</p>}
      {source && (info || source.orientation) && (
        <OrientationPanel current={source.orientation} suggested={info?.suggested_orientation ?? null} />
      )}
    </div>
  )
}
