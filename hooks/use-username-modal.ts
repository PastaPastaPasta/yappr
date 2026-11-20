import { createModalStore } from '@/lib/modal-store'

export const useUsernameModal = createModalStore<{ identityId?: string }, [identityId?: string]>(
  { identityId: undefined },
  (identityId) => ({ identityId })
)

/** Resolves once the username prompt (opened by a sign-in without a Dash username) is closed. */
export function usernamePromptClosed(): Promise<void> {
  if (!useUsernameModal.getState().isOpen) return Promise.resolve()
  return new Promise((resolve) => {
    const unsubscribe = useUsernameModal.subscribe((state) => {
      if (state.isOpen) return
      unsubscribe()
      resolve()
    })
  })
}
