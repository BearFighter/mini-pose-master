// SPDX-License-Identifier: GPL-3.0-or-later
// Title bar: project name with an unsaved-changes marker, Save, Close project, Settings.
import { useEffect } from 'react'
import { projectName } from '../lib/paths'
import { closeProject, fire, saveProject } from '../store/actions'
import { useStore } from '../store'
import { IconClose, IconSave, IconSettings, LogoMark } from './icons'

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
      <span className="brand">
        <LogoMark size={20} />
        <span className="app-name">Mini Pose Master</span>
      </span>
      {name && (
        <>
          <span className="crumb-sep" aria-hidden="true">
            /
          </span>
          <span className="project-name" title={dir ?? undefined}>
            {name}
            {dirty && <span className="dirty" title="Unsaved changes" aria-label="Unsaved changes" />}
          </span>
        </>
      )}
      <span className="spacer" />
      {name && (
        <>
          <button className="ghost" onClick={() => fire(saveProject())} disabled={!dirty} title="Save (Ctrl+S)">
            <IconSave size={14} />
            Save
          </button>
          <button className="ghost" onClick={() => closeProject()} disabled={busy}>
            <IconClose size={14} />
            Close project
          </button>
          <span className="title-divider" aria-hidden="true" />
        </>
      )}
      <button className="ghost" onClick={() => setShowBlenderSetup(true)} title="Blender setup">
        <IconSettings size={14} />
        Settings
      </button>
    </header>
  )
}
