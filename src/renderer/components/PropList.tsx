// SPDX-License-Identifier: GPL-3.0-or-later
// Weapons step, "From this model": the props the import left out of the character (already saved in
// the project as props/<name>.glb), each with "Add as weapon".
import { useMemo } from 'react'
import { propRows } from '../lib/parts'
import { useStore } from '../store'
import { fire } from '../store/flow'
import { addPropWeapon } from '../store/weaponActions'
import { Section } from './common'

/** `free`: a hand socket is still free (one weapon per hand). */
export function PropList({ free }: { free: boolean }) {
  const info = useStore((s) => s.importInfo)
  const weapons = useStore((s) => s.weapons)
  const busy = useStore((s) => s.active !== null)
  const rows = useMemo(() => propRows(info, weapons), [info, weapons])
  if (rows.length === 0) return null
  return (
    <Section title="From this model">
      <p className="muted small">Props that came with the model. They are not part of the character.</p>
      <ul className="prop-list">
        {rows.map((r) => (
          <li key={r.file}>
            <span className="prop-name">{r.objects.join(', ')}</span>
            <span className="muted small" title="Longest side">
              {r.longestCm.toFixed(1)} cm
            </span>
            {r.added ? (
              <span className="badge">added</span>
            ) : (
              <button disabled={busy || !free} onClick={() => fire(addPropWeapon(r.file))} title={free ? '' : 'Both hands hold a weapon'}>
                Add as weapon
              </button>
            )}
          </li>
        ))}
      </ul>
    </Section>
  )
}
