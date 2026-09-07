import { createModalStore } from '@/lib/modal-store'

export const useUsernameModal = createModalStore<{ identityId?: string }, [identityId?: string]>(
  { identityId: undefined },
  (identityId) => ({ identityId })
)
