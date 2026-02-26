'use client'

import { useState, useCallback, useEffect } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { XMarkIcon, KeyIcon, ExclamationTriangleIcon, CheckCircleIcon, ClipboardIcon, EyeIcon, EyeSlashIcon, ShieldCheckIcon, CheckIcon } from '@heroicons/react/24/outline'
import { motion, AnimatePresence } from 'framer-motion'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useAuth } from '@/contexts/auth-context'
import toast from 'react-hot-toast'
import { YAPPR_CONTRACT_ID } from '@/lib/constants'

type EncryptionKeyContext = 'private-feed' | 'store' | 'generic'

interface AddEncryptionKeyModalProps {
  isOpen: boolean
  onClose: () => void
  onSuccess?: () => void
  /** Context determines the messaging shown in the modal */
  context?: EncryptionKeyContext
}

type Step = 'checking' | 'existing-key' | 'enter-existing' | 'intro' | 'generate' | 'critical-key' | 'adding' | 'success' | 'error'

/**
 * AddEncryptionKeyModal Component
 *
 * Modal for deriving and adding an encryption key to an identity.
 * Uses HKDF derivation from auth key for zero-friction setup.
 * Implements PRD §6.2 - Key Addition Flow
 *
 * NOTE: Adding an encryption key to an identity requires a MASTER
 * security level key for signing. The typical HIGH security level login key
 * is insufficient for identity modifications on Dash Platform (SDK dev.11+).
 */
