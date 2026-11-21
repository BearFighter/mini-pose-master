// SPDX-License-Identifier: GPL-3.0-or-later
// Import step, "Parts": which objects of the file are the character. Props shipped beside the model
// are left out by the import job; "Apply" imports again with the user's ticks.
import { useEffect, useState } from 'react'
import type { ImportObjectInfo } from '../../shared/jobResults'
import type { PartsChoice } from '../../shared/project'
import { includedMap, partsChoice, partsDirty, withTick } from '../lib/parts'
import { applyParts, fire } from '../store/actions'
import { useStore } from '../store'
import { Section } from './common'

export function PartsPanel({ parts }: { parts: ImportObjectInfo[] }) {
  const busy = useStore((s) => s.active !== null)
  const [ticks, setTicks] = useState<PartsChoice>(() => includedMap(parts))
  // Follow the import: a new summary shows what is included now.
  useEffect(() => {
    setTicks(includedMap(parts))
  }, [parts])

  return (
    <Section title="Parts">
      <ul className="parts">
        {parts.map((p) => {
          const on = ticks[p.name] ?? p.included
          return (
            <li key={p.name}>
              <label className={on ? 'part' : 'part off'}>
                <input type="checkbox" checked={on} disabled={busy} onChange={(e) => setTicks(withTick(ticks, p.name, e.target.checked))} />
                <span className="part-name">{p.name}</span>
                {p.prop && (
                  <span className="badge" title="This looks like a prop beside the character">
                    prop?
                  </span>
                )}
                <span className="part-tris">{p.tris.toLocaleString('en-US')} triangles</span>
              </label>
            </li>
          )
        })}
      </ul>
      <p className="muted small">
        Unticked parts are left out of the character. Props (such as a weapon lying beside the model) are left out automatically; you can
        add them as weapons in the Weapons step.
      </p>
      <div className="button-row">
        <button className="primary" disabled={busy || !partsDirty(parts, ticks)} onClick={() => fire(applyParts(partsChoice(parts, ticks)))}>
          Apply
        </button>
      </div>
    </Section>
  )
}
