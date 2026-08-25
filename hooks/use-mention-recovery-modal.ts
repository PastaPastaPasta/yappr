import { create } from 'zustand'
import { Post } from '@/lib/types'

interface MentionRecoveryModalStore {
  isOpen: boolean
  post: Post | null
  username: string | null // The specific failed mention username (normalized, no @)
  isRegistering: boolean
  error: string | null

  open: (post: Post, username: string) => void
  close: () => void
  setRegistering: (value: boolean) => void
  setError: (error: string | null) => void
}

export const useMentionRecoveryModal = create<MentionRecoveryModalStore>((set) => ({
  isOpen: false,
  post: null,
  username: null,
  isRegistering: false,
  error: null,

  open: (post, username) =>
    set({
      isOpen: true,
      post,
      username,
      isRegistering: false,
      error: null
    }),

  close: () =>
    set({
      isOpen: false,
      post: null,
      username: null,
      isRegistering: false,
      error: null
    }),

  setRegistering: (value) => set({ isRegistering: value }),

  setError: (error) => set({ error })
}))