export function AddEncryptionKeyModal({
  isOpen,
  onClose,
  onSuccess,
  context = 'generic',
}: AddEncryptionKeyModalProps) {
  const { user } = useAuth()

  // Context-specific messaging
  const contextMessages = {
    'private-feed': {
      description: 'To use private feeds, you need an encryption key on your identity. This key is automatically recreated from your login key — unless your login key changes.',
      backupReason: 'If your login key ever changes, this backup is the only way to recover your private feed content.',
      benefits: [
        'Keeps your private posts private',
        'Lets you read private feeds you follow',
        'Manages access securely behind the scenes',
      ],
      successItems: [
        'Enable your private feed',
        'Request access to others\' private feeds',
        'View encrypted content from feeds you follow',
      ],
    },
    'store': {
      description: 'To receive orders, you need an encryption key on your identity. This allows buyers to securely send you their shipping details and order information.',
      backupReason: 'If your login key ever changes, this backup is the only way to decrypt past order messages.',
      benefits: [
        'Receive encrypted shipping addresses from buyers',
        'Securely communicate order details',
        'Protect customer information',
      ],
      successItems: [
        'Receive orders from buyers',
        'View encrypted shipping addresses',
        'Securely manage customer information',
      ],
    },
    'generic': {
      description: 'An encryption key allows you to send and receive encrypted messages on Dash Platform. This key is automatically recreated from your login key — unless your login key changes.',
      backupReason: 'If your login key ever changes, this backup is the only way to decrypt past encrypted content.',
      benefits: [
        'Send and receive encrypted messages',
        'Access encrypted content',
        'Secure communications on Dash Platform',
      ],
      successItems: [
        'Send and receive encrypted messages',
        'Access encrypted content',
        'Use features requiring encryption',
      ],
    },
  }

  const messages = contextMessages[context]
  const [step, setStep] = useState<Step>('checking')
  const [privateKeyWif, setPrivateKeyWif] = useState<string>('')
  const [privateKeyBytes, setPrivateKeyBytes] = useState<Uint8Array | null>(null)
  const [showPrivateKey, setShowPrivateKey] = useState(false)
  const [hasCopied, setHasCopied] = useState(false)
  const [hasConfirmedBackup, setHasConfirmedBackup] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // MASTER key for identity modification
  const [criticalKeyWif, setCriticalKeyWif] = useState<string>('')
  const [showCriticalKey, setShowCriticalKey] = useState(false)
  const [isValidatingKey, setIsValidatingKey] = useState(false)
  const [keyValidationError, setKeyValidationError] = useState<string | null>(null)
  // Enter-existing-key path
  const [existingKeyInput, setExistingKeyInput] = useState('')
  const [showExistingKeyInput, setShowExistingKeyInput] = useState(false)
  const [existingKeyError, setExistingKeyError] = useState<string | null>(null)
  const [isValidatingExistingKey, setIsValidatingExistingKey] = useState(false)
  const [isEnterExistingPath, setIsEnterExistingPath] = useState(false)

  // On modal open: check if user already has an encryption key on their identity.
  // If so, redirect to the enter-existing path instead of the create-new path.
  useEffect(() => {
    if (!isOpen || !user) return
    setStep('checking')
    import('@/lib/services/identity-service').then(({ identityService }) =>
      identityService.hasEncryptionKey(user.identityId)
    ).then(hasKey => {
      setStep(hasKey ? 'existing-key' : 'intro')
    }).catch(() => {
      // If check fails, default to the normal create flow
      setStep('intro')
    })
  }, [isOpen, user])

  // Attempt auto-derivation then fall back to manual entry for an existing on-chain key
  const enterExistingKey = useCallback(async () => {
    if (!user) return

    setIsValidatingExistingKey(true)

    try {
      const { getPrivateKey } = await import('@/lib/secure-storage')
      const authKeyWif = getPrivateKey(user.identityId)

      if (authKeyWif) {
        try {
          const { parsePrivateKey, privateKeyToWif } = await import('@/lib/crypto/wif')
          const { deriveEncryptionKey, validateDerivedKeyMatchesIdentity } = await import('@/lib/crypto/key-derivation')

          const parsed = parsePrivateKey(authKeyWif)
          const derivedKey = deriveEncryptionKey(parsed.privateKey, user.identityId)
          const matches = await validateDerivedKeyMatchesIdentity(derivedKey, user.identityId, 1)

          if (matches) {
            const network = (process.env.NEXT_PUBLIC_NETWORK as 'testnet' | 'mainnet') || 'testnet'
            const derivedKeyWif = privateKeyToWif(derivedKey, network, true)
            const { storeEncryptionKey, storeEncryptionKeyType } = await import('@/lib/secure-storage')
            storeEncryptionKey(user.identityId, derivedKeyWif)
            storeEncryptionKeyType(user.identityId, 'derived')
            setIsEnterExistingPath(true)
            setIsValidatingExistingKey(false)
            setStep('success')
            if (onSuccess) onSuccess()
            return
          }
        } catch (err) {
          console.error('Auto-derivation failed, falling back to manual entry:', err)
        }
      }
    } catch (err) {
      console.error('Error in enterExistingKey:', err)
    }

    // Auto-derivation unavailable or failed — show manual entry form
    setIsValidatingExistingKey(false)
    setStep('enter-existing')
  }, [user, onSuccess])

  // Validate a manually entered existing key and store it
  const validateAndStoreExistingKey = useCallback(async () => {
    if (!user || !existingKeyInput.trim()) return

    setIsValidatingExistingKey(true)
    setExistingKeyError(null)

    try {
      const { validateEncryptionKey } = await import('@/lib/crypto/key-validation')
      const validation = await validateEncryptionKey(existingKeyInput.trim(), user.identityId)

      if (!validation.isValid) {
        setExistingKeyError(validation.error || 'Invalid key')
        setIsValidatingExistingKey(false)
        return
      }

      const { storeEncryptionKey, storeEncryptionKeyType } = await import('@/lib/secure-storage')
      storeEncryptionKey(user.identityId, existingKeyInput.trim())
      storeEncryptionKeyType(user.identityId, 'external')
      setIsEnterExistingPath(true)
      setIsValidatingExistingKey(false)
      setStep('success')
      if (onSuccess) onSuccess()
    } catch (err) {
      console.error('Error validating existing key:', err)
      setExistingKeyError(err instanceof Error ? err.message : 'Failed to validate key')
      setIsValidatingExistingKey(false)
    }
  }, [user, existingKeyInput, onSuccess])

  // Derive encryption key from auth key using HKDF
  const deriveKey = useCallback(async () => {
    if (!user) return

    try {
      const { getPrivateKey } = await import('@/lib/secure-storage')
      const authKeyWif = getPrivateKey(user.identityId)
      if (!authKeyWif) {
        throw new Error('Auth key not found in storage')
      }

      // Parse auth key to bytes
      const { parsePrivateKey, privateKeyToWif } = await import('@/lib/crypto/wif')
      const parsed = parsePrivateKey(authKeyWif)
      const authPrivateKey = parsed.privateKey

      // Derive encryption key using HKDF
      const { deriveEncryptionKey } = await import('@/lib/crypto/key-derivation')
      const encryptionKeyBytes = deriveEncryptionKey(authPrivateKey, user.identityId)
      const network = (process.env.NEXT_PUBLIC_NETWORK as 'testnet' | 'mainnet') || 'testnet'
      const encryptionKeyWif = privateKeyToWif(encryptionKeyBytes, network, true)

      setPrivateKeyBytes(encryptionKeyBytes)
      setPrivateKeyWif(encryptionKeyWif)
      setStep('generate')
    } catch (err) {
      console.error('Error deriving encryption key:', err)
      setError(err instanceof Error ? err.message : 'Failed to derive encryption key')
      setStep('error')
    }
  }, [user])

  // Copy private key to clipboard
  const copyToClipboard = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(privateKeyWif)
      setHasCopied(true)
      toast.success('Private key copied to clipboard')
    } catch (err) {
      console.error('Failed to copy:', err)
      toast.error('Failed to copy to clipboard')
    }
  }, [privateKeyWif])

  // Add the encryption key to identity
  const addKeyToIdentity = useCallback(async () => {
    if (!user || !privateKeyWif || !privateKeyBytes || !criticalKeyWif.trim()) return

    setStep('adding')
    setError(null)

    try {
      const { storeEncryptionKey, storeEncryptionKeyType } = await import('@/lib/secure-storage')

      // Add the encryption key to identity using the MASTER-level key
      const { identityService } = await import('@/lib/services/identity-service')
      const result = await identityService.addEncryptionKey(
        user.identityId,
        privateKeyBytes,
        criticalKeyWif.trim(),
        YAPPR_CONTRACT_ID // Contract-bound to Yappr
      )

      if (result.success) {
        // Store the encryption key in session (WIF format)
        storeEncryptionKey(user.identityId, privateKeyWif)
        // Mark as derived since we derived it from auth key
        storeEncryptionKeyType(user.identityId, 'derived')

        setStep('success')
        toast.success('Encryption key added to your identity!')

        if (onSuccess) {
          onSuccess()
        }
      } else {
        setError(result.error || 'Failed to add encryption key')
        setStep('error')
      }
    } catch (err) {
      console.error('Error adding encryption key:', err)
      setError(err instanceof Error ? err.message : 'Unknown error occurred')
      setStep('error')
    }
  }, [user, privateKeyWif, privateKeyBytes, criticalKeyWif, onSuccess])

  // Validate the CRITICAL key before proceeding
  const validateCriticalKey = useCallback(async () => {
    if (!user || !criticalKeyWif.trim()) {
      setKeyValidationError('Please enter your Master key')
      return
    }

    setIsValidatingKey(true)
    setKeyValidationError(null)

    try {
      const { identityService } = await import('@/lib/services/identity-service')
      const validation = await identityService.validateKeySecurityLevel(
        criticalKeyWif.trim(),
        user.identityId
      )

      if (!validation.isValid) {
        setKeyValidationError(validation.error || 'Invalid key')
        setIsValidatingKey(false)
        return
      }

      // Key is valid, proceed to add the encryption key
      setIsValidatingKey(false)
      await addKeyToIdentity()
    } catch (err) {
      console.error('Error validating key:', err)
      setKeyValidationError(err instanceof Error ? err.message : 'Failed to validate key')
      setIsValidatingKey(false)
    }
  }, [user, criticalKeyWif, addKeyToIdentity])

  // Handle close
  const handleClose = useCallback(() => {
    // Reset state
    setStep('checking')
    setPrivateKeyWif('')
    setPrivateKeyBytes(null)
    setShowPrivateKey(false)
    setHasCopied(false)
    setHasConfirmedBackup(false)
    setError(null)
    setCriticalKeyWif('')
    setShowCriticalKey(false)
    setKeyValidationError(null)
    setExistingKeyInput('')
    setShowExistingKeyInput(false)
    setExistingKeyError(null)
    setIsValidatingExistingKey(false)
    setIsEnterExistingPath(false)
    onClose()
  }, [onClose])

  // Render step content
  const renderStepContent = () => {
    switch (step) {
      case 'checking':
        return (
          <>
            <Dialog.Title className="text-xl font-bold mb-2 flex items-center gap-2">
              <KeyIcon className="h-6 w-6 text-yappr-500" />
              Checking Identity...
            </Dialog.Title>

            <div className="flex flex-col items-center justify-center py-8">
              <Spinner size="lg" className="mb-4" />
              <p className="text-gray-600 dark:text-gray-400 text-center">
                Checking your identity for an existing encryption key...
              </p>
            </div>
          </>
        )

      case 'existing-key':
        return (
          <>
            <Dialog.Title className="text-xl font-bold mb-2 flex items-center gap-2">
              <KeyIcon className="h-6 w-6 text-yappr-500" />
              Encryption Key Already Set Up
            </Dialog.Title>

            <Dialog.Description className="text-gray-600 dark:text-gray-400 mb-4">
              Your identity already has an encryption key registered on Dash Platform.
            </Dialog.Description>

            <div className="space-y-4 mb-6">
              <div className="bg-blue-50 dark:bg-blue-950 p-4 rounded-lg">
                <div className="flex gap-3">
                  <ShieldCheckIcon className="h-5 w-5 text-blue-600 dark:text-blue-400 flex-shrink-0" />
                  <div className="text-sm text-blue-700 dark:text-blue-300">
                    <p className="font-medium">Key found on your identity</p>
                    <p className="mt-1">
                      Enter your existing encryption key to restore access in this session.
                      If your key was derived from your login key, it will be recovered automatically.
                    </p>
                  </div>
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-3">
              <Button onClick={enterExistingKey} className="w-full" disabled={isValidatingExistingKey}>
                {isValidatingExistingKey ? (
                  <>
                    <Spinner size="xs" className="mr-2" />
                    Recovering key...
                  </>
                ) : (
                  <>
                    <KeyIcon className="h-4 w-4 mr-2" />
                    Enter Existing Key
                  </>
                )}
              </Button>
              <Button
                onClick={() => setStep('intro')}
                variant="outline"
                className="w-full text-sm"
                disabled={isValidatingExistingKey}
              >
                Create Replacement Key Instead
              </Button>
              <Button onClick={handleClose} variant="outline" className="w-full" disabled={isValidatingExistingKey}>
                Cancel
              </Button>
            </div>
          </>
        )

      case 'enter-existing':
        return (
          <>
            <Dialog.Title className="text-xl font-bold mb-2 flex items-center gap-2">
              <KeyIcon className="h-6 w-6 text-yappr-500" />
              Enter Your Encryption Key
            </Dialog.Title>

            <Dialog.Description className="text-gray-600 dark:text-gray-400 mb-4">
              Your encryption key could not be automatically recovered. Enter it manually below.
            </Dialog.Description>

            <div className="space-y-4 mb-6">
              <div className="space-y-2">
                <div className="text-sm font-medium flex items-center justify-between">
                  <span>Encryption Key</span>
                  <button
                    type="button"
                    onClick={() => setShowExistingKeyInput(!showExistingKeyInput)}
                    className="text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 p-1"
                  >
                    {showExistingKeyInput ? (
                      <EyeSlashIcon className="h-4 w-4" />
                    ) : (
                      <EyeIcon className="h-4 w-4" />
                    )}
                  </button>
                </div>
                <input
                  type={showExistingKeyInput ? 'text' : 'password'}
                  value={existingKeyInput}
                  onChange={(e) => {
                    setExistingKeyInput(e.target.value)
                    setExistingKeyError(null)
                  }}
                  placeholder="WIF (cXyz...) or hex (64 chars)"
                  className="w-full px-3 py-2 bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg font-mono text-sm focus:outline-none focus:ring-2 focus:ring-yappr-500"
                />
                {existingKeyError && (
                  <p className="text-sm text-red-600 dark:text-red-400">{existingKeyError}</p>
                )}
              </div>
              <p className="text-xs text-gray-500">
                Enter the WIF or hex format of your encryption key. This is the key associated with your identity on Dash Platform.
              </p>
            </div>

            <div className="flex flex-col gap-3">
              <Button
                onClick={validateAndStoreExistingKey}
                disabled={!existingKeyInput.trim() || isValidatingExistingKey}
                className="w-full"
              >
                {isValidatingExistingKey ? (
                  <>
                    <Spinner size="xs" className="mr-2" />
                    Validating...
                  </>
                ) : (
                  <>
                    <KeyIcon className="h-4 w-4 mr-2" />
                    Save Key
                  </>
                )}
              </Button>
              <Button
                onClick={() => setStep('existing-key')}
                variant="outline"
                className="w-full"
                disabled={isValidatingExistingKey}
              >
                Back
              </Button>
            </div>
          </>
        )

      case 'intro':
        return (
          <>
            <Dialog.Title className="text-xl font-bold mb-2 flex items-center gap-2">
              <KeyIcon className="h-6 w-6 text-yappr-500" />
              Add Encryption Key
            </Dialog.Title>

            <Dialog.Description className="text-gray-600 dark:text-gray-400 mb-4">
              {messages.description}
            </Dialog.Description>

            <div className="space-y-4 mb-6">
              <div className="bg-amber-50 dark:bg-amber-950 p-4 rounded-lg">
                <div className="flex gap-3">
                  <ExclamationTriangleIcon className="h-5 w-5 text-amber-600 dark:text-amber-400 flex-shrink-0" />
                  <div className="text-sm text-amber-700 dark:text-amber-300 space-y-2">
                    <p className="font-medium">Why save a backup?</p>
                    <p>
                      {messages.backupReason} The key will be shown once.
                    </p>
                  </div>
                </div>
              </div>

              <div className="bg-gray-50 dark:bg-gray-900 p-4 rounded-lg">
                <h4 className="font-medium mb-2 text-sm">What this key does:</h4>
                <ul className="text-sm text-gray-600 dark:text-gray-400 space-y-1">
                  {messages.benefits.map((benefit, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="text-yappr-500">•</span>
                      {benefit}
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            <div className="flex flex-col gap-3">
              <Button onClick={deriveKey} className="w-full">
                <KeyIcon className="h-4 w-4 mr-2" />
                Create Encryption Key
              </Button>
              <Button onClick={handleClose} variant="outline" className="w-full">
                Cancel
              </Button>
            </div>
          </>
        )

      case 'generate':
        return (
          <>
            <Dialog.Title className="text-xl font-bold mb-2 flex items-center gap-2">
              <KeyIcon className="h-6 w-6 text-yappr-500" />
              Save Your Encryption Key
            </Dialog.Title>

            <Dialog.Description className="text-gray-600 dark:text-gray-400 mb-4">
              Your encryption key has been created. Save it securely as backup.
            </Dialog.Description>

            <div className="space-y-4 mb-6">
              {/* Warning */}
              <div className="bg-amber-50 dark:bg-amber-950 p-4 rounded-lg border border-amber-200 dark:border-amber-800">
                <div className="flex gap-3">
                  <ExclamationTriangleIcon className="h-5 w-5 text-amber-600 dark:text-amber-400 flex-shrink-0" />
                  <div className="text-sm text-amber-700 dark:text-amber-300">
                    <p className="font-bold">Why save this?</p>
                    <p>{messages.backupReason}</p>
                  </div>
                </div>
              </div>

              {/* Encryption Key Display */}
              <div className="space-y-2">
                <label className="text-sm font-medium">Encryption Key (WIF)</label>
                <p className="text-xs text-gray-500 dark:text-gray-400">Used only for private feeds. Does not control funds.</p>
                <div className="flex items-center bg-gray-100 dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
                  <div className="flex-1 p-3 font-mono text-sm overflow-hidden min-h-[44px] flex items-center">
                    {showPrivateKey ? (
                      <span>
                        {privateKeyWif.slice(0, Math.ceil(privateKeyWif.length / 2))}
                        <br />
                        {privateKeyWif.slice(Math.ceil(privateKeyWif.length / 2))}
                      </span>
                    ) : (
                      <span className="truncate">••••••••••••••••••••••••••••••••</span>
                    )}
                  </div>
                  <div className="flex items-center gap-1 px-2 border-l border-gray-200 dark:border-gray-700">
                    <button
                      type="button"
                      onClick={() => setShowPrivateKey(!showPrivateKey)}
                      className="p-2 text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 rounded transition-colors"
                      title={showPrivateKey ? 'Hide key' : 'Show key'}
                    >
                      {showPrivateKey ? (
                        <EyeSlashIcon className="h-5 w-5" />
                      ) : (
                        <EyeIcon className="h-5 w-5" />
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={copyToClipboard}
                      className="p-2 text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 rounded transition-colors"
                      title="Copy to clipboard"
                    >
                      {hasCopied ? (
                        <CheckIcon className="h-5 w-5 text-green-500" />
                      ) : (
                        <ClipboardIcon className="h-5 w-5" />
                      )}
                    </button>
                  </div>
                </div>
              </div>

              {/* Backup Confirmation */}
              <div className="flex items-start gap-3 p-3 bg-gray-50 dark:bg-gray-900 rounded-lg">
                <input
                  type="checkbox"
                  id="confirm-backup"
                  checked={hasConfirmedBackup}
                  onChange={(e) => setHasConfirmedBackup(e.target.checked)}
                  className="mt-1 h-4 w-4 rounded border-gray-300 text-yappr-600 focus:ring-yappr-500"
                />
                <label
                  htmlFor="confirm-backup"
                  className="text-sm cursor-pointer select-none"
                >
                  I have securely saved this encryption key in a password manager or other secure location
                </label>
              </div>
            </div>

            <div className="flex flex-col gap-3">
              <Button
                onClick={() => setStep('critical-key')}
                disabled={!hasConfirmedBackup}
                className="w-full"
              >
                Continue
              </Button>
              <Button onClick={handleClose} variant="outline" className="w-full">
                Cancel (discards unused key)
              </Button>
            </div>
          </>
        )

      case 'critical-key':
        return (
          <>
            <Dialog.Title className="text-xl font-bold mb-2 flex items-center gap-2">
              <ShieldCheckIcon className="h-6 w-6 text-yappr-500" />
              Confirm with Master Key
            </Dialog.Title>

            <Dialog.Description className="text-gray-600 dark:text-gray-400 mb-4">
              Enter your Master key to confirm this change to your identity.
            </Dialog.Description>

            <div className="space-y-4 mb-6">
              <div className="bg-gray-50 dark:bg-gray-900 p-4 rounded-lg">
                <div className="text-sm text-gray-600 dark:text-gray-400">
                  <p>
                    Your Master key is different from your login key.
                    It was provided when you created your identity.
                  </p>
                </div>
              </div>

              {/* Master Key Input */}
              <div className="space-y-2">
                <div className="text-sm font-medium flex items-center justify-between">
                  <span>Master Key</span>
                  <button
                    type="button"
                    onClick={() => setShowCriticalKey(!showCriticalKey)}
                    className="text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 p-1"
                  >
                    {showCriticalKey ? (
                      <EyeSlashIcon className="h-4 w-4" />
                    ) : (
                      <EyeIcon className="h-4 w-4" />
                    )}
                  </button>
                </div>
                <input
                  type={showCriticalKey ? 'text' : 'password'}
                  value={criticalKeyWif}
                  onChange={(e) => {
                    setCriticalKeyWif(e.target.value)
                    setKeyValidationError(null)
                  }}
                  placeholder="Enter your Master key..."
                  className="w-full px-3 py-2 bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg font-mono text-sm focus:outline-none focus:ring-2 focus:ring-yappr-500"
                />
                {keyValidationError && (
                  <p className="text-sm text-red-600 dark:text-red-400">{keyValidationError}</p>
                )}
              </div>

              <div className="text-xs text-gray-500 space-y-2">
                <p>
                  Starts with &apos;c&apos; (testnet) or &apos;X&apos; (mainnet), about 51-52 characters.
                </p>
                <p>
                  This will cost a small amount of credits from your identity balance.
                </p>
              </div>
            </div>

            <div className="flex flex-col gap-3">
              <Button
                onClick={validateCriticalKey}
                disabled={!criticalKeyWif.trim() || isValidatingKey}
                className="w-full"
              >
                {isValidatingKey ? (
                  <>
                    <Spinner size="xs" className="mr-2" />
                    Validating...
                  </>
                ) : (
                  <>
                    <KeyIcon className="h-4 w-4 mr-2" />
                    Add Encryption Key
                  </>
                )}
              </Button>
              <Button onClick={() => setStep('generate')} variant="outline" className="w-full" disabled={isValidatingKey}>
                Back
              </Button>
            </div>
          </>
        )

      case 'adding':
        return (
          <>
            <Dialog.Title className="text-xl font-bold mb-2 flex items-center gap-2">
              <KeyIcon className="h-6 w-6 text-yappr-500" />
              Adding Encryption Key
            </Dialog.Title>

            <div className="flex flex-col items-center justify-center py-8">
              <Spinner size="lg" className="mb-4" />
              <p className="text-gray-600 dark:text-gray-400 text-center">
                Broadcasting identity update transaction...
              </p>
              <p className="text-sm text-gray-500 mt-2 text-center">
                This may take a few seconds
              </p>
            </div>
          </>
        )

      case 'success':
        return (
          <>
            <Dialog.Title className="text-xl font-bold mb-2 flex items-center gap-2">
              <CheckCircleIcon className="h-6 w-6 text-green-500" />
              {isEnterExistingPath ? 'Encryption Key Restored' : 'Encryption Key Added'}
            </Dialog.Title>

            <div className="space-y-4 mb-6">
              <div className="bg-green-50 dark:bg-green-950 p-4 rounded-lg">
                <div className="flex gap-3">
                  <CheckCircleIcon className="h-5 w-5 text-green-600 dark:text-green-400 flex-shrink-0" />
                  <div className="text-sm text-green-700 dark:text-green-300">
                    <p className="font-medium">Success!</p>
                    <p>
                      {isEnterExistingPath
                        ? 'Your encryption key has been saved for this session and is ready to use.'
                        : 'Your encryption key has been added to your identity and is now ready to use.'
                      }
                    </p>
                  </div>
                </div>
              </div>

              <div className="text-sm text-gray-600 dark:text-gray-400 space-y-2">
                <p>You can now:</p>
                <ul className="list-disc ml-5 space-y-1">
                  {messages.successItems.map((item, i) => (
                    <li key={i}>{item}</li>
                  ))}
                </ul>
              </div>
            </div>

            <Button onClick={handleClose} className="w-full">
              Done
            </Button>
          </>
        )

      case 'error':
        return (
          <>
            <Dialog.Title className="text-xl font-bold mb-2 flex items-center gap-2">
              <ExclamationTriangleIcon className="h-6 w-6 text-red-500" />
              Error
            </Dialog.Title>

            <div className="space-y-4 mb-6">
              <div className="bg-red-50 dark:bg-red-950 p-4 rounded-lg">
                <p className="text-sm text-red-700 dark:text-red-300">
                  {error || 'An unknown error occurred'}
                </p>
              </div>

              {privateKeyWif && (
                <div className="bg-amber-50 dark:bg-amber-950 p-4 rounded-lg">
                  <p className="text-sm text-amber-700 dark:text-amber-300">
                    <strong>Note:</strong> Your encryption key was derived. If you saved it, you can try again later.
                  </p>
                </div>
              )}
            </div>

            <div className="flex flex-col gap-3">
              <Button onClick={() => setStep(privateKeyWif ? 'critical-key' : 'intro')} className="w-full">
                Try Again
              </Button>
              <Button onClick={handleClose} variant="outline" className="w-full">
                Close
              </Button>
            </div>
          </>
        )
    }
  }

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
                    className="bg-white dark:bg-neutral-900 rounded-2xl p-6 w-[500px] max-w-[95vw] max-h-[90vh] overflow-y-auto shadow-xl relative"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {step !== 'adding' && (
                      <button
                        onClick={handleClose}
                        className="absolute top-4 right-4 p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors"
                      >
                        <XMarkIcon className="h-5 w-5" />
                      </button>
                    )}

                    {renderStepContent()}
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
