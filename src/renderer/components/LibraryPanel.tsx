// SPDX-License-Identifier: GPL-3.0-or-later
// Pose library (left side of the Pose step): packs with install / update / remove, the user's own
// BVH import, and the selected pack's clips.
import { useEffect, useState } from 'react'
import type { PackInfo } from '../../shared/ipc'
import { useStore } from '../store'
import { fire } from '../store/flow'
import { cancelInstall, importOwnBvh, refreshPacks, removePack, selectPack, updatePack } from '../store/poseActions'
import { ClipList } from './ClipList'
import { ProgressBar } from './common'
import { LicenseDialog } from './LicenseDialog'
import { IconDownload, IconPlus } from './icons'

function PackRow({ pack, selected, onInstall }: { pack: PackInfo; selected: boolean; onInstall: () => void }) {
  const progress = useStore((s) => s.installs[pack.id])
  const busy = !!progress || pack.busy
  return (
    <li className={selected ? 'pack selected' : 'pack'}>
      <button className="pack-main" disabled={!pack.installed} onClick={() => fire(selectPack(pack.id))} title={pack.title}>
        <span className="pack-title">{pack.title}</span>
        <span className="muted small">
          <span className={pack.installed ? 'pack-dot on' : 'pack-dot'} aria-hidden="true" />
          {pack.installed ? `${pack.clips} clips` : 'not installed'} · {pack.license}
          {pack.nc ? ' · non-commercial' : ''}
        </span>
      </button>
      {progress ? (
        <div className="pack-progress">
          <ProgressBar fraction={progress.fraction} label={progress.stage} />
          <button onClick={() => fire(cancelInstall(pack.id))}>Cancel</button>
        </div>
      ) : (
        <div className="pack-actions">
          {!pack.installed && pack.id !== 'mine' && (
            <button disabled={busy} onClick={onInstall}>
              <IconDownload size={13} />
              Install…
            </button>
          )}
          {pack.installed && pack.stale && (
            <button disabled={busy} onClick={() => fire(updatePack(pack.id))} title="Convert the clips again with the new converter">
              Update
            </button>
          )}
          {pack.installed && pack.id !== 'mine' && 'user_supplied' in (pack.download ?? {}) && (
            <button disabled={busy} onClick={onInstall} title="Add or replace clips">
              Add…
            </button>
          )}
          {pack.installed && (
            <button className="danger" disabled={busy} onClick={() => fire(removePack(pack.id))}>
              Remove
            </button>
          )}
        </div>
      )}
    </li>
  )
}

export function LibraryPanel() {
  const packs = useStore((s) => s.packs)
  const selected = useStore((s) => s.selectedPack)
  const mineBusy = useStore((s) => !!s.installs.mine)
  const [licenseFor, setLicenseFor] = useState<PackInfo | null>(null)

  useEffect(() => {
    if (!packs) fire(refreshPacks())
  }, [packs])

  return (
    <aside className="library">
      <div className="library-head">
        <h2>Poses</h2>
        <button disabled={mineBusy} onClick={() => fire(importOwnBvh())}>
          <IconPlus size={13} />
          Import my own BVH…
        </button>
      </div>
      {packs === null ? (
        <p className="muted small pad">Loading the library…</p>
      ) : (
        <ul className="packs">
          {packs.map((p) => (
            <PackRow key={p.id} pack={p} selected={p.id === selected} onInstall={() => setLicenseFor(p)} />
          ))}
        </ul>
      )}
      <ClipList />
      {licenseFor && <LicenseDialog pack={licenseFor} onClose={() => setLicenseFor(null)} />}
    </aside>
  )
}
