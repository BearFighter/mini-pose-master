// SPDX-License-Identifier: GPL-3.0-or-later
// Rig step: auto-rig (find joints, review and drag markers) or map the model's own skeleton,
// then build the rig and check it at rest and in a test pose.
import { useMemo } from 'react'
import { addKnucklePoints, confidenceLevel, hasKnucklePoints, removeKnucklePoints, warningHand } from '../lib/markers'
import {
  buildRig,
  fire,
  modelBoneNames,
  findJoints,
  resetMarkers,
  suggestMapping,
  zoomToHand
} from '../store/actions'
import { useStore } from '../store'
import { MAPPABLE_BONES } from '../store/rig'
import { EmptyState, percent, ProgressBar, Section, StepHeader } from './common'
import { IconImport, IconRig, IconSparkle, IconZoom } from './icons'
import { MarkerList } from './MarkerList'

function JobProgress({ types }: { types: string[] }) {
  const active = useStore((s) => s.active)
  const progress = useStore((s) => s.progress)
  if (!active || !types.includes(active.type)) return null
  return <ProgressBar fraction={progress?.fraction ?? null} label={progress?.message || active.label} />
}

/** The warnings of "Find joints"; one about a hand gets a "Zoom to hand" button. */
function MarkerWarnings({ items }: { items: string[] }) {
  if (items.length === 0) return null
  return (
    <ul className="warnings">
      {items.map((w, i) => {
        const side = warningHand(w)
        return (
          <li key={i}>
            {w}
            {side && (
              <button className="mini" onClick={() => zoomToHand(side)} title={`Show the ${side === 'L' ? 'left' : 'right'} hand's markers`}>
                Zoom to hand
              </button>
            )}
          </li>
        )
      })}
    </ul>
  )
}

function AutoRigPanel() {
  const markers = useStore((s) => s.markers)
  const warnings = useStore((s) => s.markerWarnings)
  const mirror = useStore((s) => s.mirrorEdits)
  const xray = useStore((s) => s.xray)
  const busy = useStore((s) => s.active !== null)
  const setMirror = useStore((s) => s.setMirrorEdits)
  const setXray = useStore((s) => s.setXray)
  const setMarkers = useStore((s) => s.setMarkers)
  const requestFocus = useStore((s) => s.requestFocus)
  const height = useStore((s) => s.importInfo?.height_m ?? 1.8)
  const editing = useStore((s) => s.view === 'markers' || s.rigJson === null)
  const counts = useMemo(() => {
    const c = { high: 0, medium: 0, low: 0 }
    for (const m of Object.values(markers ?? {})) c[confidenceLevel(m.confidence)]++
    return c
  }, [markers])

  return (
    <>
      <Section title="Joints">
        <p className="muted small">
          Find joints places a marker on every joint. Drag markers in the view to fix them; the bone lines follow.
        </p>
        <div className="button-row">
          <button className={markers ? '' : 'primary'} disabled={busy} onClick={() => fire(findJoints())}>
            <IconSparkle size={14} />
            {markers ? 'Find joints again' : 'Find joints'}
          </button>
          {markers && (
            <button disabled={busy} onClick={() => fire(resetMarkers())}>
              Reset to suggestion
            </button>
          )}
        </div>
        <JobProgress types={['suggest_markers']} />
        <MarkerWarnings items={warnings} />
      </Section>

      {markers && editing && (
        <Section title={`Markers (${Object.keys(markers).length})`}>
          <p className="small levels">
            <span className="level high">{counts.high} sure</span> <span className="level medium">{counts.medium} check</span>{' '}
            <span className="level low">{counts.low} unsure</span>
          </p>
          <div className="toggles">
            <label>
              <input type="checkbox" checked={mirror} onChange={(e) => setMirror(e.target.checked)} /> Mirror edits
            </label>
            <label>
              <input type="checkbox" checked={xray} onChange={(e) => setXray(e.target.checked)} /> See-through model
            </label>
          </div>
          <div className="button-row">
            <button onClick={() => zoomToHand('L')}>
              <IconZoom size={14} />
              Zoom to hand L
            </button>
            <button onClick={() => zoomToHand('R')}>
              <IconZoom size={14} />
              Zoom to hand R
            </button>
            <button onClick={() => requestFocus([0, height / 2, 0], height * 0.55, false)}>
              <IconZoom size={14} />
              Whole body
            </button>
          </div>
          <div className="button-row" title="Two extra points per finger for curved fingers and claws. Without them each finger is a straight line from knuckle to tip.">
            {(['L', 'R'] as const).map((side) => {
              const has = markers ? hasKnucklePoints(markers, side) : false
              return (
                <button
                  key={side}
                  disabled={!markers}
                  onClick={() => {
                    if (!markers) return
                    setMarkers(has ? removeKnucklePoints(markers, side) : addKnucklePoints(markers, side))
                    if (!has) zoomToHand(side)
                  }}
                >
                  {has ? 'Remove' : 'Add'} knuckle points {side}
                </button>
              )
            })}
          </div>
          <MarkerList />
        </Section>
      )}

      {markers && editing && (
        <div className="button-row cta">
          <button className="primary" disabled={busy} onClick={() => fire(buildRig('auto'))}>
            <IconRig size={15} />
            Build rig
          </button>
        </div>
      )}
    </>
  )
}

