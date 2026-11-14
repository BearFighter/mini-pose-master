// SPDX-License-Identifier: GPL-3.0-or-later
// Step buttons. Pose, Hands, Weapons and Export are placeholders for now.
import { useStore } from '../store'
import { STEP_LABELS, STEPS, type Step } from '../store/ui'

export function StepNav() {
  const step = useStore((s) => s.step)
  const setStep = useStore((s) => s.setStep)
  const hasProject = useStore((s) => s.dir !== null)
  const imported = useStore((s) => !!s.data?.source?.orientation)
  const rigged = useStore((s) => !!s.data?.rig)

  const done: Partial<Record<Step, boolean>> = { import: imported, rig: rigged }

  return (
    <nav className="sidebar">
      {STEPS.map((name) => (
        <button
          key={name}
          className={name === step ? 'step-button active' : 'step-button'}
          onClick={() => setStep(name)}
          disabled={!hasProject}
        >
          {STEP_LABELS[name]}
          {done[name] && <span className="check">✓</span>}
        </button>
      ))}
    </nav>
  )
}
