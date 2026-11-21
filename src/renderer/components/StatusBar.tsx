// SPDX-License-Identifier: GPL-3.0-or-later
// Status bar: Blender status, the running job (stage, progress, Cancel), and an expandable log tail.
import { useEffect, useRef } from 'react'
import { api, cleanError } from '../api'
import { updateOffer } from '../lib/update'
import { cancelActiveJob, fire } from '../store/actions'
import { useStore } from '../store'
import { IconChevronDown, IconChevronUp, IconClose, IconDownload, IconLog } from './icons'

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
        <span className="log-title">
          <IconLog size={14} /> Job log <span className="muted">(last {log.length} lines)</span>
        </span>
        <button className="ghost small-button" onClick={clearLog}>
          Clear
        </button>
      </div>
      <pre ref={ref}>{log.join('\n')}</pre>
    </div>
  )
}

/** "Update X available", "Restart to update" once downloaded (Windows, Linux), "Download" on macOS. */
function UpdateStatus() {
  const update = useStore((s) => s.update)
  const platform = useStore((s) => s.info?.platform)
  const offer = updateOffer(update, platform)
  if (!offer) return null
  const install = () => fire(api.app.installUpdate().catch((e: unknown) => useStore.getState().setError({ code: 'ERROR', message: `Update: ${cleanError(e)}` })))
  return (
    <span className="status-update">
      <span className="status-item update">
        <IconDownload size={13} />
        {offer.text}
      </span>
      {offer.button && (
        <button className="primary small-button" onClick={install} title={offer.button === 'restart' ? 'Quit, install the update and start again' : 'Open the release page'}>
          {offer.button === 'restart' ? 'Restart to update' : 'Download'}
        </button>
      )}
    </span>
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
        <span className={blender === null ? 'status-dot' : blender.found ? 'status-dot ok' : 'status-dot warn'} aria-hidden="true" />
        {blender === null ? 'Checking Blender…' : blender.found ? `Blender ${blender.version}` : 'Blender not found'}
      </button>
      <span className="status-sep" aria-hidden="true" />
      <div className="status-job">
        {active ? (
          <>
            <span className="spinner" aria-hidden="true" />
            <span className="job-label">{active.label}</span>
            <span className="job-stage">{progress?.message || progress?.stage || ''}</span>
            <span className="mini-progress">
              <span style={{ width: `${pct}%` }} />
            </span>
            <span className="job-pct">{pct}%</span>
            <button className="ghost small-button" onClick={() => fire(cancelActiveJob())} disabled={!active.jobId}>
              <IconClose size={12} />
              Cancel
            </button>
          </>
        ) : (
          <span className="status-ready">Ready</span>
        )}
      </div>
      <UpdateStatus />
      <button className={logOpen ? 'status-item open' : 'status-item'} onClick={() => setLogOpen(!logOpen)} aria-expanded={logOpen}>
        <IconLog size={13} />
        Log ({logCount}) {logOpen ? <IconChevronDown size={12} /> : <IconChevronUp size={12} />}
      </button>
    </footer>
  )
}
