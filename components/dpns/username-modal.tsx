'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { X } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { useAuth } from '@/contexts/auth-context'
import { useDpnsRegistration } from '@/hooks/use-dpns-registration'
import { useKeyBackupModal } from '@/hooks/use-key-backup-modal'
import { encryptedKeyService } from '@/lib/services/encrypted-key-service'

import { DpnsRegistrationWizard } from './registration-wizard'

interface UsernameModalProps {
  isOpen: boolean
  onClose: () => void
  customIdentityId?: string
}

export function UsernameModal({ isOpen, onClose, customIdentityId }: UsernameModalProps) {
  const router = useRouter()
  const { user } = useAuth()
  const { reset } = useDpnsRegistration()

  const currentIdentityId = customIdentityId || user?.identityId || ''

  // Reset wizard state when modal opens
  useEffect(() => {
    if (isOpen) {
      reset()
    }
  }, [isOpen, reset])

  const handleSkip = async () => {
    sessionStorage.setItem('yappr_skip_dpns', 'true')
    onClose()

    // Prompt for key backup if the feature is configured (same as after registration)
    if (encryptedKeyService.isConfigured()) {
      const hasBackup = await encryptedKeyService.hasBackup(currentIdentityId)
      if (!hasBackup) {
        const { getPrivateKey } = await import('@/lib/secure-storage')
        const privateKey = getPrivateKey(currentIdentityId)
        if (privateKey) {
          useKeyBackupModal.getState().open(currentIdentityId, '', privateKey)
          return // Don't redirect yet - let the backup modal handle it
        }
      }
    }

    router.push('/profile/create')
  }

  const handleComplete = async () => {
    onClose()

    // Prompt for key backup if the feature is configured
    if (encryptedKeyService.isConfigured()) {
      const hasBackup = await encryptedKeyService.hasBackup(currentIdentityId)
      if (!hasBackup) {
        const { getPrivateKey } = await import('@/lib/secure-storage')
        const privateKey = getPrivateKey(currentIdentityId)
        if (privateKey) {
          // Note: redirectOnClose=true by default, so modal will redirect to /profile/create
          // The wizard also redirects there, but that's fine - it's a no-op
          useKeyBackupModal.getState().open(currentIdentityId, user?.dpnsUsername || '', privateKey)
        }
      }
    }
  }

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50"
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
                onClick={onClose}
                className="absolute top-4 right-4 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>

              <h1 className="text-2xl font-bold text-center mb-2">Register Username</h1>
              <p className="text-gray-600 dark:text-gray-400 text-center mb-6">
                Choose one or more usernames for your Dash Platform identity
              </p>

              {/* Identity ID Display */}
              <div className="mb-6 p-3 bg-gray-100 dark:bg-gray-800 rounded-lg">
                <label className="text-xs text-gray-500 uppercase tracking-wide">
                  Identity ID
                </label>
                <div
                  className="font-mono text-sm mt-1 truncate select-all cursor-text"
                  title={currentIdentityId}
                >
                  {currentIdentityId}
                </div>
              </div>

              {/* Registration Wizard */}
              <DpnsRegistrationWizard onComplete={handleComplete} onSkip={handleSkip} />
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
