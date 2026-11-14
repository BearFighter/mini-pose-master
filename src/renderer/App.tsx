// SPDX-License-Identifier: GPL-3.0-or-later
// App shell: title bar, steps, viewer, step panel, status bar, Blender setup.
import { useEffect } from 'react'
import { BlenderSetup } from './components/BlenderSetup'
import { ErrorBanner } from './components/ErrorBanner'
import { ImportStep } from './components/ImportStep'
import { ProjectsScreen } from './components/ProjectsScreen'
import { RigStep } from './components/RigStep'
import { StatusBar } from './components/StatusBar'
import { StepNav } from './components/StepNav'
import { TitleBar } from './components/TitleBar'
import { fire, loadAppInfo, refreshBlender, saveProject, subscribeEvents } from './store/actions'
import { useStore } from './store'
import { STEP_LABELS } from './store/ui'
import { Viewer } from './viewer/Viewer'

function useAppLifecycle(): void {
  useEffect(() => {
    void loadAppInfo()
    fire(
      refreshBlender().catch((e: unknown) => {
        useStore.getState().setError({ code: 'ERROR', message: `Blender status: ${String(e)}` })
      })
    )
    return subscribeEvents()
  }, [])

  // Ctrl+S saves.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 's') {
        e.preventDefault()
        fire(saveProject())
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Closing with unsaved changes: the main process asks for confirmation (will-prevent-unload).
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!useStore.getState().dirty) return
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])
}

function StepPanel() {
  const hasProject = useStore((s) => s.dir !== null)
  const step = useStore((s) => s.step)
  if (!hasProject) {
    return (
      <div className="step-panel">
        <h2>No project</h2>
        <p className="muted">Create a new project or open one to start.</p>
      </div>
    )
  }
  if (step === 'import') return <ImportStep />
  if (step === 'rig') return <RigStep />
  return (
    <div className="step-panel">
      <h2>{STEP_LABELS[step]}</h2>
      <p className="muted">Coming soon.</p>
    </div>
  )
}

export function App() {
  useAppLifecycle()
  const hasProject = useStore((s) => s.dir !== null)
  return (
    <div className="app">
      <TitleBar />
      <StepNav />
      <main className="viewport">
        <Viewer />
        {!hasProject && <ProjectsScreen />}
        <ErrorBanner />
      </main>
      <aside className="panel">
        <StepPanel />
      </aside>
      <StatusBar />
      <BlenderSetup />
    </div>
  )
}
