import { create } from 'zustand'
import { createModalStore } from '@/lib/modal-store'

export const useUsernameModal = createModalStore<{ identityId?: string }, [identityId?: string]>(
  { identityId: undefined },
  (identityId) => ({ identityId })
)

/**
 * The registration page's own username dialog (app/dpns/register), open:
 * prompts that wait for the username prompt wait for it too.
 */
export const useRegistrationUsernameDialog = create<{ isOpen: boolean }>(() => ({ isOpen: false }))
