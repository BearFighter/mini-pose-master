// SPDX-License-Identifier: GPL-3.0-or-later
// Step navigation: the six steps as a numbered sequence with done / current / locked states.
import { useStore } from '../store'
import { STEP_LABELS, STEPS, type Step } from '../store/ui'
import { IconCheck, IconLock } from './icons'

const STEP_HINTS: Record<Step, string> = {
  import: 'Load a model',
  rig: 'Place the joints',
  weapons: 'Arm the figure',
  hands: 'Fingers and grip',
  pose: 'Pick a pose',
  export: 'Bake the STL'
}

export function StepNav() {
  const step = useStore((s) => s.step)
  const setStep = useStore((s) => s.setStep)
  const hasProject = useStore((s) => s.dir !== null)
  const imported = useStore((s) => !!s.data?.source?.orientation)
  const rigged = useStore((s) => !!s.data?.rig)
  const armed = useStore((s) => s.weapons.length > 0)
  const handsSet = useStore((s) => !!(s.hands.L || s.hands.R))
  const posed = useStore((s) => s.poseInputs.source !== null || s.poseInputs.edits.length > 0)

  const done: Partial<Record<Step, boolean>> = { import: imported, rig: rigged, weapons: rigged && armed, hands: rigged && handsSet, pose: rigged && posed }

  return (
    <nav className="sidebar" aria-label="Steps">
      <span className="sidebar-label">Workflow</span>
      <ol className="steps">
        {STEPS.map((name, i) => {
          const current = hasProject && name === step
          const state = !hasProject ? 'locked' : current ? 'current' : done[name] ? 'done' : 'todo'
          return (
            <li key={name} className={`step-item ${state}${done[name] ? ' is-done' : ''}`}>
              <button
                className={name === step ? 'step-button active' : 'step-button'}
                onClick={() => setStep(name)}
                disabled={!hasProject}
                aria-current={current ? 'step' : undefined}
              >
                <span className="step-marker" aria-hidden="true">
                  {!hasProject ? <IconLock size={12} /> : done[name] ? <IconCheck size={14} strokeWidth={2.4} /> : i + 1}
                </span>
                <span className="step-text">
                  <span className="step-label">{STEP_LABELS[name]}</span>
                  <span className="step-hint">{STEP_HINTS[name]}</span>
                </span>
                {done[name] && <span className="sr-only"> (done)</span>}
              </button>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
