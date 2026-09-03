'use client'

import { logger } from '@/lib/logger'
import { scopedKey } from '@/lib/storage-scope'
import { useState, useEffect, useRef } from 'react'
import { motion } from 'framer-motion'
import { Eye, EyeOff, KeyRound } from 'lucide-react'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useAuth } from '@/contexts/auth-context'
import { Button } from '@/components/ui/button'
import { identityService } from '@/lib/services/identity-service'
import { dpnsService } from '@/lib/services/dpns-service'
import { keyValidationService, type KeyValidationResult } from '@/lib/services/key-validation-service'
import { encryptedKeyService } from '@/lib/services/encrypted-key-service'
import { authVaultService } from '@/lib/services/auth-vault-service'
import { isLikelyWif } from '@/lib/crypto/wif'
import { useKeyBackupModal } from '@/hooks/use-key-backup-modal'
import { getPasskeyPrfSupport } from '@/lib/webauthn/passkey-support'

// Check if input looks like an Identity ID (base58, ~44 chars)
function isLikelyIdentityId(input: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{42,46}$/.test(input)
}

interface ResolvedIdentity {
  id: string
  dpnsUsername?: string
}

type CredentialType = 'key' | 'password' | null

/** Green tick shown once a field's value has been checked against the identity. */
function VerifiedIcon({ label }: { label: string }) {
  return (
    <svg className="h-5 w-5 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-label={label}>
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
    </svg>
  )
}

/** Red cross that reveals the reason a field was rejected on hover or focus. */
function RejectedIcon({ message }: { message: string }) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button" aria-label={message} className="flex items-center text-red-500 cursor-help">
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </TooltipTrigger>
        <TooltipContent>{message}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

/** Combines the browser-support caveat with the "no passkey enrolled" note. */
function passkeyHintFor(disabledForIdentity: boolean, supportMessage: string | null): string | null {
  if (!disabledForIdentity) return supportMessage
  const notEnrolled = 'No passkey is enrolled for this identity yet.'
  return supportMessage ? `${supportMessage} ${notEnrolled}` : notEnrolled
}

/** Border colour of the credential field: error beats in-flight beats resting. */
function credentialBorderClass(hasError: boolean, isSubmitting: boolean): string {
  if (hasError) return 'border-red-400 dark:border-red-500'
  if (isSubmitting) return 'border-yappr-400 dark:border-yappr-500'
  return 'border-gray-200 dark:border-gray-800'
}

interface KeyLoginFormProps {
  /** Called once a session has been established. */
  onComplete: () => void
}

/**
 * The advanced sign-in form: a Dash username or identity ID plus either a
 * vault password or a raw private key. Wallet and passkey sign-in are the
 * primary paths; this form exists for identities that have no wallet or
 * passkey enrolled, and for developers.
 */
