// SPDX-License-Identifier: GPL-3.0-or-later
// Title bar: project name with an unsaved-changes marker, Save, Close project, Settings.
import { useEffect } from 'react'
import { projectName } from '../lib/paths'
import { closeProject, fire, saveProject } from '../store/actions'
import { useStore } from '../store'

export function TitleBar() {
  const dir = useStore((s) => s.dir)
  const dirty = useStore((s) => s.dirty)
  const busy = useStore((s) => s.active !== null)
  const setShowBlenderSetup = useStore((s) => s.setShowBlenderSetup)
  const name = dir ? projectName(dir) : null

  useEffect(() => {
    document.title = name ? `${name}${dirty ? ' *' : ''} - Mini Pose Master` : 'Mini Pose Master'
  }, [name, dirty])

  return (
    <header className="title-bar">
      <span className="app-name">Mini Pose Master</span>
      {name && (
        <span className="project-name" title={dir ?? undefined}>
          {name}
          {dirty && (
            <span className="dirty" title="Unsaved changes">
              {' '}
              ●
            </span>
          )}
        </span>
      )}
      <span className="spacer" />
      {name && (
        <>
          <button onClick={() => fire(saveProject())} disabled={!dirty} title="Save (Ctrl+S)">
            Save
          </button>
          <button onClick={() => closeProject()} disabled={busy}>
            Close project
          </button>
        </>
      )}
      <button onClick={() => setShowBlenderSetup(true)} title="Blender setup">
        Settings
      </button>
    </header>
  )
}
