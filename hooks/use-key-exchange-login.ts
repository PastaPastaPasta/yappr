'use client'

import { useState, useCallback, useRef, useEffect } from 'react'
import { YAPPR_CONTRACT_ID } from '@/lib/constants'
import {
  generateEphemeralKeyPair,
  deriveAuthKeyFromLogin,
  deriveEncryptionKeyFromLogin,
  clearKeyMaterial,
  getPublicKey
} from '@/lib/crypto/key-exchange'
import {
  buildKeyExchangeUri,
  decodeIdentityId,
  decodeContractId,
  type NetworkType
} from '@/lib/crypto/key-exchange-uri'
import { keyExchangeService } from '@/lib/services/key-exchange-service'

/**
 * Login flow state machine states.
 *
 * Spec section 11.1 - Login Flow State Machine:
 *   idle → generating → waiting → decrypting → checking → registering → complete | error | timeout
 */
export type KeyExchangeState =
  | 'idle'
  | 'generating'    // Generating ephemeral keypair and URI
  | 'waiting'       // Polling for response, showing QR
  | 'decrypting'    // Response received, decrypting
  | 'checking'      // Checking if keys exist on identity
  | 'registering'   // First login - keys need to be registered
  | 'complete'      // Login successful
  | 'error'         // Error occurred
  | 'timeout'       // Timeout waiting for response

/**
 * Result of a successful key exchange login
 */
export interface KeyExchangeLoginResult {
  /** The 32-byte login key */
  loginKey: Uint8Array
  /** The derived 32-byte auth key */
  authKey: Uint8Array
  /** The derived 32-byte encryption key */
  encryptionKey: Uint8Array
  /** The key derivation index */
  keyIndex: number
  /** Whether keys need to be registered on identity */
  needsKeyRegistration: boolean
}

/**
 * Hook return value
 */
export interface UseKeyExchangeLoginReturn {
  /** Current state of the login flow */
  state: KeyExchangeState
  /** The dash-key: URI for QR code display (only when state === 'waiting') */
  uri: string | null
  /** Remaining time in seconds until timeout (only when state === 'waiting') */
  remainingTime: number | null
  /** The key index being used */
  keyIndex: number
  /** Whether keys need to be registered on identity (only when state === 'registering') */
  needsKeyRegistration: boolean
  /** Error message if state === 'error' */
  error: string | null
  /** The login result (only when state === 'complete' or 'registering') */
  result: KeyExchangeLoginResult | null
  /** Start the login flow */
  start: (identityId: string, options?: StartOptions) => void
  /** Cancel the current login attempt */
  cancel: () => void
  /** Retry after timeout or error */
  retry: () => void
}

/**
 * Options for starting the login flow
 */
export interface StartOptions {
  /** Force a specific key index (for rotation) */
  forceKeyIndex?: number
  /** Display label for the wallet UI */
  label?: string
}

// Default polling configuration
const DEFAULT_POLL_INTERVAL_MS = 3000
const DEFAULT_TIMEOUT_MS = 120000

/**
 * React hook for the key exchange login flow.
 *
 * Implements the full login flow state machine including:
 * - Generating ephemeral keypair and QR code URI
 * - Polling for wallet response
 * - Decrypting login key via ECDH
 * - Deriving auth/encryption keys
 * - Checking if keys exist on identity
 *
 * @param network - The network to use (testnet, mainnet, devnet)
 * @returns Hook state and control methods
 */
