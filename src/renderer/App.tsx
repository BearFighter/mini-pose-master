// SPDX-License-Identifier: GPL-3.0-or-later
// App shell: title bar, steps, viewer, step panel, status bar, Blender setup.
import { useEffect } from 'react'
import { BlenderSetup } from './components/BlenderSetup'
import { ErrorBanner } from './components/ErrorBanner'
import { ImportStep } from './components/ImportStep'
import { LibraryPanel } from './components/LibraryPanel'
import { PoseStep } from './components/PoseStep'
import { ProjectsScreen } from './components/ProjectsScreen'
import { RigStep } from './components/RigStep'
import { nextKey, Scrubber } from './components/Scrubber'
import { StatusBar } from './components/StatusBar'
import { StepNav } from './components/StepNav'
import { TitleBar } from './components/TitleBar'
import { fire, loadAppInfo, refreshBlender, saveProject, subscribeEvents } from './store/actions'
import { useStore } from './store'
import { commitFrame, redoPose, undoPose } from './store/poseActions'
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

  // Pose step: Ctrl+Z undo, Ctrl+Shift+Z / Ctrl+Y redo, arrows step frames (Shift: key frames).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useStore.getState()
      if (s.step !== 'pose' || isTextField(e.target)) return
      const mod = e.ctrlKey || e.metaKey
      const key = e.key.toLowerCase()
      if (mod && !e.altKey && key === 'z') {
        e.preventDefault()
        if (e.shiftKey) redoPose()
        else undoPose()
        return
      }
      if (mod && !e.altKey && key === 'y') {
        e.preventDefault()
        redoPose()
        return
      }
      if (!mod && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        const src = s.poseInputs.source
        const clip = s.loadedClip
        if (!src || !clip || clip.clipId !== src.clip || clip.packId !== src.pack) return
        e.preventDefault()
        const dir = e.key === 'ArrowRight' ? 1 : -1
        commitFrame(e.shiftKey ? nextKey(clip.entry.key_frames ?? [], src.frame, dir, clip.frames) : src.frame + dir)
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
  if (step === 'pose') return <PoseStep />
  return (
    <div className="step-panel">
      <h2>{STEP_LABELS[step]}</h2>
      <p className="muted">Coming soon.</p>
    </div>
  )
}

/** Keyboard shortcuts stay out of text fields (and other form controls). */
function isTextField(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || !el.tagName) return false
  const tag = el.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable
}

export function App() {
  useAppLifecycle()
  const hasProject = useStore((s) => s.dir !== null)
  const posing = useStore((s) => s.step === 'pose' && s.dir !== null && s.rigJson !== null)
  return (
    <div className={posing ? 'app posing' : 'app'}>
      <TitleBar />
      <StepNav />
      {posing && <LibraryPanel />}
      <main className="viewport">
        <Viewer />
        {!hasProject && <ProjectsScreen />}
        {posing && <Scrubber />}
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
