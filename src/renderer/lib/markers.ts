// SPDX-License-Identifier: GPL-3.0-or-later
// Pure marker helpers for the Rig step: confidence colours, mirrored edits, list order, hand groups.
import type { Vec3 } from '../../shared/coords'
import type { MarkerMap } from '../../shared/project'
import { deriveJoints } from '../../shared/derive'
import { JOINTS, mirrorName } from '../../shared/skeleton'

export type ConfidenceLevel = 'high' | 'medium' | 'low'

/** green >= 0.8, amber 0.5-0.8, red < 0.5 */
export function confidenceLevel(confidence: number): ConfidenceLevel {
  if (confidence >= 0.8) return 'high'
  if (confidence >= 0.5) return 'medium'
  return 'low'
}

export const CONFIDENCE_COLORS: Record<ConfidenceLevel, string> = {
  high: '#3fb950',
  medium: '#d29922',
  low: '#f85149'
}

export function confidenceColor(confidence: number): string {
  return CONFIDENCE_COLORS[confidenceLevel(confidence)]
}

/** The confidence used for display: a marker the user placed counts as certain. */
export function displayConfidence(entry: { confidence: number; source: 'auto' | 'user' }): number {
  return entry.source === 'user' ? 1 : entry.confidence
}

/** Mirror of a point in x (contracts section 5: S = diag(-1, 1, 1)). */
export function mirrorX(p: Vec3): Vec3 {
  return [-p[0], p[1], p[2]]
}

/**
 * Moves marker `name` to `p` (Blender frame) and marks it as placed by the user. With `mirror`,
 * the L/R partner (if it exists) moves to the x-mirrored position too. Returns a new map.
 */
export function moveMarker(markers: MarkerMap, name: string, p: Vec3, mirror: boolean): MarkerMap {
  const current = markers[name]
  if (!current) return markers
  const out: MarkerMap = { ...markers, [name]: { ...current, p: [p[0], p[1], p[2]], source: 'user' } }
  if (mirror) {
    const partner = mirrorName(name)
    const other = markers[partner]
    if (partner !== name && other) out[partner] = { ...other, p: mirrorX(p), source: 'user' }
  }
  return out
}

const JOINT_ORDER = new Map(JOINTS.map((j, i) => [j.name, i]))

/** Marker names for the list: lowest (stored) confidence first, then skeleton order. */
export function markerListOrder(markers: MarkerMap): string[] {
  return Object.keys(markers).sort((a, b) => {
    const d = markers[a].confidence - markers[b].confidence
    if (d !== 0) return d
    return (JOINT_ORDER.get(a) ?? 1e9) - (JOINT_ORDER.get(b) ?? 1e9)
  })
}

const FINGER_RE = /^(thumb|index|middle|ring|pinky)_(0|1|2|tip)_[LR]$/
const FINGERS = ['thumb', 'index', 'middle', 'ring', 'pinky'] as const

/** The optional knuckle points of one hand: the two middle joints of each finger. */
export function knucklePointNames(side: 'L' | 'R'): string[] {
  return FINGERS.flatMap((f) => [`${f}_1_${side}`, `${f}_2_${side}`])
}

/** Does this hand have any knuckle points (found by the engine on curved fingers, or added by the user)? */
export function hasKnucklePoints(markers: MarkerMap, side: 'L' | 'R'): boolean {
  return knucklePointNames(side).some((n) => markers[n] !== undefined)
}

/**
 * Adds the missing knuckle points of one hand where the straight-line rule puts them now, so they can be
 * dragged onto a curved finger. Existing ones are kept. Returns a new map (the same one if nothing can be
 * derived yet).
 */
export function addKnucklePoints(markers: MarkerMap, side: 'L' | 'R'): MarkerMap {
  let J: ReturnType<typeof deriveJoints>
  try {
    J = deriveJoints(Object.fromEntries(Object.entries(markers).map(([k, v]) => [k, v.p])))
  } catch {
    return markers
  }
  const out: MarkerMap = { ...markers }
  for (const n of knucklePointNames(side)) {
    if (out[n] || !J[n]) continue
    out[n] = { p: [J[n].x, J[n].y, J[n].z], confidence: 1, source: 'user' }
  }
  return out
}

/** Removes one hand's knuckle points: its fingers go back to straight lines from knuckle to tip. */
export function removeKnucklePoints(markers: MarkerMap, side: 'L' | 'R'): MarkerMap {
  const drop = new Set(knucklePointNames(side))
  return Object.fromEntries(Object.entries(markers).filter(([k]) => !drop.has(k)))
}

/** Finger markers (knuckles, knuckle points, fingertips), drawn smaller. */
export function isFingerMarker(name: string): boolean {
  return FINGER_RE.test(name)
}

/** The markers of one hand: the wrist and the finger markers of that side. */
export function handMarkerNames(markers: MarkerMap, side: 'L' | 'R'): string[] {
  return Object.keys(markers).filter((n) => n === `wrist_${side}` || (isFingerMarker(n) && n.endsWith(`_${side}`)))
}

/**
 * The hand a "Find joints" warning is about: the job starts those with "hand L" / "hand R"
 * (for example "hand R: fingers not found (...); mirrored from the left hand - check them").
 */
export function warningHand(warning: string): 'L' | 'R' | null {
  const m = /^hand ([LR])(?![A-Za-z0-9_])/.exec(warning)
  return m ? (m[1] as 'L' | 'R') : null
}

/** Rough standing height from the markers (head_top down to the lowest foot marker). */
export function markerHeight(markers: MarkerMap): number {
  const zs = Object.values(markers).map((m) => m.p[2])
  if (zs.length === 0) return 1.8
  const top = markers.head_top?.p[2] ?? Math.max(...zs)
  const h = top - Math.min(0, ...zs)
  return h > 1e-3 ? h : 1.8
}

/** Deep copy of a marker map. */
export function cloneMarkers(markers: MarkerMap): MarkerMap {
  const out: MarkerMap = {}
  for (const [k, v] of Object.entries(markers)) out[k] = { p: [v.p[0], v.p[1], v.p[2]], confidence: v.confidence, source: v.source }
  return out
}
