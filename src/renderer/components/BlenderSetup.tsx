// SPDX-License-Identifier: GPL-3.0-or-later
// Blender setup: shown on start while Blender 5.2 is not found (not dismissible then), and from
// Settings later. Locate an installed Blender or download it with progress and Cancel.
import { useEffect, useState } from 'react'
import type { FileFilter } from '../../shared/ipc'
import { api, cleanError } from '../api'
import { useStore } from '../store'
import { formatBytes, ProgressBar } from './common'
import { IconDownload, IconFolder } from './icons'

function blenderFilters(platform: string | undefined): FileFilter[] {
  if (platform === 'win32') return [{ name: 'Blender (blender.exe)', extensions: ['exe'] }]
  if (platform === 'darwin') return [{ name: 'Blender.app', extensions: ['app'] }]
  return [{ name: 'All files', extensions: ['*'] }]
}

export function BlenderSetup() {
  const status = useStore((s) => s.blender)
  const show = useStore((s) => s.showBlenderSetup)
  const platform = useStore((s) => s.info?.platform)
  const setBlenderStatus = useStore((s) => s.setBlenderStatus)
  const setShow = useStore((s) => s.setShowBlenderSetup)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'locate' | 'download' | null>(null)
  const [progress, setProgress] = useState<{ bytes: number; total: number } | null>(null)

  useEffect(() => api.on('blender:progress', (p) => setProgress(p)), [])

  const found = status?.found === true
  if (status === null || (found && !show)) return null

  const locate = async () => {
    setError(null)
    const file = await api.dialog.openFile(blenderFilters(platform)).catch((e: unknown) => {
      setError(cleanError(e))
      return null
    })
    if (!file) return
    setBusy('locate')
    try {
      setBlenderStatus(await api.blender.setPath(file))
    } catch (e) {
      setError(cleanError(e))
    } finally {
      setBusy(null)
    }
  }

  const download = async () => {
    setError(null)
    setProgress(null)
    setBusy('download')
    try {
      setBlenderStatus(await api.blender.download())
    } catch (e) {
      setError(cleanError(e))
    } finally {
      setBusy(null)
      setProgress(null)
    }
  }

  const fraction = progress && progress.total > 0 ? progress.bytes / progress.total : null

  return (
    <div className="modal-backdrop">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="blender-setup-title">
        <h2 id="blender-setup-title">Blender setup</h2>
        <p>
          Mini Pose Master uses <strong>Blender 5.2</strong> (free, GPL) behind the scenes to import, rig and bake your
          models. It runs in the background; you never have to open it yourself.
        </p>
        {found ? (
          <p className="ok status-line">
            Using Blender {status.version} ({status.source}): <code>{status.path}</code>
          </p>
        ) : (
          <p className="warn status-line">Blender 5.2 was not found on this computer.</p>
        )}

        <div className="button-row">
          <button onClick={() => void locate()} disabled={busy !== null}>
            <IconFolder size={14} />
            {busy === 'locate' ? 'Checking…' : 'Locate Blender…'}
          </button>
          <button onClick={() => void download()} disabled={busy !== null}>
            <IconDownload size={14} />
            Download Blender 5.2 (~400 MB download, ~1.2 GB installed)
          </button>
        </div>

        {busy === 'download' && (
          <div className="download">
            <ProgressBar
              fraction={fraction}
              label={progress ? `${formatBytes(progress.bytes)}${progress.total ? ` of ${formatBytes(progress.total)}` : ''}` : 'Starting…'}
            />
            <button onClick={() => void api.blender.cancelDownload()}>Cancel</button>
          </div>
        )}

        {error && <p className="inline-error">{error}</p>}

        {found && (
          <div className="button-row end">
            <button className="primary" onClick={() => setShow(false)} disabled={busy !== null}>
              Done
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
