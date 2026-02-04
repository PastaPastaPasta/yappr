'use client'

import { useState, useCallback, useEffect } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { XMarkIcon, KeyIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline'
import { motion, AnimatePresence } from 'framer-motion'
import { Eye, EyeOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useAuthKeyModal } from '@/hooks/use-auth-key-modal'
import { useAuth } from '@/contexts/auth-context'
import { keyValidationService } from '@/lib/services/key-validation-service'
import { isLikelyWif } from '@/lib/crypto/wif'
import toast from 'react-hot-toast'

/**
 * AuthKeyModal Component
 *
 * Modal for re-entering private key when it's been deleted from storage mid-session.
 * This preserves user context (DM conversations, scroll position, etc.) instead of
 * forcing a disruptive logout.
 */
export function AuthKeyModal() {
  const { user } = useAuth()
  const { isOpen, close, closeWithSuccess } = useAuthKeyModal()
  const [keyInput, setKeyInput] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [isValidating, setIsValidating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [validationStatus, setValidationStatus] = useState<'idle' | 'validating' | 'valid' | 'invalid'>('idle')

  // Reset form when modal closes
  useEffect(() => {
    if (!isOpen) {
      setKeyInput('')
      setShowKey(false)
      setError(null)
      setValidationStatus('idle')
    }
  }, [isOpen])

  // Real-time key validation as user types
  useEffect(() => {
    if (!keyInput || !user) {
      setValidationStatus('idle')
      setError(null)
      return
    }

    if (!isLikelyWif(keyInput)) {
      setValidationStatus('idle')
      return
    }

    const timeoutId = setTimeout(async () => {
      setValidationStatus('validating')
      try {
        const result = await keyValidationService.validatePrivateKey(
          keyInput,
          user.identityId,
          'testnet'
        )
        setValidationStatus(result.isValid ? 'valid' : 'invalid')
        if (!result.isValid) {
          setError(result.error || 'Invalid key')
        } else {
          setError(null)
        }
      } catch {
        setValidationStatus('invalid')
        setError('Failed to validate key')
      }
    }, 300)

    return () => clearTimeout(timeoutId)
  }, [keyInput, user])

  const handleSubmit = useCallback(async () => {
    if (!user || validationStatus !== 'valid') return

    setIsValidating(true)
    setError(null)

    try {
      // Store the key
      const { storePrivateKey } = await import('@/lib/secure-storage')
      storePrivateKey(user.identityId, keyInput.trim())

      toast.success('Private key restored')
      closeWithSuccess()
    } catch (err) {
      console.error('Error storing key:', err)
      setError(err instanceof Error ? err.message : 'Failed to store key')
    } finally {
      setIsValidating(false)
    }
  }, [user, keyInput, validationStatus, closeWithSuccess])

  const handleClose = useCallback(() => {
    close()
  }, [close])

  const canSubmit = validationStatus === 'valid' && !isValidating

  return (
    <Dialog.Root open={isOpen} onOpenChange={handleClose}>
      <AnimatePresence>
        {isOpen && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center px-4"
              >
                <Dialog.Content asChild>
                  <motion.div
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    className="bg-white dark:bg-neutral-900 rounded-2xl p-6 w-[450px] max-w-[95vw] shadow-xl relative"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      onClick={handleClose}
                      aria-label="Close"
                      className="absolute top-4 right-4 p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors"
                    >
                      <XMarkIcon className="h-5 w-5" />
                    </button>

                    <Dialog.Title className="text-xl font-bold mb-2 flex items-center gap-2">
                      <KeyIcon className="h-6 w-6 text-yappr-500" />
                      Session Key Required
                    </Dialog.Title>

                    <Dialog.Description className="text-gray-600 dark:text-gray-400 mb-4">
                      Your private key is no longer available. Please re-enter it to continue.
                    </Dialog.Description>

                    {/* Warning box */}
                    <div className="bg-amber-50 dark:bg-amber-950 p-3 rounded-lg mb-4">
                      <div className="flex gap-2">
                        <ExclamationTriangleIcon className="h-5 w-5 text-amber-600 dark:text-amber-400 flex-shrink-0" />
                        <p className="text-sm text-amber-700 dark:text-amber-300">
                          Your key may have been cleared by another browser tab, extension, or manual action.
                        </p>
                      </div>
                    </div>

                    {/* Key input */}
                    <div className="space-y-3 mb-4">
                      <div className="space-y-2">
                        <label className="text-sm font-medium">
                          Private Key (High or Critical)
                        </label>
                        <div className="relative">
                          <input
                            type={showKey ? 'text' : 'password'}
                            placeholder="Enter your private key (WIF format)"
                            value={keyInput}
                            onChange={(e) => setKeyInput(e.target.value)}
                            className="w-full px-3 py-2 pr-20 bg-gray-50 dark:bg-gray-950 border border-gray-200 dark:border-gray-800 rounded-lg text-gray-900 dark:text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-yappr-500 focus:border-transparent transition-colors font-mono text-sm"
                            autoFocus
                          />
                          <div className="absolute inset-y-0 right-0 flex items-center pr-3 gap-2">
                            <button
                              type="button"
                              onClick={() => setShowKey(!showKey)}
                              className="text-gray-400 hover:text-gray-600"
                              tabIndex={-1}
                            >
                              {showKey ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                            </button>
                            {validationStatus === 'validating' && (
                              <Spinner size="sm" className="text-gray-400" />
                            )}
                            {validationStatus === 'valid' && (
                              <svg className="h-5 w-5 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                              </svg>
                            )}
                            {validationStatus === 'invalid' && (
                              <svg className="h-5 w-5 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                              </svg>
                            )}
                          </div>
                        </div>
                        {error && (
                          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
                        )}
                        {validationStatus === 'valid' && (
                          <p className="text-sm text-green-600 dark:text-green-400">
                            Valid key for this identity
                          </p>
                        )}
                      </div>
                    </div>

                    <div className="flex flex-col gap-3">
                      <Button
                        onClick={handleSubmit}
                        disabled={!canSubmit}
                        className="w-full"
                      >
                        {isValidating ? (
                          <>
                            <Spinner size="xs" className="mr-2" />
                            Restoring...
                          </>
                        ) : (
                          <>
                            <KeyIcon className="h-4 w-4 mr-2" />
                            Restore Session
                          </>
                        )}
                      </Button>
                      <Button onClick={handleClose} variant="outline" className="w-full">
                        Cancel
                      </Button>
                    </div>

                    <p className="mt-4 text-center text-xs text-gray-500">
                      Your key is stored locally and never leaves this device.
                    </p>
                  </motion.div>
                </Dialog.Content>
              </motion.div>
            </Dialog.Overlay>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  )
}
