import { createModalStore } from '@/lib/modal-store'

interface KeyBackupPayload {
  identityId?: string
  username?: string
  redirectOnClose: boolean
}

export const useKeyBackupModal = createModalStore<KeyBackupPayload, [identityId: string, username: string, redirectOnClose?: boolean]>(
  { identityId: undefined, username: undefined, redirectOnClose: true },
  (identityId, username, redirectOnClose = true) => ({ identityId, username, redirectOnClose })
)
