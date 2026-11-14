// SPDX-License-Identifier: GPL-3.0-or-later
// Status bar: Blender status, the running job (stage, progress, Cancel), and an expandable log tail.
import { useEffect, useRef } from 'react'
import { cancelActiveJob, fire } from '../store/actions'
import { useStore } from '../store'

function LogPanel() {
  const log = useStore((s) => s.log)
  const clearLog = useStore((s) => s.clearLog)
  const ref = useRef<HTMLPreElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [log])
  return (
    <div className="log-panel">
      <div className="log-header">
        <span>Job log (last {log.length} lines)</span>
        <button onClick={clearLog}>Clear</button>
      </div>
      <pre ref={ref}>{log.join('\n')}</pre>
    </div>
  )
}

export function StatusBar() {
  const blender = useStore((s) => s.blender)
  const active = useStore((s) => s.active)
  const progress = useStore((s) => s.progress)
  const logOpen = useStore((s) => s.logOpen)
  const setLogOpen = useStore((s) => s.setLogOpen)
  const logCount = useStore((s) => s.log.length)
  const update = useStore((s) => s.update)
  const setShowBlenderSetup = useStore((s) => s.setShowBlenderSetup)
  const pct = progress ? Math.round(progress.fraction * 100) : 0

  return (
    <footer className="status-bar">
      {logOpen && <LogPanel />}
      <button className={blender?.found ? 'status-item' : 'status-item warn'} onClick={() => setShowBlenderSetup(true)}>
        {blender === null ? 'Checking Blender…' : blender.found ? `Blender ${blender.version}` : 'Blender not found'}
      </button>
      <div className="status-job">
        {active ? (
          <>
            <span className="job-label">{active.label}</span>
            <span className="job-stage">{progress?.message || progress?.stage || ''}</span>
            <span className="mini-progress">
              <span style={{ width: `${pct}%` }} />
            </span>
            <span className="job-pct">{pct}%</span>
            <button onClick={() => fire(cancelActiveJob())} disabled={!active.jobId}>
              Cancel
            </button>
          </>
        ) : (
          <span className="muted">Ready</span>
        )}
      </div>
      {update?.kind === 'available' && <span className="status-item">Update {update.version} available</span>}
      <button className="status-item" onClick={() => setLogOpen(!logOpen)}>
        Log ({logCount}) {logOpen ? '▾' : '▴'}
      </button>
    </footer>
  )
}