export function useKeyExchangeLogin(
  network: NetworkType = 'testnet'
): UseKeyExchangeLoginReturn {
  // State
  const [state, setState] = useState<KeyExchangeState>('idle')
  const [uri, setUri] = useState<string | null>(null)
  const [remainingTime, setRemainingTime] = useState<number | null>(null)
  const [keyIndex, setKeyIndex] = useState(0)
  const [needsKeyRegistration, setNeedsKeyRegistration] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<KeyExchangeLoginResult | null>(null)

  // Refs for cleanup
  const abortControllerRef = useRef<AbortController | null>(null)
  const ephemeralKeyRef = useRef<Uint8Array | null>(null)
  const identityIdRef = useRef<string | null>(null)
  const startTimeRef = useRef<number | null>(null)
  const timerIntervalRef = useRef<NodeJS.Timeout | null>(null)

  // Cleanup function
  const cleanup = useCallback(() => {
    // Abort any pending operations
    abortControllerRef.current?.abort()
    abortControllerRef.current = null

    // Clear ephemeral key
    if (ephemeralKeyRef.current) {
      clearKeyMaterial(ephemeralKeyRef.current)
      ephemeralKeyRef.current = null
    }

    // Clear timer
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current)
      timerIntervalRef.current = null
    }

    startTimeRef.current = null
  }, [])

  // Cleanup on unmount
  useEffect(() => {
    return cleanup
  }, [cleanup])

  /**
   * Start the login flow for an identity.
   */
  const start = useCallback(async (identityId: string, options: StartOptions = {}) => {
    const { forceKeyIndex, label = 'Login to Yappr' } = options

    // Clean up any previous attempt
    cleanup()

    // Set up new abort controller
    abortControllerRef.current = new AbortController()
    identityIdRef.current = identityId

    try {
      // Phase 1: Generate ephemeral keypair and URI
      setState('generating')
      setError(null)
      setResult(null)
      setNeedsKeyRegistration(false)

      // Decode contract ID
      const contractIdBytes = decodeContractId(YAPPR_CONTRACT_ID)

      // Check for existing response to get current key index
      let currentKeyIndex = 0
      try {
        currentKeyIndex = await keyExchangeService.getCurrentKeyIndex(identityId, contractIdBytes)
      } catch {
        // No existing response - use 0
      }

      // Determine key index to use
      const targetKeyIndex = forceKeyIndex ?? currentKeyIndex
      setKeyIndex(targetKeyIndex)

      // Generate ephemeral keypair
      const ephemeral = generateEphemeralKeyPair()
      ephemeralKeyRef.current = ephemeral.privateKey

      // Build URI
      const keyExchangeUri = buildKeyExchangeUri({
        appEphemeralPubKey: ephemeral.publicKey,
        contractId: contractIdBytes,
        keyIndex: targetKeyIndex,
        label
      }, network)

      setUri(keyExchangeUri)

      // Phase 2: Wait for response
      setState('waiting')
      startTimeRef.current = Date.now()

      // Start countdown timer
      timerIntervalRef.current = setInterval(() => {
        if (startTimeRef.current) {
          const elapsed = Date.now() - startTimeRef.current
          const remaining = Math.max(0, Math.ceil((DEFAULT_TIMEOUT_MS - elapsed) / 1000))
          setRemainingTime(remaining)

          if (remaining === 0 && timerIntervalRef.current) {
            clearInterval(timerIntervalRef.current)
            timerIntervalRef.current = null
          }
        }
      }, 1000)

      // Poll for response
      const decrypted = await keyExchangeService.pollForResponse(
        identityId,
        contractIdBytes,
        ephemeral.privateKey,
        {
          pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
          timeoutMs: DEFAULT_TIMEOUT_MS,
          signal: abortControllerRef.current.signal
        }
      )

      // Clear timer
      if (timerIntervalRef.current) {
        clearInterval(timerIntervalRef.current)
        timerIntervalRef.current = null
      }

      // Clear ephemeral key immediately after successful decryption
      clearKeyMaterial(ephemeral.privateKey)
      ephemeralKeyRef.current = null

      // Phase 3: Decrypt (already done in polling)
      setState('decrypting')

      // Decode identity ID for key derivation
      const identityIdBytes = decodeIdentityId(identityId)

      // Derive auth and encryption keys
      const authKey = deriveAuthKeyFromLogin(decrypted.loginKey, identityIdBytes)
      const encryptionKey = deriveEncryptionKeyFromLogin(decrypted.loginKey, identityIdBytes)

      // Phase 4: Check if keys exist on identity
      setState('checking')

      const authPublicKey = getPublicKey(authKey)
      const encPublicKey = getPublicKey(encryptionKey)

      // Check identity for these keys
      const { identityService } = await import('@/lib/services/identity-service')
      const identity = await identityService.getIdentity(identityId)

      if (!identity) {
        throw new Error('Identity not found')
      }

      // Check if auth key exists (purpose=0, type=0)
      const authKeyExists = identity.publicKeys.some(key => {
        if (key.purpose !== 0 || key.type !== 0 || key.disabledAt) return false

        // Compare public keys
        let keyData: Uint8Array
        if (key.data instanceof Uint8Array) {
          keyData = key.data
        } else if (typeof key.data === 'string') {
          // Base64 or hex
          if (/^[0-9a-fA-F]+$/.test(key.data)) {
            keyData = new Uint8Array(key.data.length / 2)
            for (let i = 0; i < keyData.length; i++) {
              keyData[i] = parseInt(key.data.substr(i * 2, 2), 16)
            }
          } else {
            const binary = atob(key.data)
            keyData = new Uint8Array(binary.length)
            for (let i = 0; i < binary.length; i++) {
              keyData[i] = binary.charCodeAt(i)
            }
          }
        } else {
          return false
        }

        return keyData.length === authPublicKey.length &&
          keyData.every((b, i) => b === authPublicKey[i])
      })

      // Check if encryption key exists (purpose=1, type=0)
      const encKeyExists = identity.publicKeys.some(key => {
        if (key.purpose !== 1 || key.type !== 0 || key.disabledAt) return false

        let keyData: Uint8Array
        if (key.data instanceof Uint8Array) {
          keyData = key.data
        } else if (typeof key.data === 'string') {
          if (/^[0-9a-fA-F]+$/.test(key.data)) {
            keyData = new Uint8Array(key.data.length / 2)
            for (let i = 0; i < keyData.length; i++) {
              keyData[i] = parseInt(key.data.substr(i * 2, 2), 16)
            }
          } else {
            const binary = atob(key.data)
            keyData = new Uint8Array(binary.length)
            for (let i = 0; i < binary.length; i++) {
              keyData[i] = binary.charCodeAt(i)
            }
          }
        } else {
          return false
        }

        return keyData.length === encPublicKey.length &&
          keyData.every((b, i) => b === encPublicKey[i])
      })

      // Build result
      const loginResult: KeyExchangeLoginResult = {
        loginKey: decrypted.loginKey,
        authKey,
        encryptionKey,
        keyIndex: decrypted.keyIndex,
        needsKeyRegistration: !authKeyExists || !encKeyExists
      }

      setResult(loginResult)

      // Determine final state
      if (loginResult.needsKeyRegistration) {
        setNeedsKeyRegistration(true)
        setState('registering')
      } else {
        setState('complete')
      }

    } catch (err) {
      // Clear ephemeral key on error
      if (ephemeralKeyRef.current) {
        clearKeyMaterial(ephemeralKeyRef.current)
        ephemeralKeyRef.current = null
      }

      // Clear timer
      if (timerIntervalRef.current) {
        clearInterval(timerIntervalRef.current)
        timerIntervalRef.current = null
      }

      if (err instanceof Error) {
        if (err.message === 'Cancelled') {
          // User cancelled - return to idle
          setState('idle')
          return
        }
        if (err.message.includes('Timeout')) {
          setState('timeout')
          setError('Timed out waiting for wallet response')
          return
        }
        setError(err.message)
      } else {
        setError('An unexpected error occurred')
      }
      setState('error')
    }
  }, [network, cleanup])

  /**
   * Cancel the current login attempt.
   */
  const cancel = useCallback(() => {
    cleanup()
    setState('idle')
    setUri(null)
    setRemainingTime(null)
    setError(null)
    setResult(null)
    setNeedsKeyRegistration(false)
  }, [cleanup])

  /**
   * Retry after timeout or error.
   */
  const retry = useCallback(() => {
    const identityId = identityIdRef.current
    if (identityId) {
      start(identityId, { forceKeyIndex: keyIndex })
    }
  }, [start, keyIndex])

  return {
    state,
    uri,
    remainingTime,
    keyIndex,
    needsKeyRegistration,
    error,
    result,
    start,
    cancel,
    retry
  }
}
