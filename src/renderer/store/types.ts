// SPDX-License-Identifier: GPL-3.0-or-later
// The renderer store (contracts section 18): one zustand store built from per-area slices.
import type { StateCreator } from 'zustand'
import type { AppSlice } from './app'
import type { BakeSlice } from './bake'
import type { HandsSlice } from './hands'
import type { JobsSlice } from './jobs'
import type { PoseSlice } from './pose'
import type { ProjectSlice } from './project'
import type { RigSlice } from './rig'
import type { UiSlice } from './ui'
import type { WeaponsSlice } from './weapons'

export type Store = AppSlice & ProjectSlice & RigSlice & PoseSlice & HandsSlice & WeaponsSlice & BakeSlice & JobsSlice & UiSlice

export type SliceCreator<T> = StateCreator<Store, [], [], T>
