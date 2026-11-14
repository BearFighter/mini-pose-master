// SPDX-License-Identifier: GPL-3.0-or-later
// Choices of the Import step's orientation panel (the `import` job's `orientation` argument).
import type { Axis, Orientation } from '../../shared/project'

export const AXES: Axis[] = ['Z', '-Z', 'Y', '-Y', 'X', '-X']

/** The engine's unit-scale candidates (engine/mpm/importer.py UNIT_SCALE_CANDIDATES). */
export const UNIT_SCALES: { value: number; label: string }[] = [
  { value: 1, label: 'metres (x1)' },
  { value: 0.01, label: 'centimetres (x0.01)' },
  { value: 0.001, label: 'millimetres (x0.001)' },
  { value: 0.0254, label: 'inches (x0.0254)' },
  { value: 100, label: 'x100' }
]

const letter = (a: Axis): string => a.replace('-', '')

/** Forward axes that are perpendicular to `up`. */
export function forwardChoices(up: Axis): Axis[] {
  return AXES.filter((a) => letter(a) !== letter(up))
}

/** Keeps `forward` when it is perpendicular to `up`, else the first negative perpendicular axis (Z up -> -Y). */
export function withUp(o: Orientation, up: Axis): Orientation {
  const choices = forwardChoices(up)
  return { ...o, up, forward: choices.includes(o.forward) ? o.forward : choices[1] }
}

/** Only the three fields of an orientation (the import result's suggestion also has a `reason`). */
export function pickOrientation(o: Orientation): Orientation {
  return { up: o.up, forward: o.forward, unit_scale: Number(o.unit_scale) }
}

export function sameOrientation(a: Orientation | null | undefined, b: Orientation | null | undefined): boolean {
  if (!a || !b) return false
  return a.up === b.up && a.forward === b.forward && Math.abs(a.unit_scale - b.unit_scale) < 1e-12
}

/** A unit-scale option list that also contains `value` (a scale typed into an older project). */
export function unitScaleChoices(value: number): { value: number; label: string }[] {
  if (UNIT_SCALES.some((u) => Math.abs(u.value - value) < 1e-12)) return UNIT_SCALES
  return [...UNIT_SCALES, { value, label: `x${value}` }]
}
