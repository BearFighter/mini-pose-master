// SPDX-License-Identifier: GPL-3.0-or-later
// Installing a pack: the license (title, name and link, attribution, the non-commercial note when
// `nc`) must be accepted first. Downloadable packs install directly; user-supplied packs ask for
// the user's own files or folders.
import { useState } from 'react'
import type { PackInfo } from '../../shared/ipc'
import { api, cleanError } from '../api'
import { fire } from '../store/flow'
import { installPack, installPackFromFiles } from '../store/poseActions'

export const NC_TEXT = "Non-commercial licenses: don't sell prints made with these poses."

export function openLink(url: string): void {
  // The main process opens https links in the system browser (window.open is denied in the app).
  if (/^https:\/\//i.test(url)) window.open(url, '_blank')
}

export function LicenseDialog({ pack, onClose }: { pack: PackInfo; onClose: () => void }) {
  const [accepted, setAccepted] = useState(false)
  const [append, setAppend] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const download = pack.download
  const userSupplied = !!download && 'user_supplied' in download
  const accepts = download && 'accepts' in download ? download.accepts : []
  const exts = accepts.filter((a) => a !== 'folder').map((a) => a.replace(/^\./, ''))
  const folderOk = accepts.includes('folder')

  const chooseAndInstall = async (folders: boolean) => {
    setError(null)
    try {
      const files = await api.dialog.openFiles(folders ? [] : [{ name: 'Motion files', extensions: exts }], folders)
      if (files.length === 0) return
      onClose()
      fire(installPackFromFiles(pack.id, files, append))
    } catch (e) {
      setError(cleanError(e))
    }
  }

  return (
    <div className="modal-backdrop">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="license-title">
        <h2 id="license-title">Install {pack.title}</h2>
        <p>
          License:{' '}
          {pack.license_url ? (
            <button className="link inline" onClick={() => openLink(pack.license_url)}>
              {pack.license}
            </button>
          ) : (
            pack.license
          )}
        </p>
        {pack.attribution && <p className="muted small">{pack.attribution}</p>}
        {pack.nc && <p className="warn">{NC_TEXT}</p>}
        {userSupplied && download && 'instructions' in download && <p className="small instructions">{download.instructions}</p>}
        <label className="toggle-line">
          <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} /> I accept the license
        </label>
        {userSupplied && pack.installed && (
          <label className="toggle-line">
            <input type="checkbox" checked={append} onChange={(e) => setAppend(e.target.checked)} /> Add to the installed clips
          </label>
        )}
        {error && <p className="inline-error">{error}</p>}
        <div className="button-row end">
          <button onClick={onClose}>Cancel</button>
          {userSupplied ? (
            <>
              {folderOk && (
                <button disabled={!accepted} onClick={() => void chooseAndInstall(true)}>
                  Choose folder…
                </button>
              )}
              {exts.length > 0 && (
                <button className="primary" disabled={!accepted} onClick={() => void chooseAndInstall(false)}>
                  Choose file(s)…
                </button>
              )}
            </>
          ) : (
            <button
              className="primary"
              disabled={!accepted}
              onClick={() => {
                onClose()
                fire(installPack(pack.id))
              }}
            >
              Install
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
