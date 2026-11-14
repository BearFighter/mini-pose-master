// SPDX-License-Identifier: GPL-3.0-or-later
// Marker list for the auto-rig path: lowest confidence first; a click focuses the camera on it.
import { useMemo } from 'react'
import { confidenceColor, displayConfidence, markerListOrder } from '../lib/markers'
import { focusMarker } from '../store/actions'
import { useStore } from '../store'

export function MarkerList() {
  const markers = useStore((s) => s.markers)
  const selection = useStore((s) => s.selection)
  // Order by the suggestion's confidence only when the set of markers changes, so rows don't jump while dragging.
  const keys = markers ? Object.keys(markers).join('|') : ''
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const order = useMemo(() => (markers ? markerListOrder(markers) : []), [keys])
  if (!markers) return null
  return (
    <ul className="marker-list">
      {order.map((name) => {
        const m = markers[name]
        if (!m) return null
        return (
          <li key={name}>
            <button className={selection === name ? 'marker-row selected' : 'marker-row'} onClick={() => focusMarker(name)}>
              <span className="dot" style={{ background: confidenceColor(displayConfidence(m)) }} />
              <span className="marker-name">{name}</span>
              {m.source === 'user' && <span className="badge">edited</span>}
              <span className="confidence">{Math.round(m.confidence * 100)}%</span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
