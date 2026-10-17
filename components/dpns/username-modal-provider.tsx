'use client'

import { UsernameModal } from './username-modal'
import { useUsernameModal } from '@/hooks/use-username-modal'

export function UsernameModalProvider() {
  const { isOpen, identityId, close } = useUsernameModal()
  return <UsernameModal isOpen={isOpen} onClose={close} customIdentityId={identityId} />
}
