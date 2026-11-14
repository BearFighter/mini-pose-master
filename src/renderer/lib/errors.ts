// SPDX-License-Identifier: GPL-3.0-or-later
// Formatting of job error details for the error banner.

/** The numeric entries of a job error's detail, e.g. "moved_fraction 0.031, worst_drift 0.012". */
export function detailNumbers(detail: Record<string, unknown> | undefined): string {
  if (!detail) return ''
  return Object.entries(detail)
    .filter(([, v]) => typeof v === 'number' && Number.isFinite(v))
    .map(([k, v]) => `${k} ${Number((v as number).toPrecision(3))}`)
    .join(', ')
}
