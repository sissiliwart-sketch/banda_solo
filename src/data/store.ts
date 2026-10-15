import { create } from 'zustand'
import { cloudConfigured } from '../config'
import { AppwriteBackend } from './appwrite'
import type { Backend } from './backend'
import { LocalBackend } from './local'
import type { UserInfo } from './types'

export type Mode = 'cloud' | 'local'

const K_MODE = 'bs.mode'

function initialMode(): Mode {
  try {
    const m = localStorage.getItem(K_MODE)
    if (m === 'local') return 'local'
    if (m === 'cloud' && cloudConfigured()) return 'cloud'
  } catch {
    /* ignore */
  }
  return cloudConfigured() ? 'cloud' : 'local'
}

const backends: Partial<Record<Mode, Backend>> = {}

function backendFor(mode: Mode): Backend {
  if (!backends[mode]) backends[mode] = mode === 'cloud' ? new AppwriteBackend() : new LocalBackend()
  return backends[mode]!
}

interface AppState {
  mode: Mode
  backend: Backend
  user: UserInfo | null
  ready: boolean
  init: () => Promise<void>
  setMode: (mode: Mode) => void
  setUser: (user: UserInfo | null) => void
  signOut: () => Promise<void>
}

export const useApp = create<AppState>((set, get) => ({
  mode: initialMode(),
  backend: backendFor(initialMode()),
  user: null,
  ready: false,
  init: async () => {
    const user = await get().backend.currentUser().catch(() => null)
    set({ user, ready: true })
  },
  setMode: (mode) => {
    try {
      localStorage.setItem(K_MODE, mode)
    } catch {
      /* ignore */
    }
    set({ mode, backend: backendFor(mode), user: null })
  },
  setUser: (user) => set({ user }),
  signOut: async () => {
    await get().backend.signOut()
    set({ user: null })
  },
}))

export const cloudAvailable = cloudConfigured
