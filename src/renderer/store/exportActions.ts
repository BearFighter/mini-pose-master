// SPDX-License-Identifier: GPL-3.0-or-later
// Export step flow: save, then the bake job with the pose state, hands, weapons and bake settings.
import type { BakeJobResult } from '../../shared/jobResults'
import { api } from '../api'
import { projectName } from '../lib/paths'
import { job, requireProject, saveProject, withJob } from './actions'
import { DEFAULT_BAKE } from './bake'
import { fail, S } from './flow'
import { currentPoseState } from './poseActions'

export function runBake(): Promise<BakeJobResult> {
  return withJob('bake', 'Baking the STL', async () => {
    const { dir } = requireProject()
    if (!S().rigJson) throw new Error('Build the rig first')
    if (!S().bake) S().updateBake({})
    await saveProject()
    const pose = currentPoseState()
    if (!pose) throw new Error('No pose to bake')
    const s = S()
    const result = await job<BakeJobResult>('bake', {
      name: projectName(dir),
      pose,
      hands: s.data?.hands ?? null,
      weapons: s.weapons,
      bake: s.bake ?? DEFAULT_BAKE
    })
    S().setBakeResult(result)
    return result
  })
}

/** An absolute path for a project-relative one (the project folder's own separator). */
export function projectPath(rel: string): string {
  const dir = S().dir ?? ''
  const sep = dir.includes('\\') ? '\\' : '/'
  return `${dir.replace(/[\\/]+$/, '')}${sep}${rel.replace(/[\\/]+/g, sep)}`
}

export async function showInFolder(rel: string): Promise<void> {
  await api.shell.showItemInFolder(projectPath(rel)).catch(fail)
}
