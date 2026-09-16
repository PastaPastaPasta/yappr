'use client'

import { UsernameModal } from './username-modal'
import { useUsernameModal } from '@/hooks/use-username-modal'
import { useKeyBackupModal } from '@/hooks/use-key-backup-modal'

export function UsernameModalProvider() {
  const { isOpen, identityId, close } = useUsernameModal()
  const isBackupOpen = useKeyBackupModal((state) => state.isOpen)
  
  // Preserve the username request while key-login backup setup is in front.
  return <UsernameModal isOpen={isOpen && !isBackupOpen} onClose={close} customIdentityId={identityId} />
}
