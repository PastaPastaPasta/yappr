'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Eye, EyeOff } from 'lucide-react'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useAuth } from '@/contexts/auth-context'
import { useSettingsStore } from '@/lib/store'
import { useLoginModal } from '@/hooks/use-login-modal'
import { Button } from '@/components/ui/button'
import { identityService } from '@/lib/services/identity-service'
import { dpnsService } from '@/lib/services/dpns-service'
import { keyValidationService, type KeyValidationResult } from '@/lib/services/key-validation-service'
import { encryptedKeyService } from '@/lib/services/encrypted-key-service'
import { isLikelyWif } from '@/lib/crypto/wif'
import { useKeyBackupModal } from '@/hooks/use-key-backup-modal'

// Check if input looks like an Identity ID (base58, ~44 chars)
function isLikelyIdentityId(input: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{42,46}$/.test(input)
}

interface IdentityPublicKey {
  id: number
  type: number
  purpose: number
  securityLevel: number
  data: string | Uint8Array
}

interface ResolvedIdentity {
  id: string
  balance: number
  publicKeys: IdentityPublicKey[]
  dpnsUsername?: string
}

type CredentialType = 'key' | 'password' | null

export function LoginModal() {
  const router = useRouter()
  const { isOpen, close } = useLoginModal()
  const potatoMode = useSettingsStore((s) => s.potatoMode)

  // Identity lookup states
  const [identityInput, setIdentityInput] = useState('')
  const [isLookingUp, setIsLookingUp] = useState(false)
  const [lookupError, setLookupError] = useState<string | null>(null)
  const [resolvedIdentity, setResolvedIdentity] = useState<ResolvedIdentity | null>(null)

  // Unified credential field (password OR private key)
  const [credential, setCredential] = useState('')
  const [showCredential, setShowCredential] = useState(false)
  const [detectedCredentialType, setDetectedCredentialType] = useState<CredentialType>(null)
  const [hasOnchainBackup, setHasOnchainBackup] = useState<boolean | null>(null)

  // Key validation states
  const [keyValidationStatus, setKeyValidationStatus] = useState<'idle' | 'validating' | 'valid' | 'invalid'>('idle')
  const [keyValidationResult, setKeyValidationResult] = useState<KeyValidationResult | null>(null)

  // Form states
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [rememberMe, setRememberMe] = useState(true)

  const { login, loginWithPassword } = useAuth()
  const openBackupModal = useKeyBackupModal((state) => state.open)

  // Reset form when modal closes
  useEffect(() => {
    if (!isOpen) {
      setIdentityInput('')
      setCredential('')
      setShowCredential(false)
      setIsLookingUp(false)
      setResolvedIdentity(null)
      setLookupError(null)
      setError(null)
      setKeyValidationStatus('idle')
      setKeyValidationResult(null)
      setDetectedCredentialType(null)
      setHasOnchainBackup(null)
    }
  }, [isOpen])

  // Debounced identity lookup
  useEffect(() => {
    if (!identityInput || identityInput.length < 3) {
      setResolvedIdentity(null)
      setLookupError(null)
      setHasOnchainBackup(null)
      return
    }

    const timeoutId = setTimeout(async () => {
      setIsLookingUp(true)
      setLookupError(null)
      setResolvedIdentity(null)
      setHasOnchainBackup(null)
      setKeyValidationStatus('idle')
      setKeyValidationResult(null)

      try {
        let identityId = identityInput.trim()

        if (!isLikelyIdentityId(identityId)) {
          const resolved = await dpnsService.resolveIdentity(identityId)
          if (!resolved) {
            setLookupError('Username not found')
            setIsLookingUp(false)
            return
          }
          identityId = resolved
        }

        const identity = await identityService.getIdentity(identityId)
        if (!identity) {
          setLookupError('Identity not found')
          setIsLookingUp(false)
          return
        }

        let dpnsUsername: string | undefined
        if (isLikelyIdentityId(identityInput.trim())) {
          dpnsUsername = await dpnsService.resolveUsername(identityId) || undefined
        } else {
          dpnsUsername = identityInput.trim().toLowerCase().replace(/\.dash$/, '') + '.dash'
        }

        setResolvedIdentity({
          id: identity.id,
          balance: identity.balance,
          publicKeys: identity.publicKeys,
          dpnsUsername
        })

        if (encryptedKeyService.isConfigured()) {
          encryptedKeyService.hasBackup(identityId)
            .then(hasBackup => setHasOnchainBackup(hasBackup))
            .catch(() => setHasOnchainBackup(false))
        } else {
          setHasOnchainBackup(false)
        }
      } catch (err) {
        console.error('Identity lookup error:', err)
        setLookupError('Failed to lookup identity')
      } finally {
        setIsLookingUp(false)
      }
    }, 500)

    return () => clearTimeout(timeoutId)
  }, [identityInput])

  // Credential type detection and key validation
  useEffect(() => {
    if (!credential) {
      setKeyValidationStatus('idle')
      setKeyValidationResult(null)
      setDetectedCredentialType(null)
      return
    }

    const isKey = isLikelyWif(credential)
    setDetectedCredentialType(isKey ? 'key' : 'password')

    if (!isKey) {
      setKeyValidationStatus('idle')
      setKeyValidationResult(null)
      return
    }

    if (!resolvedIdentity) {
      setKeyValidationStatus('idle')
      setKeyValidationResult(null)
      return
    }

    const timeoutId = setTimeout(async () => {
      setKeyValidationStatus('validating')

      try {
        const result = await keyValidationService.validatePrivateKey(
          credential,
          resolvedIdentity.id,
          'testnet'
        )
        setKeyValidationResult(result)
        setKeyValidationStatus(result.isValid ? 'valid' : 'invalid')
      } catch (err) {
        console.error('Key validation error:', err)
        setKeyValidationStatus('invalid')
        setKeyValidationResult({
          isValid: false,
          error: 'Failed to validate key',
          errorType: 'INVALID_WIF'
        })
      }
    }, 300)

    return () => clearTimeout(timeoutId)
  }, [credential, resolvedIdentity])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    // Guard against submit when form is not ready (e.g., Enter key bypass)
    if (isLoading || !credential || !resolvedIdentity) {
      return
    }

    setError(null)
    setIsLoading(true)

    try {
      const identityId = resolvedIdentity.id

      if (detectedCredentialType === 'key') {
        if (keyValidationStatus !== 'valid') {
          setError('Private key does not match this identity')
          setIsLoading(false)
          return
        }

        await login(identityId, credential, { rememberMe })

        if (encryptedKeyService.isConfigured() && !sessionStorage.getItem('yappr_backup_prompt_shown')) {
          const hasBackup = await encryptedKeyService.hasBackup(identityId)
          if (!hasBackup) {
            sessionStorage.setItem('yappr_backup_prompt_shown', 'true')
            openBackupModal(identityId, resolvedIdentity?.dpnsUsername || '', credential, false)
          }
        }
      } else {
        const username = resolvedIdentity?.dpnsUsername || identityInput
        await loginWithPassword(username, credential, rememberMe)
      }

      close()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to login')
    } finally {
      setIsLoading(false)
    }
  }

  const handleClose = () => {
    close()
    // If we're on /login, navigate away
    if (typeof window !== 'undefined' && window.location.pathname === '/login') {
      router.push('/')
    }
  }

  const canSubmit = (() => {
    if (!resolvedIdentity || isLoading || !credential) return false

    if (detectedCredentialType === 'key') {
      return keyValidationStatus === 'valid'
    } else if (detectedCredentialType === 'password') {
      return hasOnchainBackup && credential.length >= 16
    }

    return false
  })()

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Modal container - handles backdrop click for dismissal */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={handleClose}
            className={`fixed inset-0 z-50 flex items-center justify-center px-4 bg-black/60 ${potatoMode ? '' : 'backdrop-blur-sm'}`}
          >
            {/* Modal content - stop propagation to prevent dismiss when clicking inside */}
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ duration: 0.2 }}
              onClick={(e) => e.stopPropagation()}
              className="bg-white dark:bg-neutral-900 rounded-2xl shadow-xl w-full max-w-md relative max-h-[90vh] overflow-y-auto"
            >
              {/* Header */}
              <div className="sticky top-0 bg-white dark:bg-neutral-900 px-6 pt-6 pb-4 border-b border-gray-100 dark:border-gray-800">
                <button
                  onClick={handleClose}
                  aria-label="Close"
                  className="absolute top-4 left-4 p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors rounded-full hover:bg-gray-100 dark:hover:bg-gray-800"
                >
                  <X className="w-5 h-5" />
                </button>
                <div className="text-center">
                  <h1 className="text-2xl font-bold text-gradient">Yappr</h1>
                  <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">Your decentralized social feed — powered by Dash</p>
                </div>
              </div>

              {/* Form */}
              <form onSubmit={handleSubmit} className="p-6 space-y-5">
                {/* Identity ID / DPNS Input */}
                <div>
                  <label htmlFor="loginIdentityInput" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Dash Username or Identity ID
                  </label>
                  <div className="relative">
                    <input
                      id="loginIdentityInput"
                      type="text"
                      value={identityInput}
                      onChange={(e) => setIdentityInput(e.target.value)}
                      placeholder="e.g., john.dash or 5DbLwAxGBzUzo..."
                      className="w-full px-3 py-2 pr-10 bg-gray-50 dark:bg-gray-950 border border-gray-200 dark:border-gray-800 rounded-lg text-gray-900 dark:text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-yappr-500 focus:border-transparent transition-colors"
                      required
                    />
                    <div className="absolute inset-y-0 right-0 flex items-center pr-3">
                      {isLookingUp && (
                        <Spinner size="sm" className="text-gray-400" />
                      )}
                      {!isLookingUp && resolvedIdentity && (
                        <svg className="h-5 w-5 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                      {!isLookingUp && lookupError && (
                        <svg className="h-5 w-5 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      )}
                    </div>
                  </div>
                  {lookupError && (
                    <p className="mt-1 text-sm text-red-600 dark:text-red-400">{lookupError}</p>
                  )}
                </div>

                {/* Password or Private Key Input */}
                <div>
                  <label htmlFor="loginCredential" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    {hasOnchainBackup ? 'Password or Private Key' : 'Private Key (High or Critical)'}
                  </label>
                  <div className="relative">
                    <input
                      id="loginCredential"
                      type={showCredential ? 'text' : 'password'}
                      value={credential}
                      onChange={(e) => setCredential(e.target.value)}
                      placeholder="Enter your password or private key..."
                      className="w-full px-3 py-2 pr-20 bg-gray-50 dark:bg-gray-950 border border-gray-200 dark:border-gray-800 rounded-lg text-gray-900 dark:text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-yappr-500 focus:border-transparent transition-colors"
                      required
                    />
                    <div className="absolute inset-y-0 right-0 flex items-center pr-3 gap-2">
                      <button
                        type="button"
                        onClick={() => setShowCredential(!showCredential)}
                        className="text-gray-400 hover:text-gray-600"
                        tabIndex={-1}
                      >
                        {showCredential ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                      </button>
                      {detectedCredentialType === 'key' && keyValidationStatus === 'validating' && (
                        <Spinner size="sm" className="text-gray-400" />
                      )}
                      {detectedCredentialType === 'key' && keyValidationStatus === 'valid' && (
                        <svg className="h-5 w-5 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                      {detectedCredentialType === 'key' && keyValidationStatus === 'invalid' && (
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <svg className="h-5 w-5 text-red-500 cursor-help" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                              </svg>
                            </TooltipTrigger>
                            <TooltipContent>
                              {keyValidationResult?.error || 'Invalid private key'}
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      )}
                    </div>
                  </div>
                  {credential && detectedCredentialType && !(detectedCredentialType === 'key' && resolvedIdentity) && (
                    <p className={`mt-1 text-sm ${
                      detectedCredentialType === 'password' && resolvedIdentity && !hasOnchainBackup
                        ? 'text-red-600 dark:text-red-400'
                        : 'text-gray-500 dark:text-gray-400'
                    }`}>
                      {detectedCredentialType === 'key' ? (
                        'Detected as private key - waiting for identity...'
                      ) : !resolvedIdentity ? (
                        credential.length < 16
                          ? `Detected as password (${credential.length}/16 characters) - waiting for identity...`
                          : 'Detected as password - waiting for identity...'
                      ) : hasOnchainBackup ? (
                        credential.length < 16
                          ? `Password must be at least 16 characters (${credential.length}/16)`
                          : 'Will use as backup password'
                      ) : (
                        'No backup found - please enter your private key'
                      )}
                    </p>
                  )}
                  <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                    🔒 Your keys never leave this device. All signing happens locally.
                  </p>
                </div>

                {/* Remember Me Toggle */}
                <div className="flex items-center justify-between">
                  <label htmlFor="loginRememberMe" className="text-sm text-gray-600 dark:text-gray-400">
                    Stay signed in across tabs
                  </label>
                  <button
                    id="loginRememberMe"
                    type="button"
                    role="switch"
                    aria-checked={rememberMe}
                    onClick={() => setRememberMe(!rememberMe)}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-yappr-500 focus:ring-offset-2 ${
                      rememberMe ? 'bg-yappr-500' : 'bg-gray-200 dark:bg-gray-700'
                    }`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                        rememberMe ? 'translate-x-6' : 'translate-x-1'
                      }`}
                    />
                  </button>
                </div>

                {error && (
                  <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-600 rounded-lg p-3">
                    <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
                  </div>
                )}

                <Button
                  type="submit"
                  disabled={!canSubmit}
                  className="w-full shadow-yappr-lg"
                  size="lg"
                >
                  {isLoading ? (
                    <span className="flex items-center justify-center">
                      <Spinner size="sm" className="-ml-1 mr-3 border-white" />
                      Signing in...
                    </span>
                  ) : (
                    'Sign In'
                  )}
                </Button>

                {/* Onboarding Gateway */}
                <div className="mt-4 pt-4 border-t border-gray-100 dark:border-gray-800">
                  <p className="text-sm text-gray-600 dark:text-gray-400 mb-2">
                    Don&apos;t have an identity yet? Create one to start posting on Yappr.
                  </p>
                  <a
                    href="https://bridge.thepasta.org"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center justify-center w-full px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg transition-colors text-sm"
                  >
                    Create Identity
                  </a>
                </div>
              </form>
            </motion.div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
