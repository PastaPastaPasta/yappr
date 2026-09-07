import type { Post } from '@/lib/types'
import type { PostFieldKind } from '@/lib/services/post-field-validation'
import { createModalStore } from '@/lib/modal-store'

interface RecoveryPayload {
  kind: PostFieldKind
  post: Post | null
  /** The failed value in storage form: a tag without `#`, or a username without `@`. */
  value: string | null
  isRegistering: boolean
  error: string | null
}

/**
 * The "this hashtag/mention was never registered, fix it?" dialog. One store
 * for both kinds; the modal branches on `kind` for copy and the write it makes.
 */
export const useRecoveryModal = createModalStore<
  RecoveryPayload,
  [kind: PostFieldKind, post: Post, value: string],
  { setRegistering: (registering: boolean) => void; setError: (error: string | null) => void }
>(
  { kind: 'hashtag', post: null, value: null, isRegistering: false, error: null },
  (kind, post, value) => ({ kind, post, value }),
  (set) => ({
    setRegistering: (isRegistering) => set({ isRegistering }),
    setError: (error) => set({ error }),
  })
)
