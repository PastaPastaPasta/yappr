import { create } from 'zustand'
import type { Post } from '@/lib/types'
import type { PostFieldKind } from '@/lib/services/post-field-validation'

interface RecoveryModalStore {
  isOpen: boolean
  kind: PostFieldKind
  post: Post | null
  /** The failed value in storage form: a tag without `#`, or a username without `@`. */
  value: string | null
  isRegistering: boolean
  error: string | null

  open: (kind: PostFieldKind, post: Post, value: string) => void
  close: () => void
  setRegistering: (value: boolean) => void
  setError: (error: string | null) => void
}

const CLOSED = { isOpen: false, post: null, value: null, isRegistering: false, error: null } as const

/**
 * The "this hashtag/mention was never registered, fix it?" dialog. One store
 * for both kinds; the modal branches on `kind` for copy and the write it makes.
 */
export const useRecoveryModal = create<RecoveryModalStore>((set) => ({
  ...CLOSED,
  kind: 'hashtag',

  open: (kind, post, value) => set({ isOpen: true, kind, post, value, isRegistering: false, error: null }),
  close: () => set(CLOSED),
  setRegistering: (isRegistering) => set({ isRegistering }),
  setError: (error) => set({ error }),
}))
