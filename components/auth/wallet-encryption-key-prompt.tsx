'use client'

import * as Dialog from '@radix-ui/react-dialog'
import { LockClosedIcon } from '@heroicons/react/24/outline'
import { useAuth } from '@/contexts/auth-context'
import { useAppConnectStatus } from '@/lib/app-connect/session-manager'
import { useRenewModal } from '@/hooks/use-renew-modal'
import { getEncryptionKey } from '@/lib/secure-storage'
import toast from 'react-hot-toast'
import { Modal, ModalTitle } from '@/components/ui/modal'
import { Button } from '@/components/ui/button'

/** Whether the signed-in user signs with a wallet (App Connect) key ring in this tab. */
export function useWalletSession(): boolean {
  const { user } = useAuth()
  return useAppConnectStatus((state) => Boolean(user) && state.identityId === user?.identityId)
}

/**
 * For wallet sign-ins in place of the "enter or add an encryption key" flows:
 * the messaging key comes from the wallet. When the wallet did not include
 * it, signing in again from the wallet with messaging allowed brings it.
 */
export function WalletEncryptionKeyPrompt({
  isOpen,
  onClose,
  onSuccess,
}: {
  isOpen: boolean
  onClose: () => void
  /** Called once the renewal (which brings the messaging key) has landed, so the caller can re-check. */
  onSuccess?: () => void
}) {
  const { user } = useAuth()
  const openRenew = useRenewModal((state) => state.open)

  // The wallet may leave messaging out of a renewal: only report success when the key arrived.
  const renewed = () => {
    if (user && getEncryptionKey(user.identityId)) {
      onSuccess?.()
      return
    }
    toast.error('Your wallet didn\'t include messaging. Renew again and allow messaging when it asks.')
  }
  return (
    <Modal open={isOpen} onOpenChange={(next) => { if (!next) onClose() }} className="w-[420px] max-w-[90vw]">
      <ModalTitle>
        <LockClosedIcon className="h-6 w-6 text-yappr-500" />
        Allow messaging in your wallet
      </ModalTitle>
      <Dialog.Description className="text-sm text-gray-600 dark:text-gray-400 mb-4">
        Private messages and private feeds need your messaging key, which your Dash wallet gives Yappr. Renew in your
        wallet and allow messaging when it asks.
      </Dialog.Description>
      <div className="flex gap-2 justify-end">
        <Button variant="ghost" onClick={onClose}>Not now</Button>
        <Button onClick={() => { onClose(); openRenew(renewed) }}>Renew in your wallet</Button>
      </div>
    </Modal>
  )
}