export function KeyLoginForm({ onComplete }: KeyLoginFormProps) {
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
  const [hasPasskeyAccess, setHasPasskeyAccess] = useState(false)
  const [passkeySupportMessage, setPasskeySupportMessage] = useState<string | null>(null)

  // Key validation states
  const [keyValidationStatus, setKeyValidationStatus] = useState<'idle' | 'validating' | 'valid' | 'invalid'>('idle')
  const [keyValidationResult, setKeyValidationResult] = useState<KeyValidationResult | null>(null)

  // Form states
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isShaking, setIsShaking] = useState(false)

  const shakeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const setErrorWithShake = (msg: string | null) => {
    setError(msg)
    if (msg) {
      if (shakeTimerRef.current) clearTimeout(shakeTimerRef.current)
      setIsShaking(true)
      shakeTimerRef.current = setTimeout(() => setIsShaking(false), 500)
    }
  }

  useEffect(() => {
    return () => {
      if (shakeTimerRef.current) clearTimeout(shakeTimerRef.current)
    }
  }, [])

  const { login, loginWithPassword, loginWithPasskey } = useAuth()
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
      setHasPasskeyAccess(false)
      setPasskeySupportMessage(null)
      setKeyValidationStatus('idle')
      setKeyValidationResult(null)

      try {
        const trimmedInput = identityInput.trim()
        const inputIsIdentityId = isLikelyIdentityId(trimmedInput)
        let identityId = trimmedInput

        if (!inputIsIdentityId) {
          const resolved = await dpnsService.resolveIdentity(identityId)
          if (!resolved) {
            setLookupError('Username not found')
            return
          }
          identityId = resolved
        }

        const identity = await identityService.getIdentity(identityId)
        if (!identity) {
          setLookupError('Identity not found')
          return
        }

        let dpnsUsername: string | undefined
        if (inputIsIdentityId) {
          dpnsUsername = await dpnsService.resolveUsername(identityId) || undefined
        } else {
          dpnsUsername = trimmedInput.toLowerCase().replace(/\.dash$/, '') + '.dash'
        }

        setResolvedIdentity({ id: identity.id, dpnsUsername })

        // Check unified auth vault first.
        try {
          if (authVaultService.isConfigured()) {
            const status = await authVaultService.getStatus(identityId)
            setHasOnchainBackup(status.hasPasswordAccess)
            setHasPasskeyAccess(status.passkeyCount > 0)

            if (status.passkeyCount > 0) {
              const support = await getPasskeyPrfSupport()
              if (!support.likelyPrfCapable && support.blockedReason) {
                setPasskeySupportMessage(support.blockedReason)
              } else if (support.platformHint === 'apple') {
                setPasskeySupportMessage('Platform passkeys are preferred here. External security-key PRF may not work on iPhone or iPad.')
              } else {
                setPasskeySupportMessage(null)
              }
            }

            if (status.hasPasswordAccess || status.passkeyCount > 0) {
              return
            }
          }
        } catch (err) {
          logger.error('Auth vault lookup failed during login identity resolution:', err)
          if (authVaultService.isConfigured()) {
            setHasOnchainBackup(false)
            return
          }
        }

        // Check legacy vault contract next.
        try {
          const { vaultService } = await import('@/lib/services/vault-service')
          if (vaultService.isConfigured()) {
            const hasVaultBackup = await vaultService.hasPasswordBackup(identityId)
            if (hasVaultBackup) {
              setHasOnchainBackup(true)
              return
            }
          }
        } catch {
          // Vault check failed — continue to legacy fallback
        }
        try {
          if (encryptedKeyService.isConfigured()) {
            const hasBackup = await encryptedKeyService.hasBackup(identityId)
            setHasOnchainBackup(hasBackup)
          } else {
            setHasOnchainBackup(false)
          }
        } catch {
          setHasOnchainBackup(false)
        }
      } catch (err) {
        logger.error('Identity lookup error:', err)
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
        logger.error('Key validation error:', err)
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
          setErrorWithShake('Private key does not match this identity')
          setIsLoading(false)
          return
        }

        await login(identityId, credential)

        if (!sessionStorage.getItem(scopedKey('yappr_backup_prompt_shown'))) {
          let unifiedStatus = null
          let authVaultUnavailable = false

          if (authVaultService.isConfigured()) {
            try {
              unifiedStatus = await authVaultService.getStatus(identityId)
            } catch (statusError) {
              logger.error('Auth vault status lookup failed after key login:', statusError)
              authVaultUnavailable = true
            }
          }

          const hasBackup = authVaultUnavailable
            ? false
            : unifiedStatus
              ? (unifiedStatus.hasPasswordAccess || unifiedStatus.passkeyCount > 0)
              : (encryptedKeyService.isConfigured() ? await encryptedKeyService.hasBackup(identityId) : false)
          if (!authVaultUnavailable && !hasBackup) {
            sessionStorage.setItem(scopedKey('yappr_backup_prompt_shown'), 'true')
            openBackupModal(identityId, resolvedIdentity.dpnsUsername || '', false)
          }
        }
      } else {
        const username = resolvedIdentity.dpnsUsername || identityInput
        await loginWithPassword(username, credential)
      }

      onComplete()
    } catch (err) {
      setErrorWithShake(err instanceof Error ? err.message : 'Failed to login')
    } finally {
      setIsLoading(false)
    }
  }

  const handlePasskeySignIn = async () => {
    setError(null)
    setIsLoading(true)

    try {
      const passkeyLoginTarget = identityInput.trim() || undefined
      await loginWithPasskey(passkeyLoginTarget)
      onComplete()
    } catch (err) {
      setErrorWithShake(err instanceof Error ? err.message : 'Failed to login with passkey')
    } finally {
      setIsLoading(false)
    }
  }

  const canSubmit = (() => {
    if (!resolvedIdentity || isLoading || !credential) return false

    switch (detectedCredentialType) {
      case 'key':
        return keyValidationStatus === 'valid'
      case 'password':
        return hasOnchainBackup && credential.length >= 16
      default:
        return false
    }
  })()

  const passkeyDisabledForIdentity = Boolean(resolvedIdentity && !hasPasskeyAccess)
  const passkeyHint = passkeyHintFor(passkeyDisabledForIdentity, passkeySupportMessage)

  const inputClass = 'w-full px-3 py-2 bg-gray-50 dark:bg-gray-950 border rounded-lg text-gray-900 dark:text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-yappr-500 focus:border-transparent transition-colors'

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {/* Identity ID / DPNS Input */}
      <div>
        <label htmlFor="loginIdentityInput" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          Dash username or identity ID
        </label>
        <div className="relative">
          <input
            id="loginIdentityInput"
            type="text"
            value={identityInput}
            onChange={(e) => setIdentityInput(e.target.value)}
            placeholder="john.dash or 5DbLwAxGBzUzo…"
            autoComplete="username"
            spellCheck={false}
            className={`${inputClass} pr-10 border-gray-200 dark:border-gray-800`}
            required
          />
          <div className="absolute inset-y-0 right-0 flex items-center pr-3">
            {isLookingUp && (
              <Spinner size="sm" className="text-gray-400" />
            )}
            {!isLookingUp && resolvedIdentity && <VerifiedIcon label="Identity found" />}
            {!isLookingUp && lookupError && <RejectedIcon message={lookupError} />}
          </div>
        </div>
      </div>

      {/* Password or Private Key Input */}
      <div>
        <label htmlFor="loginCredential" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          {hasOnchainBackup ? 'Password or private key' : 'Private key (high or critical)'}
        </label>
        <motion.div
          className="relative"
          animate={isShaking ? { x: [0, -8, 8, -5, 5, -2, 2, 0] } : { x: 0 }}
          transition={{ duration: 0.4 }}
        >
          <input
            id="loginCredential"
            type={showCredential ? 'text' : 'password'}
            value={credential}
            onChange={(e) => setCredential(e.target.value)}
            placeholder={hasOnchainBackup ? 'Your vault password or a WIF key' : 'A WIF private key for this identity'}
            autoComplete="current-password"
            className={`${inputClass} pr-20 ${credentialBorderClass(Boolean(error), isLoading)}`}
            required
          />
          <div className="absolute inset-y-0 right-0 flex items-center pr-3 gap-2">
            {isLoading && <Spinner size="sm" className="text-yappr-400" />}
            {!isLoading && detectedCredentialType === 'key' && (
              <>
                {keyValidationStatus === 'validating' && <Spinner size="sm" className="text-gray-400" />}
                {keyValidationStatus === 'valid' && <VerifiedIcon label="Key matches this identity" />}
                {keyValidationStatus === 'invalid' && (
                  <RejectedIcon message={keyValidationResult?.error || 'Invalid private key'} />
                )}
              </>
            )}
            <button
              type="button"
              onClick={() => setShowCredential(!showCredential)}
              aria-label={showCredential ? 'Hide credential' : 'Show credential'}
              className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
              tabIndex={-1}
            >
              {showCredential ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
            </button>
          </div>
        </motion.div>
        <p
          className={`mt-2 text-xs transition-colors ${error ? 'text-red-500 dark:text-red-400' : 'text-gray-500 dark:text-gray-400'}`}
          aria-live="polite"
        >
          {error ?? 'Your key stays on this device. Every signature happens locally.'}
        </p>
      </div>

      <Button
        type="submit"
        disabled={!canSubmit}
        className="w-full shadow-yappr-lg"
        size="lg"
      >
        {isLoading ? (
          <span className="flex items-center justify-center">
            <Spinner size="sm" className="-ml-1 mr-3 border-white" />
            Signing in
          </span>
        ) : (
          'Sign In'
        )}
      </Button>

      <Button
        type="button"
        variant="outline"
        disabled={isLoading || passkeyDisabledForIdentity}
        className="w-full"
        size="lg"
        onClick={handlePasskeySignIn}
      >
        <KeyRound className="w-4 h-4 mr-2" />
        Use a passkey for this identity
      </Button>

      {passkeyHint && (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {passkeyHint}
        </p>
      )}
    </form>
  )
}
