'use client'

import { logger } from '@/lib/logger'
import { useState, useEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, CheckCircle, AlertCircle, RefreshCw, KeyRound } from 'lucide-react'
import { useYapprKeyExchangeLogin } from 'platform-auth'
import { useKeyExchangeModal } from '@/hooks/use-key-exchange-modal'
import { useLoginModal } from '@/hooks/use-login-modal'
import { useAuth } from '@/contexts/auth-context'
import { useSettingsStore } from '@/lib/store'
import { authVaultService } from '@/lib/services/auth-vault-service'
import { getPasskeyPrfSupport } from '@/lib/webauthn/passkey-support'
import { KeyExchangeQR } from './key-exchange-qr'
import { KeyRegistrationFlow } from './key-registration-flow'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'

/**
 * A passkey is only worth offering when the vault exists, has no passkey yet,
 * and the browser can actually run a PRF-capable ceremony.
 */
async function shouldOfferPasskeyEnrollment(identityId: string): Promise<boolean> {
  try {
    if (!authVaultService.isConfigured()) return false
    const status = await authVaultService.getStatus(identityId)
    const support = await getPasskeyPrfSupport()
    return (
      status.hasVault &&
      status.passkeyCount === 0 &&
      support.webauthnAvailable &&
      support.likelyPrfCapable
    )
  } catch (supportError) {
    logger.warn('Key exchange login completed, but passkey support check failed:', supportError)
    return false
  }
}

/**
 * Modal for key exchange login flow.
 *
 * UI states:
 * - idle/generating: spinner
 * - waiting: QR code + countdown timer + "Scan with Dash wallet"
 * - decrypting/checking: brief spinner
 * - registering: first-login prompt
 * - passkey offer: post-login prompt to enrol a passkey (vault has none yet)
 * - complete: success checkmark, auto-close
 * - timeout/error: retry button
 */
