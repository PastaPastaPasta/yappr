'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { X } from 'lucide-react'
import { Modal, ModalTitle } from '@/components/ui/modal'
import { useAuth } from '@/contexts/auth-context'
import { rememberUsernameSkip } from '@/lib/username-skip'
import { useDpnsRegistration } from '@/hooks/use-dpns-registration'
import { afterRegistrationRoute, currentReturnToParam, returnToOrDefault } from '@/lib/auth/return-to'

import { DpnsRegistrationWizard } from './registration-wizard'
import { WalletUsernameGuide } from './wallet-username-guide'
import { useAppConnectStatus } from '@/lib/app-connect/session-manager'

interface UsernameModalProps {
  isOpen: boolean
  /** Called whenever the modal closes: dismissed, skipped, or completed. */
  onClose: () => void
  /**
   * Called instead of `onClose` when the user dismisses the modal (close button
   * or backdrop). Skip and Continue never run it.
   */
  onDismiss?: () => void
  /**
   * Skip and Continue go on to the page's `next` route (the feed after a
   * registration that failed everywhere). Elsewhere they only close the modal.
   */
  returnWhenDone?: boolean
  customIdentityId?: string
  hasExistingUsernames?: boolean
}

export function UsernameModal({ isOpen, onClose, onDismiss, returnWhenDone = false, customIdentityId, hasExistingUsernames }: UsernameModalProps) {
  const router = useRouter()
  const { user } = useAuth()
  const { reset } = useDpnsRegistration()

  const currentIdentityId = customIdentityId || user?.identityId || ''
  // A wallet (App Connect) sign-in holds no key that can register names: that happens in the wallet.
  const walletSession = useAppConnectStatus((state) => state.identityId !== null && state.identityId === currentIdentityId)

  // Reset wizard state when modal opens
  useEffect(() => {
    if (isOpen) {
      reset()
    }
  }, [isOpen, reset])

  const finish = (route: string) => {
    onClose()
    if (returnWhenDone) router.push(route)
  }

  const handleSkip = () => {
    if (currentIdentityId) rememberUsernameSkip(currentIdentityId)
    finish(returnToOrDefault(currentReturnToParam()))
  }

  const handleComplete = (hasUsername = Boolean(user?.dpnsUsername)) => {
    finish(afterRegistrationRoute(hasUsername, currentReturnToParam()))
  }

  // Closing it is a choice too: don't ask this identity again on its own.
  const dismiss = onDismiss ?? onClose
  const handleDismiss = () => {
    if (currentIdentityId) rememberUsernameSkip(currentIdentityId)
    dismiss()
  }

  return (
    <Modal open={isOpen} onOpenChange={(open) => { if (!open) handleDismiss() }}
      className="p-8 max-w-md w-full max-h-[90vh] overflow-y-auto">
      {/* Close button */}
      <button
        aria-label="Close"
        onClick={handleDismiss}
        className="absolute top-4 right-4 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
      >
        <X className="w-5 h-5" />
      </button>

      <ModalTitle className="text-2xl justify-center mb-2">{hasExistingUsernames ? 'Add a username' : 'Choose a username'}</ModalTitle>
      <p className="text-gray-600 dark:text-gray-400 text-center mb-6">
        It&apos;s how people find and mention you. You can skip this and add one later.
      </p>

      {/* Registration Wizard */}
      {walletSession
        ? <WalletUsernameGuide onComplete={() => handleComplete()} onSkip={handleSkip} additional={hasExistingUsernames} />
        : <DpnsRegistrationWizard onComplete={handleComplete} onSkip={handleSkip} hasExistingUsernames={hasExistingUsernames} />}
    </Modal>
  )
}
