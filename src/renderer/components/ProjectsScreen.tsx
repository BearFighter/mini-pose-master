// SPDX-License-Identifier: GPL-3.0-or-later
// No project open: New (name + parent folder), Open (.mposer file or project folder), Recent projects.
import { useState } from 'react'
import { api, cleanError } from '../api'
import { loadRecent, removeRecent, type RecentProject } from '../lib/recent'
import { chooseAndOpenProject, createProject, fire, openProject } from '../store/actions'
import { useStore } from '../store'
import { IconClose, IconFile, IconFolder, IconPlus, LogoMark } from './icons'

export function ProjectsScreen() {
  const [name, setName] = useState('My miniature')
  const [parent, setParent] = useState('')
  const [recent, setRecent] = useState<RecentProject[]>(() => loadRecent())
  const [localError, setLocalError] = useState<string | null>(null)
  const busy = useStore((s) => s.active !== null)

  const browse = async () => {
    setLocalError(null)
    try {
      const dir = await api.dialog.openFolder('Where to create the project')
      if (dir) setParent(dir)
    } catch (e) {
      setLocalError(cleanError(e))
    }
  }

  const openFolder = async () => {
    setLocalError(null)
    try {
      const dir = await api.dialog.openFolder('Open a project folder')
      if (dir) fire(openProject(dir))
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
        <div className="projects-hero">
          <LogoMark size={44} />
          <div>
            <h1>Mini Pose Master</h1>
            <p className="muted">Rig, pose and bake 3D characters into printable miniatures.</p>
          </div>
        </div>

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
              <button onClick={() => void browse()}>
                <IconFolder size={14} />
                Browse…
              </button>
            </div>
          </label>
          <button className="primary" onClick={create} disabled={busy}>
            <IconPlus size={15} />
            Create project
          </button>
        </section>

        <section>
          <h2>Open project</h2>
          <div className="button-row">
            <button onClick={() => fire(chooseAndOpenProject())} disabled={busy}>
              <IconFile size={14} />
              Open .mposer file…
            </button>
            <button onClick={() => void openFolder()} disabled={busy}>
              <IconFolder size={14} />
              Open project folder…
            </button>
          </div>
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
                  <button className="icon" title="Remove from the list" aria-label="Remove from the list" onClick={() => setRecent(removeRecent(r.dir))}>
                    <IconClose size={14} />
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
