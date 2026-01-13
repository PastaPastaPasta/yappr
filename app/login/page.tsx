'use client'

import { useState, useEffect } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { Button } from '@/components/ui/button'
import { useRouter } from 'next/navigation'
import { identityService } from '@/lib/services/identity-service'
import { dpnsService } from '@/lib/services/dpns-service'
import { keyValidationService, type KeyValidationResult } from '@/lib/services/key-validation-service'
import { encryptedKeyService } from '@/lib/services/encrypted-key-service'
import { isLikelyWif } from '@/lib/crypto/wif'
import { useKeyBackupModal } from '@/hooks/use-key-backup-modal'
import { Loader2, Eye, EyeOff } from 'lucide-react'

// Check if input looks like an Identity ID (base58, ~44 chars)
function isLikelyIdentityId(input: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{42,46}$/.test(input)
}

interface ResolvedIdentity {
  id: string
  balance: number
  publicKeys: any[]
  dpnsUsername?: string
}

type CredentialType = 'key' | 'password' | null

export default function LoginPage() {
  // Identity lookup states
  const [identityInput, setIdentityInput] = useState('')
  const [isLookingUp, setIsLookingUp] = useState(false)
  const [lookupError, setLookupError] = useState<string | null>(null)
  const [resolvedIdentity, setResolvedIdentity] = useState<ResolvedIdentity | null>(null)

  // Unified credential field (password OR private key)
  const [credential, setCredential] = useState('')
  const [showCredential, setShowCredential] = useState(false)
  const [detectedCredentialType, setDetectedCredentialType] = useState<CredentialType>(null)
  const [hasOnchainBackup, setHasOnchainBackup] = useState<boolean | null>(null) // null = not checked yet

  // Key validation states (only used when credential is detected as a key)
  const [keyValidationStatus, setKeyValidationStatus] = useState<'idle' | 'validating' | 'valid' | 'invalid'>('idle')
  const [keyValidationResult, setKeyValidationResult] = useState<KeyValidationResult | null>(null)

  // Form states
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [rememberMe, setRememberMe] = useState(true)

  const { login, loginWithPassword } = useAuth()
  const router = useRouter()
  const openBackupModal = useKeyBackupModal((state) => state.open)

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
      // Reset key validation when identity changes
      setKeyValidationStatus('idle')
      setKeyValidationResult(null)

      try {
        let identityId = identityInput.trim()

        // Check if input looks like a DPNS name
        if (!isLikelyIdentityId(identityId)) {
          // Resolve DPNS to identity ID
          const resolved = await dpnsService.resolveIdentity(identityId)
          if (!resolved) {
            setLookupError('Username not found')
            setIsLookingUp(false)
            return
          }
          identityId = resolved
        }

        // Fetch identity details
        const identity = await identityService.getIdentity(identityId)
        if (!identity) {
          setLookupError('Identity not found')
          setIsLookingUp(false)
          return
        }

        // Resolve DPNS username for display (if we entered an ID)
        let dpnsUsername: string | undefined
        if (isLikelyIdentityId(identityInput.trim())) {
          dpnsUsername = await dpnsService.resolveUsername(identityId) || undefined
        } else {
          // We entered a DPNS name, use it
          dpnsUsername = identityInput.trim().toLowerCase().replace(/\.dash$/, '') + '.dash'
        }

        setResolvedIdentity({
          id: identity.id,
          balance: identity.balance,
          publicKeys: identity.publicKeys,
          dpnsUsername
        })

        // Check for on-chain backup (don't block on this)
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

    // Detect credential type based on format (even without resolved identity)
    const isKey = isLikelyWif(credential)
    setDetectedCredentialType(isKey ? 'key' : 'password')

    // Only validate keys if we have a resolved identity
    if (!isKey) {
      setKeyValidationStatus('idle')
      setKeyValidationResult(null)
      return
    }

    // Wait for identity to be resolved before validating key
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
    setError(null)
    setIsLoading(true)

    try {
      const identityId = resolvedIdentity?.id || identityInput

      if (detectedCredentialType === 'key') {
        // Key-based login
        if (keyValidationStatus !== 'valid') {
          setError('Private key does not match this identity')
          setIsLoading(false)
          return
        }

        await login(identityId, credential, { rememberMe })

        // Prompt for on-chain backup if none exists (and not already prompted this session)
        if (encryptedKeyService.isConfigured() && !sessionStorage.getItem('yappr_backup_prompt_shown')) {
          const hasBackup = await encryptedKeyService.hasBackup(identityId)
          if (!hasBackup) {
            sessionStorage.setItem('yappr_backup_prompt_shown', 'true')
            openBackupModal(identityId, resolvedIdentity?.dpnsUsername || '', credential, false)
          }
        }
      } else {
        // Password-based login
        const username = resolvedIdentity?.dpnsUsername || identityInput
        await loginWithPassword(username, credential, rememberMe)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to login')
    } finally {
      setIsLoading(false)
    }
  }

  // Submit button enabled based on credential type
  const canSubmit = (() => {
    if (!resolvedIdentity || isLoading || !credential) return false

    if (detectedCredentialType === 'key') {
      return keyValidationStatus === 'valid'
    } else if (detectedCredentialType === 'password') {
      // Only allow password login if there's an on-chain backup
      return hasOnchainBackup && credential.length >= 16
    }

    return false
  })()

  return (
    <div className="min-h-screen bg-white dark:bg-neutral-900 flex items-center justify-center px-4">
      <div className="max-w-md w-full space-y-8">
        <div className="text-center">
          <h1 className="text-4xl font-bold text-gradient mb-2">Yappr</h1>
          <p className="text-gray-600 dark:text-gray-400">Sign in with your Dash Platform identity</p>
        </div>

        {/* Unified Login Form */}
        <form onSubmit={handleSubmit} className="mt-8 space-y-6">
          <div className="space-y-4">
            {/* Identity ID / DPNS Input */}
            <div>
              <label htmlFor="identityInput" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Identity ID or DPNS Username
              </label>
              <div className="relative">
                <input
                  id="identityInput"
                  type="text"
                  value={identityInput}
                  onChange={(e) => setIdentityInput(e.target.value)}
                  placeholder="e.g., john.dash or 5DbLwAxGBzUzo81VewMUwn4b5P4bpv9FNFybi25XB5Bk"
                  className="w-full px-3 py-2 pr-10 bg-gray-50 dark:bg-gray-950 border border-gray-200 dark:border-gray-800 rounded-lg text-gray-900 dark:text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-yappr-500 focus:border-transparent transition-colors"
                  required
                />
                {/* Status indicator */}
                <div className="absolute inset-y-0 right-0 flex items-center pr-3">
                  {isLookingUp && (
                    <svg className="animate-spin h-5 w-5 text-gray-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
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

              {/* Identity lookup error */}
              {lookupError && (
                <p className="mt-1 text-sm text-red-600 dark:text-red-400">{lookupError}</p>
              )}
            </div>

            {/* Password or Private Key Input */}
            <div>
              <label htmlFor="credential" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                {hasOnchainBackup ? 'Password or Private Key' : 'Private Key (High or Critical)'}
              </label>
              <div className="relative">
                <input
                  id="credential"
                  type={showCredential ? 'text' : 'password'}
                  value={credential}
                  onChange={(e) => setCredential(e.target.value)}
                  placeholder="Enter your password or private key..."
                  className="w-full px-3 py-2 pr-20 bg-gray-50 dark:bg-gray-950 border border-gray-200 dark:border-gray-800 rounded-lg text-gray-900 dark:text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-yappr-500 focus:border-transparent transition-colors"
                  required
                />
                {/* Eye toggle and status indicator */}
                <div className="absolute inset-y-0 right-0 flex items-center pr-3 gap-2">
                  {/* Show/hide toggle */}
                  <button
                    type="button"
                    onClick={() => setShowCredential(!showCredential)}
                    className="text-gray-400 hover:text-gray-600"
                    tabIndex={-1}
                  >
                    {showCredential ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                  </button>
                  {/* Validation status for keys */}
                  {detectedCredentialType === 'key' && keyValidationStatus === 'validating' && (
                    <svg className="animate-spin h-5 w-5 text-gray-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                  )}
                  {detectedCredentialType === 'key' && keyValidationStatus === 'valid' && (
                    <svg className="h-5 w-5 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                  {detectedCredentialType === 'key' && keyValidationStatus === 'invalid' && (
                    <svg className="h-5 w-5 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  )}
                </div>
              </div>

              {/* Dynamic helper text based on detected credential type */}
              {credential && detectedCredentialType && (
                <p className={`mt-1 text-sm ${
                  (detectedCredentialType === 'key' && keyValidationStatus === 'invalid') ||
                  (detectedCredentialType === 'password' && resolvedIdentity && !hasOnchainBackup)
                    ? 'text-red-600 dark:text-red-400'
                    : 'text-gray-500 dark:text-gray-400'
                }`}>
                  {detectedCredentialType === 'key' ? (
                    !resolvedIdentity
                      ? 'Detected as private key - waiting for identity...'
                      : keyValidationStatus === 'valid'
                      ? 'Valid private key for this identity'
                      : keyValidationStatus === 'validating'
                      ? 'Validating key...'
                      : keyValidationStatus === 'invalid' && keyValidationResult?.error
                      ? keyValidationResult.error
                      : 'Detected as private key'
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
            </div>

            {/* Remember Me Toggle */}
            <div className="flex items-center justify-between">
              <label htmlFor="rememberMe" className="text-sm text-gray-600 dark:text-gray-400">
                Stay signed in across tabs
              </label>
              <button
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
          </div>

          {error && (
            <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-600 rounded-lg p-3">
              <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
            </div>
          )}

          <div className="space-y-3">
            <Button
              type="submit"
              disabled={!canSubmit}
              className="w-full shadow-yappr-lg"
              size="lg"
            >
              {isLoading ? (
                <span className="flex items-center justify-center">
                  <svg className="animate-spin -ml-1 mr-3 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                  Signing in...
                </span>
              ) : (
                'Sign In'
              )}
            </Button>
          </div>
        </form>

        <div className="mt-8 space-y-4 text-sm text-gray-600 dark:text-gray-400">
          {/* Need an Identity Section */}
          <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
            <h3 className="font-medium text-blue-900 dark:text-blue-100 mb-2">Need an Identity?</h3>
            <p className="text-blue-700 dark:text-blue-300 mb-3">
              Get test credits and create your Dash Platform identity:
            </p>
            <div className="flex flex-col sm:flex-row gap-2">
              <a
                href="https://faucet.thepasta.org"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center justify-center px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors"
              >
                <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                Faucet
              </a>
              <a
                href="https://bridge.thepasta.org"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center justify-center px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg transition-colors"
              >
                <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                </svg>
                Bridge
              </a>
            </div>
          </div>

          <div className="bg-gray-50 dark:bg-gray-950 border border-gray-200 dark:border-gray-800 rounded-lg p-4 space-y-2">
            <h3 className="font-medium text-gray-900 dark:text-gray-100">Sign in with:</h3>
            <ul className="list-disc list-inside space-y-1">
              <li>Backup password (if you set one up)</li>
              <li>High or Critical authentication key (WIF format)</li>
            </ul>
          </div>

          <div className="bg-gray-50 dark:bg-gray-950 border border-gray-200 dark:border-gray-800 rounded-lg p-4 space-y-2">
            <h3 className="font-medium text-gray-900 dark:text-gray-100">Security Notice:</h3>
            <p>Your private key is only used locally to sign transactions. It is never sent to any server.</p>
          </div>
        </div>
      </div>
    </div>
  )
}
