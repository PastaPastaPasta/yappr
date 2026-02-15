'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { XMarkIcon, LockClosedIcon, ExclamationTriangleIcon, KeyIcon, PlusIcon, CheckCircleIcon } from '@heroicons/react/24/outline'
import { motion, AnimatePresence } from 'framer-motion'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Input } from '@/components/ui/input'
import { useEncryptionKeyModal, getEncryptionKeyActionDescription } from '@/hooks/use-encryption-key-modal'
import { useAuth } from '@/contexts/auth-context'
import { AddEncryptionKeyModal } from './add-encryption-key-modal'
import { LostEncryptionKeyModal } from './lost-encryption-key-modal'
import toast from 'react-hot-toast'

type AutoRecoveryStatus = 'idle' | 'checking' | 'found' | 'failed'

/**
 * EncryptionKeyModal Component
 *
 * Modal for entering encryption private key after login.
 * Implements PRD §6.3 - Encryption Key Entry on Login
 *
 * Auto-recovery flow (Consolidated Key Management):
 * 1. Check for secondary keys backup on chain
 * 2. Attempt HKDF derivation from auth key if no backup
 * 3. Show manual entry only as last resort
 */
export function EncryptionKeyModal() {
  const { user } = useAuth()
  const { isOpen, action, onSuccess, close, closeWithSuccess } = useEncryptionKeyModal()
  const [encryptionKeyInput, setEncryptionKeyInput] = useState('')
  const [isValidating, setIsValidating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showAddKeyModal, setShowAddKeyModal] = useState(false)
  const [showLostKeyModal, setShowLostKeyModal] = useState(false)
  const [noKeyOnIdentity, setNoKeyOnIdentity] = useState(false)

  // Auto-recovery state
  const [autoRecoveryStatus, setAutoRecoveryStatus] = useState<AutoRecoveryStatus>('idle')
  const [autoRecoveryMessage, setAutoRecoveryMessage] = useState('')
  const hasAttemptedRecovery = useRef(false)
  const isModalActiveRef = useRef(false)

  // Track modal open/close state
  useEffect(() => {
    isModalActiveRef.current = isOpen
  }, [isOpen])

  // Attempt auto-recovery when modal opens
  const attemptAutoRecovery = useCallback(async () => {
    if (!user || hasAttemptedRecovery.current) return

    hasAttemptedRecovery.current = true

    // Check if modal is still active before each state update
    if (!isModalActiveRef.current) return
    setAutoRecoveryStatus('checking')
    setAutoRecoveryMessage('Checking for backup...')

    try {
      // Get auth key from secure storage
      const { getPrivateKey, storeEncryptionKey, storeEncryptionKeyType } = await import('@/lib/secure-storage')
      const authKeyWif = getPrivateKey(user.identityId)

      if (!authKeyWif) {
        // No auth key available (shouldn't happen but handle gracefully)
        if (!isModalActiveRef.current) return
        setAutoRecoveryStatus('failed')
        setAutoRecoveryMessage('')
        return
      }

      // Parse auth key to bytes
      const { parsePrivateKey } = await import('@/lib/crypto/wif')
      const { privateKey: authPrivateKey } = parsePrivateKey(authKeyWif)

      // Attempt HKDF derivation from auth key
      if (!isModalActiveRef.current) return
      setAutoRecoveryMessage('Attempting key derivation...')
      const { deriveEncryptionKey, validateDerivedKeyMatchesIdentity } = await import('@/lib/crypto/key-derivation')

      const derivedKey = deriveEncryptionKey(authPrivateKey, user.identityId)

      // Check if derived key matches identity's encryption key
      const matches = await validateDerivedKeyMatchesIdentity(derivedKey, user.identityId, 1) // purpose=1 is encryption

      if (!isModalActiveRef.current) return

      if (matches) {
        // Derivation succeeded - store the key
        setAutoRecoveryMessage('Key derived successfully!')
        setAutoRecoveryStatus('found')

        // Convert to hex for storage
        const { bytesToHex } = await import('@noble/hashes/utils.js')
        const derivedKeyHex = bytesToHex(derivedKey)

        storeEncryptionKey(user.identityId, derivedKeyHex)
        storeEncryptionKeyType(user.identityId, 'derived')

        // Brief success message, then close (use closeWithSuccess to avoid calling onCancel)
        setTimeout(() => {
          if (!isModalActiveRef.current) return
          toast.success('Encryption key recovered automatically')
          closeWithSuccess()
          if (onSuccess) {
            onSuccess()
          }
        }, 800)
        return
      }

      // Step 3: Neither backup nor derivation worked - show manual entry
      if (!isModalActiveRef.current) return
      setAutoRecoveryStatus('failed')
      setAutoRecoveryMessage('Auto-recovery not available. Please enter your key manually.')
    } catch (err) {
      console.error('Auto-recovery error:', err)
      if (!isModalActiveRef.current) return
      setAutoRecoveryStatus('failed')
      setAutoRecoveryMessage('')
    }
  }, [user, close, onSuccess])

  // Trigger auto-recovery when modal opens
  useEffect(() => {
    if (isOpen && user && autoRecoveryStatus === 'idle') {
      attemptAutoRecovery().catch((err) => console.error('Auto-recovery failed:', err))
    }
  }, [isOpen, user, autoRecoveryStatus, attemptAutoRecovery])

  // Reset all local state when modal closes (handles both cancel and success paths)
  useEffect(() => {
    if (!isOpen) {
      setEncryptionKeyInput('')
      setError(null)
      setNoKeyOnIdentity(false)
      setShowLostKeyModal(false)
      setAutoRecoveryStatus('idle')
      setAutoRecoveryMessage('')
      hasAttemptedRecovery.current = false
    }
  }, [isOpen])

  const actionDescription = getEncryptionKeyActionDescription(action)

  const validateAndStoreKey = useCallback(async () => {
    if (!user) return

    setIsValidating(true)
    setError(null)

    try {
      // Normalize input (trim whitespace) before validation
      const trimmedKey = encryptionKeyInput.trim()

      // Validate the key matches the encryption key on identity
      const { validateEncryptionKey } = await import('@/lib/crypto/key-validation')
      const validation = await validateEncryptionKey(trimmedKey, user.identityId)

      if (!validation.isValid) {
        setError(validation.error || 'Invalid key')
        if (validation.noKeyOnIdentity) {
          setNoKeyOnIdentity(true)
        }
        setIsValidating(false)
        return
      }

      // Key is valid - store it (storeEncryptionKey handles conversion to WIF)
      const { storeEncryptionKey } = await import('@/lib/secure-storage')
      storeEncryptionKey(user.identityId, trimmedKey)

      toast.success('Encryption key saved')
      setEncryptionKeyInput('')
      closeWithSuccess()

      // Call success callback if provided
      if (onSuccess) {
        onSuccess()
      }
    } catch (err) {
      console.error('Error validating encryption key:', err)
      setError(err instanceof Error ? err.message : 'Failed to validate key')
    } finally {
      setIsValidating(false)
    }
  }, [user, encryptionKeyInput, close, onSuccess])

  const handleClose = useCallback(() => {
    // State is reset by the useEffect when isOpen becomes false
    close()
  }, [close])

  const handleLostKeyFoundKey = useCallback(() => {
    // User says they found their key - close lost key modal and let them enter it
    setShowLostKeyModal(false)
  }, [])

  const handleLostKeyResetFeed = useCallback(() => {
    // User wants to reset their private feed - close both modals and navigate to settings
    setShowLostKeyModal(false)
    close()
    // Navigate to private feed settings with reset param
    if (typeof window !== 'undefined') {
      window.location.href = '/settings?section=privateFeed&action=reset'
    }
  }, [close])

  const handleAddKeySuccess = useCallback(() => {
    setShowAddKeyModal(false)
    setNoKeyOnIdentity(false)
    setError(null)
    // After adding the key, we still need the user to enter it
    // (unless they just generated it, in which case it was stored)
    // Call onSuccess since the key was added and stored
    toast.success('You can now use private feed features!')
    closeWithSuccess()
    if (onSuccess) {
      onSuccess()
    }
  }, [closeWithSuccess, onSuccess])

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

                    {/* Auto-recovery checking state */}
                    {(autoRecoveryStatus === 'checking' || autoRecoveryStatus === 'found') && (
                      <>
                        <Dialog.Title className="text-xl font-bold mb-2 flex items-center gap-2">
                          {autoRecoveryStatus === 'found' ? (
                            <CheckCircleIcon className="h-6 w-6 text-green-500" />
                          ) : (
                            <Spinner size="sm" className="h-6 w-6" />
                          )}
                          {autoRecoveryStatus === 'found' ? 'Key Recovered!' : 'Recovering Key...'}
                        </Dialog.Title>

                        <Dialog.Description className="text-gray-600 dark:text-gray-400 mb-6">
                          {autoRecoveryStatus === 'found'
                            ? 'Your encryption key was automatically recovered.'
                            : 'Attempting to automatically recover your encryption key...'}
                        </Dialog.Description>

                        <div className="flex flex-col items-center justify-center py-8">
                          {autoRecoveryStatus === 'checking' ? (
                            <>
                              <Spinner size="lg" className="mb-4" />
                              <p className="text-sm text-gray-500">{autoRecoveryMessage}</p>
                            </>
                          ) : (
                            <>
                              <CheckCircleIcon className="h-12 w-12 text-green-500 mb-4" />
                              <p className="text-sm text-green-600 dark:text-green-400">{autoRecoveryMessage}</p>
                            </>
                          )}
                        </div>
                      </>
                    )}

                    {/* Manual entry state (idle or failed) */}
                    {(autoRecoveryStatus === 'idle' || autoRecoveryStatus === 'failed') && (
                      <>
                        <Dialog.Title className="text-xl font-bold mb-2 flex items-center gap-2">
                          <KeyIcon className="h-6 w-6 text-yappr-500" />
                          Enter Encryption Key
                        </Dialog.Title>

                        <Dialog.Description className="text-gray-600 dark:text-gray-400 mb-4">
                          Enter your encryption private key to {actionDescription}.
                        </Dialog.Description>

                        {/* Auto-recovery failed message */}
                        {autoRecoveryStatus === 'failed' && autoRecoveryMessage && (
                          <div className="bg-blue-50 dark:bg-blue-950 p-3 rounded-lg mb-4">
                            <div className="flex gap-2">
                              <KeyIcon className="h-5 w-5 text-blue-600 dark:text-blue-400 flex-shrink-0" />
                              <p className="text-sm text-blue-700 dark:text-blue-300">
                                {autoRecoveryMessage}
                              </p>
                            </div>
                          </div>
                        )}

                        {/* Info box */}
                        <div className="bg-amber-50 dark:bg-amber-950 p-3 rounded-lg mb-4">
                          <div className="flex gap-2">
                            <ExclamationTriangleIcon className="h-5 w-5 text-amber-600 dark:text-amber-400 flex-shrink-0" />
                            <p className="text-sm text-amber-700 dark:text-amber-300">
                              Your encryption key is stored securely in this browser session. You&apos;ll need to enter it again after logging out or using a different device.
                            </p>
                          </div>
                        </div>

                        <div className="space-y-3 mb-4">
                          <div className="space-y-2">
                            <label className="text-sm font-medium">
                              Encryption Private Key
                            </label>
                            <Input
                              type="password"
                              placeholder="WIF (cXyz...) or hex (64 chars)"
                              value={encryptionKeyInput}
                              onChange={(e) => {
                                setEncryptionKeyInput(e.target.value)
                                setError(null)
                              }}
                              className="font-mono text-sm"
                              autoFocus
                            />
                            {error && (
                              <div className="space-y-2">
                                <p className="text-sm text-red-600 dark:text-red-400">
                                  {error}
                                </p>
                                {noKeyOnIdentity && (
                                  <div className="p-3 bg-blue-50 dark:bg-blue-950 rounded-lg">
                                    <p className="text-sm text-blue-700 dark:text-blue-300 mb-2">
                                      You need to add an encryption key to your identity first.
                                    </p>
                                    <Button
                                      size="sm"
                                      onClick={() => setShowAddKeyModal(true)}
                                      className="w-full"
                                    >
                                      <PlusIcon className="h-4 w-4 mr-2" />
                                      Add Encryption Key
                                    </Button>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        </div>

                        <div className="flex flex-col gap-3">
                          <Button
                            onClick={validateAndStoreKey}
                            disabled={isValidating || !encryptionKeyInput.trim()}
                            className="w-full"
                          >
                            {isValidating ? (
                              <>
                                <Spinner size="xs" className="mr-2" />
                                Validating...
                              </>
                            ) : (
                              <>
                                <LockClosedIcon className="h-4 w-4 mr-2" />
                                Save Key
                              </>
                            )}
                          </Button>
                          <Button onClick={handleClose} variant="outline" className="w-full">
                            Skip for now
                          </Button>
                        </div>

                        <div className="mt-4 text-center text-xs text-gray-500 space-y-1">
                          <p>
                            Don&apos;t have an encryption key?{' '}
                            <button
                              onClick={() => setShowAddKeyModal(true)}
                              className="text-yappr-500 hover:underline"
                            >
                              Add one to your identity
                            </button>
                          </p>
                          <p>
                            Lost your key?{' '}
                            <button
                              onClick={() => setShowLostKeyModal(true)}
                              className="text-amber-600 dark:text-amber-400 hover:underline"
                            >
                              See recovery options
                            </button>
                          </p>
                        </div>
                      </>
                    )}
                  </motion.div>
                </Dialog.Content>
              </motion.div>
            </Dialog.Overlay>
          </Dialog.Portal>
        )}
      </AnimatePresence>

      {/* Add Encryption Key Modal */}
      <AddEncryptionKeyModal
        isOpen={showAddKeyModal}
        onClose={() => setShowAddKeyModal(false)}
        onSuccess={handleAddKeySuccess}
      />

      {/* Lost Encryption Key Modal */}
      <LostEncryptionKeyModal
        isOpen={showLostKeyModal}
        onClose={() => setShowLostKeyModal(false)}
        onFoundKey={handleLostKeyFoundKey}
        onResetPrivateFeed={handleLostKeyResetFeed}
      />
    </Dialog.Root>
  )
}