function MappingPanel() {
  const mapping = useStore((s) => s.mapping)
  const edits = useStore((s) => s.mappingEdits)
  const setEdit = useStore((s) => s.setMappingEdit)
  const busy = useStore((s) => s.active !== null)
  const importInfo = useStore((s) => s.importInfo)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const bones = useMemo(() => modelBoneNames().sort((a, b) => a.localeCompare(b)), [mapping, importInfo])
  const unmapped = MAPPABLE_BONES.filter((c) => !edits[c]).length
  const anyMapped = MAPPABLE_BONES.some((c) => edits[c])

  return (
    <>
      <Section title="Skeleton">
        {!mapping && (
          <div className="button-row">
            <button className="primary" disabled={busy} onClick={() => fire(suggestMapping())}>
              Read the skeleton
            </button>
          </div>
        )}
        <JobProgress types={['suggest_mapping']} />
        {mapping && (
          <p>
            Convention: <strong>{mapping.convention}</strong> · confidence {percent(mapping.confidence, 0)}
            {unmapped > 0 && <span className="muted"> · {unmapped} bones unmapped</span>}
          </p>
        )}
      </Section>
      {mapping && (
        <Section title="Bone mapping">
          <table className="mapping">
            <thead>
              <tr>
                <th>Canonical bone</th>
                <th>Model bone</th>
              </tr>
            </thead>
            <tbody>
              {MAPPABLE_BONES.map((canonical) => (
                <tr key={canonical} className={edits[canonical] ? '' : 'unmapped'}>
                  <td>{canonical}</td>
                  <td>
                    <select value={edits[canonical] ?? ''} onChange={(e) => setEdit(canonical, e.target.value || null)}>
                      <option value="">none</option>
                      {bones.map((b) => (
                        <option key={b} value={b}>
                          {b}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}
      {mapping && (
        <div className="button-row cta">
          <button className="primary" disabled={busy || !anyMapped} onClick={() => fire(buildRig('imported'))}>
            <IconRig size={15} />
            Build rig
          </button>
        </div>
      )}
    </>
  )
}

function RigResultPanel() {
  const rig = useStore((s) => s.rigJson)
  const result = useStore((s) => s.rigResult)
  const testPose = useStore((s) => s.testPose)
  const setTestPose = useStore((s) => s.setTestPose)
  const view = useStore((s) => s.view)
  const setView = useStore((s) => s.setView)
  const rigPath = useStore((s) => s.rigPath)
  const hasMarkers = useStore((s) => s.markers !== null)
  if (!rig) return null
  return (
    <Section title="Rig">
      <p>
        {rig.kind === 'auto' ? 'Auto rig' : 'Model skeleton'} · {rig.bones.length} bones ·{' '}
        <span className="muted" title={rig.hash}>
          {rig.hash.slice(0, 8)}
        </span>
      </p>
      {result && (
        <dl className="summary">
          <dt title="Share of vertices that moved when the rig job bent an arm and a leg">Moved in self-test</dt>
          <dd>{percent(result.follow.moved_fraction)}</dd>
          <dt title="Largest change of a vertex's distance to its bone, as a share of the height">Worst drift</dt>
          <dd title="of the model height">{percent(result.follow.worst_drift, 2)}</dd>
          <dt>Box growth</dt>
          <dd>x{result.follow.grow.toFixed(3)}</dd>
          {result.blind_vertices !== undefined && (
            <>
              <dt>Unreached vertices</dt>
              <dd>{result.blind_vertices}</dd>
            </>
          )}
          <dt>Build time</dt>
          <dd>{result.seconds} s</dd>
        </dl>
      )}
      <div className="toggles">
        <label>
          <input type="checkbox" checked={testPose} onChange={(e) => setTestPose(e.target.checked)} disabled={view !== 'rig'} /> Test pose
          (arms raised 45°, left knee bent)
        </label>
      </div>
      {rigPath === 'auto' && hasMarkers && (
        <div className="button-row">
          {view === 'rig' ? (
            <button onClick={() => setView('markers')}>Edit markers</button>
          ) : (
            <button onClick={() => setView('rig')}>Show the rig</button>
          )}
        </div>
      )}
    </Section>
  )
}

export function RigStep() {
  const source = useStore((s) => s.data?.source ?? null)
  const importInfo = useStore((s) => s.importInfo)
  const projectRig = useStore((s) => s.data?.rig ?? null)
  const rigPath = useStore((s) => s.rigPath)
  const setRigPath = useStore((s) => s.setRigPath)
  const mapping = useStore((s) => s.mapping)
  const busy = useStore((s) => s.active !== null)
  const showingRig = useStore((s) => s.rigJson !== null && s.view === 'rig')
  const hasSkeleton = importInfo?.has_armature === true || projectRig?.kind === 'imported'

  if (!source?.orientation) {
    return (
      <div className="step-panel">
        <StepHeader step="rig" />
        <EmptyState icon={<IconImport size={22} />} title="Import a model first">
          <p>The Import step loads the character and sets which way is up.</p>
        </EmptyState>
      </div>
    )
  }

  const chooseImported = () => {
    setRigPath('imported')
    if (!mapping && !busy) fire(suggestMapping())
  }

  return (
    <div className="step-panel">
      <StepHeader step="rig" />
      {showingRig && <RigResultPanel />}
      {hasSkeleton ? (
        <div className="tabs segmented" role="tablist">
          <button role="tab" aria-selected={rigPath === 'auto'} className={rigPath === 'auto' ? 'tab active' : 'tab'} onClick={() => setRigPath('auto')}>
            Auto-rig
          </button>
          <button
            role="tab"
            aria-selected={rigPath === 'imported'}
            className={rigPath === 'imported' ? 'tab active' : 'tab'}
            onClick={chooseImported}
          >
            Use the model's skeleton
          </button>
        </div>
      ) : (
        !importInfo && <p className="muted small">Run the import again to check whether the model has its own skeleton.</p>
      )}
      {rigPath === 'imported' && hasSkeleton ? <MappingPanel /> : <AutoRigPanel />}
      <JobProgress types={['rig']} />
      {!showingRig && <RigResultPanel />}
    </div>
  )
}
