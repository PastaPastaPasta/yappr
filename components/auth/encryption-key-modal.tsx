'use client'

import { useState, useCallback } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { XMarkIcon, LockClosedIcon, ExclamationTriangleIcon, KeyIcon, PlusIcon } from '@heroicons/react/24/outline'
import { motion, AnimatePresence } from 'framer-motion'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useEncryptionKeyModal, getEncryptionKeyActionDescription } from '@/hooks/use-encryption-key-modal'
import { useAuth } from '@/contexts/auth-context'
import { AddEncryptionKeyModal } from './add-encryption-key-modal'
import { LostEncryptionKeyModal } from './lost-encryption-key-modal'
import toast from 'react-hot-toast'

/**
 * EncryptionKeyModal Component
 *
 * Modal for entering encryption private key after login.
 * Implements PRD §6.3 - Encryption Key Entry on Login
 */
export function EncryptionKeyModal() {
  const { user } = useAuth()
  const { isOpen, action, onSuccess, close } = useEncryptionKeyModal()
  const [encryptionKeyHex, setEncryptionKeyHex] = useState('')
  const [isValidating, setIsValidating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showAddKeyModal, setShowAddKeyModal] = useState(false)
  const [showLostKeyModal, setShowLostKeyModal] = useState(false)
  const [noKeyOnIdentity, setNoKeyOnIdentity] = useState(false)

  const actionDescription = getEncryptionKeyActionDescription(action)

  const validateAndStoreKey = useCallback(async () => {
    if (!user) return

    // Remove 0x prefix if present
    let cleanHex = encryptionKeyHex.trim()
    if (cleanHex.startsWith('0x')) {
      cleanHex = cleanHex.slice(2)
    }

    // Check length (32 bytes = 64 hex chars)
    if (cleanHex.length !== 64) {
      setError(`Key must be 64 hex characters (32 bytes), got ${cleanHex.length}`)
      return
    }

    // Check valid hex
    if (!/^[0-9a-fA-F]+$/.test(cleanHex)) {
      setError('Key must contain only hexadecimal characters (0-9, a-f)')
      return
    }

    setIsValidating(true)
    setError(null)

    try {
      // Parse to Uint8Array
      const keyBytes = new Uint8Array(32)
      for (let i = 0; i < 32; i++) {
        keyBytes[i] = parseInt(cleanHex.substr(i * 2, 2), 16)
      }

      // Verify the key by deriving its public key and checking against identity
      const { privateFeedCryptoService } = await import('@/lib/services')
      const { identityService } = await import('@/lib/services/identity-service')

      // Derive public key from private key
      let derivedPubKey: Uint8Array
      try {
        derivedPubKey = privateFeedCryptoService.getPublicKey(keyBytes)
      } catch {
        setError('Invalid private key format')
        setIsValidating(false)
        return
      }

      // Fetch user's identity to check for encryption key
      const identityData = await identityService.getIdentity(user.identityId)
      if (!identityData) {
        setError('Could not fetch identity data')
        setIsValidating(false)
        return
      }

      // Find encryption key on identity (purpose = 1 for ENCRYPTION)
      const encryptionPubKey = identityData.publicKeys.find(
        (key) => key.purpose === 1 && key.type === 0
      )

      if (!encryptionPubKey) {
        setError('No encryption key found on your identity.')
        setNoKeyOnIdentity(true)
        setIsValidating(false)
        return
      }

      // Verify the derived public key matches the on-chain key
      // Public key data can be in different formats
      let onChainPubKeyBytes: Uint8Array | null = null
      if (encryptionPubKey.data) {
        if (encryptionPubKey.data instanceof Uint8Array) {
          onChainPubKeyBytes = encryptionPubKey.data
        } else if (typeof encryptionPubKey.data === 'string') {
          // Could be hex or base64
          if (/^[0-9a-fA-F]+$/.test(encryptionPubKey.data)) {
            // Hex
            onChainPubKeyBytes = new Uint8Array(encryptionPubKey.data.length / 2)
            for (let i = 0; i < onChainPubKeyBytes.length; i++) {
              onChainPubKeyBytes[i] = parseInt(encryptionPubKey.data.substr(i * 2, 2), 16)
            }
          } else {
            // Assume base64
            const binary = atob(encryptionPubKey.data)
            onChainPubKeyBytes = new Uint8Array(binary.length)
            for (let i = 0; i < binary.length; i++) {
              onChainPubKeyBytes[i] = binary.charCodeAt(i)
            }
          }
        }
      }

      if (onChainPubKeyBytes) {
        // Compare public keys (compressed format is 33 bytes)
        const matches = derivedPubKey.length === onChainPubKeyBytes.length &&
          derivedPubKey.every((b, i) => b === onChainPubKeyBytes[i])

        if (!matches) {
          setError('This key does not match the encryption key on your identity')
          setIsValidating(false)
          return
        }
      }

      // Key is valid - store it
      const { storeEncryptionKey } = await import('@/lib/secure-storage')
      storeEncryptionKey(user.identityId, cleanHex)

      toast.success('Encryption key saved')
      setEncryptionKeyHex('')
      close()

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
  }, [user, encryptionKeyHex, close, onSuccess])

  const handleClose = useCallback(() => {
    setEncryptionKeyHex('')
    setError(null)
    setNoKeyOnIdentity(false)
    setShowLostKeyModal(false)
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
    close()
    if (onSuccess) {
      onSuccess()
    }
  }, [close, onSuccess])

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
                    <Dialog.Title className="text-xl font-bold mb-2 flex items-center gap-2">
                      <KeyIcon className="h-6 w-6 text-yappr-500" />
                      Enter Encryption Key
                    </Dialog.Title>

                    <Dialog.Description className="text-gray-600 dark:text-gray-400 mb-4">
                      Enter your encryption private key to {actionDescription}.
                    </Dialog.Description>

                    <button
                      onClick={handleClose}
                      className="absolute top-4 right-4 p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors"
                    >
                      <XMarkIcon className="h-5 w-5" />
                    </button>

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
                          Encryption Private Key (hex)
                        </label>
                        <Input
                          type="password"
                          placeholder="Enter 64 hex characters (e.g., 0xabc123...)"
                          value={encryptionKeyHex}
                          onChange={(e) => {
                            setEncryptionKeyHex(e.target.value)
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
                        disabled={isValidating || !encryptionKeyHex.trim()}
                        className="w-full"
                      >
                        {isValidating ? (
                          <>
                            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
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
