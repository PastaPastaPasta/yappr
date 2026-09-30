import { createModalStore } from '@/lib/modal-store'

interface KeyBackupPayload {
  identityId?: string
  username?: string
}

export const useKeyBackupModal = createModalStore<KeyBackupPayload, [identityId: string, username: string]>(
  { identityId: undefined, username: undefined },
  (identityId, username) => ({ identityId, username })
)
