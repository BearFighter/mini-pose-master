// SPDX-License-Identifier: GPL-3.0-or-later
// The status bar's update offer: Windows and Linux download updates by themselves and offer a restart;
// macOS opens the release page (main process updater.ts installUpdate).

/** What the status bar offers for an update: the label and, when there is one, the button. */
export function updateOffer(
  update: { kind: string; version?: string } | null,
  platform: string | undefined
): { text: string; button: 'restart' | 'download' | null } | null {
  if (!update) return null
  const v = update.version ? ` ${update.version}` : ''
  if (update.kind === 'downloaded') return { text: `Update${v} ready`, button: 'restart' }
  if (update.kind === 'available') return platform === 'darwin' ? { text: `Update${v} available`, button: 'download' } : { text: `Update${v} available`, button: null }
  return null
}
