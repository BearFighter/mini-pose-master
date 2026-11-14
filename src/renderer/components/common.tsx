// SPDX-License-Identifier: GPL-3.0-or-later
// Small shared UI pieces.
import type { ReactNode } from 'react'

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
