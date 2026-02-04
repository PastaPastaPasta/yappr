'use client'

import { useEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, CheckCircle, AlertCircle, RefreshCw } from 'lucide-react'
import { useKeyExchangeModal } from '@/hooks/use-key-exchange-modal'
import { useKeyExchangeLogin } from '@/hooks/use-key-exchange-login'
import { useLoginModal } from '@/hooks/use-login-modal'
import { useAuth } from '@/contexts/auth-context'
import { useSettingsStore } from '@/lib/store'
import { KeyExchangeQR } from './key-exchange-qr'
import { KeyRegistrationFlow } from './key-registration-flow'
import { Button } from '@/components/ui/button'

/**
 * Modal for key exchange login flow.
 *
 * UI states:
 * - idle/generating: spinner
 * - waiting: QR code + countdown timer + "Scan with Dash wallet"
 * - decrypting/checking: brief spinner
 * - registering: first-login prompt
 * - complete: success checkmark, auto-close
 * - timeout/error: retry button
 */
export function KeyExchangeLoginModal() {
  const { isOpen, close } = useKeyExchangeModal()
  const closeLoginModal = useLoginModal((s) => s.close)
  const { loginWithKeyExchange } = useAuth()
  const potatoMode = useSettingsStore((s) => s.potatoMode)

  const {
    state,
    uri,
    remainingTime,
    keyIndex,
    error,
    result,
    start,
    cancel,
    retry
  } = useKeyExchangeLogin('testnet')

  // Start the login flow when modal opens (no identity needed)
  useEffect(() => {
    if (isOpen && state === 'idle') {
      start()
    }
  }, [isOpen, state, start])

  // Handle successful login (when state becomes 'complete')
  useEffect(() => {
    if (state === 'complete' && result) {
      // Complete the login using discovered identity
      loginWithKeyExchange(result.identityId, result.loginKey, result.keyIndex)
        .then(() => {
          // Auto-close after short delay
          setTimeout(() => {
            closeLoginModal()
            close()
          }, 1500)
        })
        .catch((err) => {
          console.error('Key exchange login failed:', err)
        })
    }
  }, [state, result, loginWithKeyExchange, close, closeLoginModal])

  // Handle close
  const handleClose = useCallback(() => {
    cancel()
    close()
  }, [cancel, close])

  // Render content based on state
  const renderContent = () => {
    switch (state) {
      case 'idle':
      case 'generating':
        return (
          <div className="flex flex-col items-center gap-4 py-8">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500" />
            <p className="text-gray-600 dark:text-gray-400">
              Generating secure login request...
            </p>
          </div>
        )

      case 'waiting':
        return (
          <div className="flex flex-col items-center gap-4">
            {uri && (
              <KeyExchangeQR
                uri={uri}
                size={220}
                remainingTime={remainingTime}
              />
            )}
            <div className="text-center">
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Open Dash Evo Tool and scan this QR code to log in
              </p>
              <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
                Key index: auto (managed by wallet)
              </p>
            </div>
          </div>
        )

      case 'decrypting':
      case 'checking':
        return (
          <div className="flex flex-col items-center gap-4 py-8">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500" />
            <p className="text-gray-600 dark:text-gray-400">
              {state === 'decrypting' ? 'Decrypting login key...' : 'Verifying keys...'}
            </p>
          </div>
        )

      case 'registering':
        // Show key registration flow with QR code for wallet signing
        if (!result) {
          return (
            <div className="flex flex-col items-center gap-4 py-8">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500" />
              <p className="text-gray-600 dark:text-gray-400">
                Preparing key registration...
              </p>
            </div>
          )
        }
        return (
          <KeyRegistrationFlow
            identityId={result.identityId}
            authKey={result.authKey}
            encryptionKey={result.encryptionKey}
            onComplete={() => {
              // Keys registered - complete the login
              loginWithKeyExchange(result.identityId, result.loginKey, result.keyIndex)
                .then(() => {
                  setTimeout(() => {
                    closeLoginModal()
                    close()
                  }, 1500)
                })
                .catch((err) => {
                  console.error('Key exchange login failed after registration:', err)
                })
            }}
            onCancel={handleClose}
          />
        )

      case 'complete':
        return (
          <div className="flex flex-col items-center gap-4 py-8">
            <div className="p-4 bg-green-50 dark:bg-green-900/20 rounded-full">
              <CheckCircle className="w-12 h-12 text-green-500" />
            </div>
            <div className="text-center">
              <h3 className="font-semibold text-lg text-green-600 dark:text-green-400">
                Login Successful!
              </h3>
              <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                Redirecting...
              </p>
            </div>
          </div>
        )

      case 'timeout':
        return (
          <div className="flex flex-col items-center gap-4 py-4">
            <div className="p-4 bg-gray-100 dark:bg-neutral-800 rounded-full">
              <RefreshCw className="w-8 h-8 text-gray-500" />
            </div>
            <div className="text-center">
              <h3 className="font-semibold text-lg">Request Timed Out</h3>
              <p className="text-sm text-gray-600 dark:text-gray-400 mt-2">
                The QR code has expired. Please try again.
              </p>
            </div>
            <Button onClick={retry} className="mt-2">
              Try Again
            </Button>
          </div>
        )

      case 'error':
        return (
          <div className="flex flex-col items-center gap-4 py-4">
            <div className="p-4 bg-red-50 dark:bg-red-900/20 rounded-full">
              <AlertCircle className="w-8 h-8 text-red-500" />
            </div>
            <div className="text-center">
              <h3 className="font-semibold text-lg text-red-600 dark:text-red-400">
                Error
              </h3>
              <p className="text-sm text-gray-600 dark:text-gray-400 mt-2">
                {error || 'An unexpected error occurred'}
              </p>
            </div>
            <Button onClick={retry} className="mt-2">
              Try Again
            </Button>
          </div>
        )

      default:
        return null
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
            onClick={handleClose}
            className={`fixed inset-0 z-50 flex items-center justify-center px-4 bg-black/60 ${potatoMode ? '' : 'backdrop-blur-sm'}`}
          >
            {/* Modal */}
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ duration: 0.2 }}
              onClick={(e) => e.stopPropagation()}
              className="bg-white dark:bg-neutral-900 rounded-2xl shadow-xl w-full max-w-md relative"
            >
              {/* Header */}
              <div className="sticky top-0 bg-white dark:bg-neutral-900 px-6 pt-6 pb-4 border-b border-gray-100 dark:border-gray-800 rounded-t-2xl">
                <button
                  onClick={handleClose}
                  aria-label="Close"
                  className="absolute top-4 right-4 p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors rounded-full hover:bg-gray-100 dark:hover:bg-gray-800"
                >
                  <X className="w-5 h-5" />
                </button>
                <div className="text-center">
                  <h2 className="text-xl font-bold">Login with Wallet</h2>
                </div>
              </div>

              {/* Content */}
              <div className="p-6">
                {renderContent()}
              </div>

              {/* Footer with cancel (only when waiting) */}
              {state === 'waiting' && (
                <div className="px-6 pb-6">
                  <button
                    onClick={handleClose}
                    className="w-full py-2 text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              )}
            </motion.div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
