// SPDX-License-Identifier: GPL-3.0-or-later
// Small shared UI pieces.
import type { ReactNode } from 'react'
import { STEP_LABELS, STEPS, type Step } from '../store/ui'
import { IconExport, IconHand, IconImport, IconPose, IconRig, IconSword, type IconProps } from './icons'

/** The icon of each step (step navigation and panel headers). */
export const STEP_ICONS: Record<Step, (p: IconProps) => ReactNode> = {
  import: IconImport,
  rig: IconRig,
  pose: IconPose,
  hands: IconHand,
  weapons: IconSword,
  export: IconExport
}

/** Panel header of a step: icon, "Step n of 6", the step's title (h2) and optional actions. */
export function StepHeader({ step, children }: { step: Step; children?: ReactNode }) {
  const Icon = STEP_ICONS[step]
  return (
    <header className="step-head">
      <span className="step-head-icon">
        <Icon size={18} />
      </span>
      <span className="step-head-text">
        <span className="eyebrow">
          Step {STEPS.indexOf(step) + 1} of {STEPS.length}
        </span>
        <h2>{STEP_LABELS[step]}</h2>
      </span>
      {children && <span className="step-head-actions">{children}</span>}
    </header>
  )
}

/** A centred message for a panel with nothing to show yet. */
export function EmptyState({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="empty-state">
      {icon && <span className="empty-icon">{icon}</span>}
      <p className="empty-title">{title}</p>
      {children && <div className="empty-body">{children}</div>}
    </div>
  )
}

export function ProgressBar({ fraction, label }: { fraction: number | null; label?: string }) {
  const pct = fraction === null ? null : Math.round(Math.min(1, Math.max(0, fraction)) * 100)
  return (
    <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined}>
      <div className={pct === null ? 'progress-fill indeterminate' : 'progress-fill'} style={pct === null ? undefined : { width: `${pct}%` }} />
      {label && <span className="progress-label">{label}</span>}
    </div>
  )
}

export function Section({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="card">
      <header className="card-header">
        <h3>{title}</h3>
        {actions}
      </header>
      {children}
    </section>
  )
}

export function Warnings({ items }: { items: string[] }) {
  if (items.length === 0) return null
  return (
    <ul className="warnings">
      {items.map((w, i) => (
        <li key={i}>{w}</li>
      ))}
    </ul>
  )
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`
  return `${(bytes / 1024 ** 2).toFixed(0)} MB`
}

export function percent(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)} %`
}
