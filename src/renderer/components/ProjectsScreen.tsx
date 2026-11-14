// SPDX-License-Identifier: GPL-3.0-or-later
// No project open: New (name + parent folder), Open (.mposer or folder), Recent projects.
import { useState } from 'react'
import { api, cleanError } from '../api'
import { basename, dirname } from '../lib/paths'
import { loadRecent, removeRecent, type RecentProject } from '../lib/recent'
import { chooseAndOpenProject, createProject, fire, openProject } from '../store/actions'
import { useStore } from '../store'

export function ProjectsScreen() {
  const [name, setName] = useState('My miniature')
  const [parent, setParent] = useState('')
  const [folder, setFolder] = useState('')
  const [recent, setRecent] = useState<RecentProject[]>(() => loadRecent())
  const [localError, setLocalError] = useState<string | null>(null)
  const busy = useStore((s) => s.active !== null)

  const browse = async () => {
    setLocalError(null)
    try {
      // There is no folder picker in the IPC contract: a save dialog picks the location and the name.
      const target = await api.dialog.saveFile(name.trim() || 'My miniature', [{ name: 'Project folder', extensions: ['*'] }])
      if (!target) return
      setParent(dirname(target))
      setName(basename(target).replace(/\.mposer$/i, ''))
    } catch (e) {
      setLocalError(cleanError(e))
    }
  }

  const create = () => {
    if (!name.trim() || !parent.trim()) {
      setLocalError('Enter a project name and choose where to create it.')
      return
    }
    setLocalError(null)
    fire(createProject(name.trim(), parent.trim()))
  }

  return (
    <div className="projects-screen">
      <div className="projects-card">
        <h1>Mini Pose Master</h1>
        <p className="muted">Rig, pose and bake 3D characters into printable miniatures.</p>

        <section>
          <h2>New project</h2>
          <label className="field">
            <span>Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="My miniature" />
          </label>
          <label className="field">
            <span>Create in folder</span>
            <div className="field-row">
              <input value={parent} onChange={(e) => setParent(e.target.value)} placeholder="Choose a folder…" />
              <button onClick={() => void browse()}>Browse…</button>
            </div>
          </label>
          <button className="primary" onClick={create} disabled={busy}>
            Create project
          </button>
        </section>

        <section>
          <h2>Open project</h2>
          <div className="button-row">
            <button onClick={() => fire(chooseAndOpenProject())} disabled={busy}>
              Open .mposer file…
            </button>
          </div>
          <label className="field">
            <span>Or a project folder</span>
            <div className="field-row">
              <input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="Paste the project folder path" />
              <button onClick={() => folder.trim() && fire(openProject(folder.trim()))} disabled={busy || !folder.trim()}>
                Open
              </button>
            </div>
          </label>
        </section>

        {localError && <p className="inline-error">{localError}</p>}

        {recent.length > 0 && (
          <section>
            <h2>Recent projects</h2>
            <ul className="recent">
              {recent.map((r) => (
                <li key={r.dir}>
                  <button className="link" onClick={() => fire(openProject(r.dir))} disabled={busy} title={r.dir}>
                    <strong>{r.name}</strong>
                    <span className="muted">{r.dir}</span>
                  </button>
                  <button className="icon" title="Remove from the list" onClick={() => setRecent(removeRecent(r.dir))}>
                    ×
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  )
}
