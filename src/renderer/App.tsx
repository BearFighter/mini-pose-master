// SPDX-License-Identifier: GPL-3.0-or-later
// App shell: title bar, steps, viewer, step panel, status bar, Blender setup.
import { useEffect } from 'react'
import { BlenderSetup } from './components/BlenderSetup'
import { EmptyState, StepHeader } from './components/common'
import { ErrorBanner } from './components/ErrorBanner'
import { ExportStep } from './components/ExportStep'
import { HandsStep } from './components/HandsStep'
import { IconFolder, IconImport } from './components/icons'
import { ImportStep } from './components/ImportStep'
import { LibraryPanel } from './components/LibraryPanel'
import { PoseStep } from './components/PoseStep'
import { ProjectsScreen } from './components/ProjectsScreen'
import { RigStep } from './components/RigStep'
import { nextKey, Scrubber } from './components/Scrubber'
import { StatusBar } from './components/StatusBar'
import { StepNav } from './components/StepNav'
import { TitleBar } from './components/TitleBar'
import { WeaponsStep } from './components/WeaponsStep'
import { fire, loadAppInfo, refreshBlender, saveProject, subscribeEvents } from './store/actions'
import { useStore } from './store'
import { commitFrame, redoPose, undoPose } from './store/poseActions'
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
      if (!['pose', 'hands', 'weapons'].includes(s.step) || isTextField(e.target)) return
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
      if (!mod && s.step === 'pose' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
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

/** Viewport overlay while there is nothing to look at: "Import a model to begin", or the import running. */
function ViewportHint() {
  const hasProject = useStore((s) => s.dir !== null)
  const empty = useStore((s) => s.previewUrl === null && (s.rigJson === null || s.glbUrl === null))
  const importing = useStore((s) => s.active?.type === 'import')
  const label = useStore((s) => (s.active?.type === 'import' ? s.progress?.message || s.active.label : ''))
  if (!hasProject || !empty) return null
  return (
    <div className="viewport-hint" aria-live="polite">
      {importing ? (
        <>
          <span className="spinner large" aria-hidden="true" />
          <p className="viewport-hint-title">Importing the model…</p>
          {label && <p className="viewport-hint-body">{label}</p>}
        </>
      ) : (
        <>
          <span className="viewport-hint-icon">
            <IconImport size={26} />
          </span>
          <p className="viewport-hint-title">Import a model to begin</p>
          <p className="viewport-hint-body">FBX, glTF/GLB, OBJ, STL or PLY. Use Choose model… in the panel on the right.</p>
        </>
      )}
    </div>
  )
}

function StepPanel() {
  const hasProject = useStore((s) => s.dir !== null)
  const step = useStore((s) => s.step)
  if (!hasProject) {
    return (
      <div className="step-panel">
        <EmptyState icon={<IconFolder size={22} />} title="No project open">
          <p>Create a new project or open one to start.</p>
        </EmptyState>
      </div>
    )
  }
  if (step === 'import') return <ImportStep />
  if (step === 'rig') return <RigStep />
  if (step === 'pose') return <PoseStep />
  if (step === 'hands') return <HandsStep />
  if (step === 'weapons') return <WeaponsStep />
  if (step === 'export') return <ExportStep />
  return (
    <div className="step-panel">
      <StepHeader step={step} />
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
        <ViewportHint />
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
