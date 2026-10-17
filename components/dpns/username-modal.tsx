'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { X } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { useAuth } from '@/contexts/auth-context'
import { rememberUsernameSkip } from '@/lib/username-skip'
import { useDpnsRegistration } from '@/hooks/use-dpns-registration'
import { useSettingsStore } from '@/lib/store'
import { currentReturnToParam, returnToOrDefault } from '@/lib/auth/return-to'

import { DpnsRegistrationWizard } from './registration-wizard'
import { WalletUsernameGuide } from './wallet-username-guide'
import { useAppConnectStatus } from '@/lib/app-connect/session-manager'

interface UsernameModalProps {
  isOpen: boolean
  /** Called whenever the modal closes: dismissed, skipped, or completed. */
  onClose: () => void
  /**
   * Called instead of `onClose` when the user dismisses the modal (close button
   * or backdrop). Skip and Continue navigate on their own, so they never run it.
   */
  onDismiss?: () => void
  customIdentityId?: string
  hasExistingUsernames?: boolean
}

export function UsernameModal({ isOpen, onClose, onDismiss, customIdentityId, hasExistingUsernames }: UsernameModalProps) {
  const router = useRouter()
  const { user } = useAuth()
  const { reset } = useDpnsRegistration()
  const potatoMode = useSettingsStore((s) => s.potatoMode)

  const currentIdentityId = customIdentityId || user?.identityId || ''
  // A wallet (App Connect) sign-in holds no key that can register names: that happens in the wallet.
  const walletSession = useAppConnectStatus((state) => state.identityId !== null && state.identityId === currentIdentityId)

  // Reset wizard state when modal opens
  useEffect(() => {
    if (isOpen) {
      reset()
    }
  }, [isOpen, reset])

  const handleSkip = () => {
    if (currentIdentityId) rememberUsernameSkip(currentIdentityId)
    onClose()
    router.push(returnToOrDefault(currentReturnToParam()))
  }

  const handleComplete = () => {
    onClose()
  }

  const handleDismiss = onDismiss ?? onClose

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={handleDismiss}
            className={`fixed inset-0 bg-black/50 z-50 ${potatoMode ? '' : 'backdrop-blur-sm'}`}
          />

          {/* Modal */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 flex items-center justify-center z-50 px-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-xl p-8 max-w-md w-full relative max-h-[90vh] overflow-y-auto">
              {/* Close button */}
              <button
                aria-label="Close"
                onClick={handleDismiss}
                className="absolute top-4 right-4 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>

              <h1 className="text-2xl font-bold text-center mb-2">Choose a username</h1>
              <p className="text-gray-600 dark:text-gray-400 text-center mb-6">
                It&apos;s how people find and mention you. You can skip this and add one later.
              </p>

              {/* Registration Wizard */}
              {walletSession
                ? <WalletUsernameGuide onComplete={handleComplete} onSkip={handleSkip} />
                : <DpnsRegistrationWizard onComplete={handleComplete} onSkip={handleSkip} hasExistingUsernames={hasExistingUsernames} />}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