export function KeyExchangeLoginModal() {
  const { isOpen, close } = useKeyExchangeModal()
  const closeLoginModal = useLoginModal((s) => s.close)
  const { controller, loginWithKeyExchange, addPasskeyWrapper } = useAuth()
  const potatoMode = useSettingsStore((s) => s.potatoMode)

  const {
    state,
    uri,
    remainingTime,
    error,
    result,
    start,
    cancel,
    retry
  } = useYapprKeyExchangeLogin(controller)

  const [loginError, setLoginError] = useState<string | null>(null)
  const [isCompleting, setIsCompleting] = useState(false)
  const [passkeyOffer, setPasskeyOffer] = useState(false)
  const [isAddingPasskey, setIsAddingPasskey] = useState(false)
  const [passkeyError, setPasskeyError] = useState<string | null>(null)

  // cancel() zeros key material in result state via clearResult
  const finishLogin = useCallback(() => {
    cancel()
    closeLoginModal()
    close()
  }, [cancel, closeLoginModal, close])

  // Attempt login and handle success/failure
  const attemptLogin = useCallback((identityId: string, loginKey: Uint8Array, keyIndex: number) => {
    setLoginError(null)
    setIsCompleting(true)
    loginWithKeyExchange(identityId, loginKey, keyIndex)
      .then(async () => {
        // Offer enrollment as a step inside this modal instead of closing straight away.
        // isCompleting stays true so the completion effect does not re-run the login.
        if (await shouldOfferPasskeyEnrollment(identityId)) {
          setPasskeyOffer(true)
          return
        }

        setTimeout(finishLogin, 1500)
      })
      .catch((err) => {
        logger.error('Key exchange login failed:', err)
        setLoginError(err instanceof Error ? err.message : 'Login failed')
        setIsCompleting(false)
      })
  }, [loginWithKeyExchange, finishLogin])

  // Leaves the passkey step, whether the user enrolled or skipped
  const finishPasskeyStep = useCallback(() => {
    setIsAddingPasskey(false)
    setPasskeyError(null)
    setPasskeyOffer(false)
    finishLogin()
  }, [finishLogin])

  const handleAddPasskey = useCallback(() => {
    setPasskeyError(null)
    setIsAddingPasskey(true)
    addPasskeyWrapper('Wallet login passkey')
      .then(finishPasskeyStep)
      .catch((err) => {
        logger.error('Passkey enrollment failed:', err)
        setPasskeyError(err instanceof Error ? err.message : 'Could not add a passkey')
        setIsAddingPasskey(false)
      })
  }, [addPasskeyWrapper, finishPasskeyStep])

  // Start the login flow when modal opens (no identity needed)
  useEffect(() => {
    if (isOpen && state === 'idle') {
      setLoginError(null)
      setIsCompleting(false)
      start()
    }
  }, [isOpen, state, start])

  // Handle successful login (when state becomes 'complete')
  useEffect(() => {
    if (state === 'complete' && result && !isCompleting && !passkeyOffer && !loginError) {
      attemptLogin(result.identityId, result.loginKey, result.keyIndex)
    }
  }, [state, result, isCompleting, passkeyOffer, loginError, attemptLogin])

  // Handle close
  const handleClose = useCallback(() => {
    // Don't tear the modal down mid-WebAuthn ceremony
    if (isAddingPasskey) return

    // Login already succeeded when the passkey offer is showing; dismissing it just skips enrollment
    if (passkeyOffer) {
      finishPasskeyStep()
      return
    }

    setLoginError(null)
    setIsCompleting(false)
    cancel()
    close()
  }, [cancel, close, finishPasskeyStep, isAddingPasskey, passkeyOffer])

  // Render content based on state
  const renderContent = () => {
    if (passkeyOffer) {
      return (
        <div className="flex flex-col items-center gap-4 py-2">
          <div className="w-16 h-16 rounded-full bg-yappr-100 dark:bg-yappr-900/30 flex items-center justify-center">
            <KeyRound className="w-8 h-8 text-yappr-600 dark:text-yappr-400" />
          </div>
          <div className="text-center">
            <h3 className="font-semibold text-lg">Add a passkey?</h3>
            <p className="text-sm text-gray-600 dark:text-gray-400 mt-2">
              You&apos;re signed in. Add a passkey to unlock this account on future sign-ins
              without scanning a QR code.
            </p>
          </div>
          {passkeyError && (
            <p className="text-sm text-red-600 dark:text-red-400 text-center">
              {passkeyError}
            </p>
          )}
          <div className="w-full space-y-2">
            <Button
              className="w-full"
              onClick={handleAddPasskey}
              disabled={isAddingPasskey}
            >
              {isAddingPasskey ? (
                <>
                  <Spinner size="xs" className="mr-2" />
                  Adding passkey...
                </>
              ) : (
                <>
                  <KeyRound className="w-4 h-4 mr-2" />
                  Add Passkey
                </>
              )}
            </Button>
            <Button
              variant="ghost"
              className="w-full"
              onClick={finishPasskeyStep}
              disabled={isAddingPasskey}
            >
              Not now
            </Button>
          </div>
        </div>
      )
    }

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
                Approve this login request with your Dash wallet
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
            controller={controller}
            identityId={result.identityId}
            authKey={result.authKey}
            encryptionKey={result.encryptionKey}
            onComplete={() => {
              attemptLogin(result.identityId, result.loginKey, result.keyIndex)
            }}
            onCancel={handleClose}
          />
        )

      case 'complete':
        if (loginError) {
          return (
            <div className="flex flex-col items-center gap-4 py-4">
              <div className="p-4 bg-red-50 dark:bg-red-900/20 rounded-full">
                <AlertCircle className="w-8 h-8 text-red-500" />
              </div>
              <div className="text-center">
                <h3 className="font-semibold text-lg text-red-600 dark:text-red-400">
                  Login Failed
                </h3>
                <p className="text-sm text-gray-600 dark:text-gray-400 mt-2">
                  {loginError}
                </p>
              </div>
              <Button onClick={() => {
                if (result) {
                  attemptLogin(result.identityId, result.loginKey, result.keyIndex)
                }
              }} className="mt-2">
                Try Again
              </Button>
            </div>
          )
        }
        return (
          <div className="flex flex-col items-center gap-4 py-8">
            {isCompleting ? (
              <>
                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500" />
                <p className="text-gray-600 dark:text-gray-400">
                  Completing login...
                </p>
              </>
            ) : (
              <>
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
              </>
            )}
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
