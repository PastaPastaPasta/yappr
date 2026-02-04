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
import { hash160 } from '@/lib/crypto/hash'
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
 * idle -> generating -> waiting -> decrypting -> checking -> registering -> complete | error | timeout
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
  /** The identity ID discovered from the response document's $ownerId */
  identityId: string
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
  start: (options?: StartOptions) => void
  /** Cancel the current login attempt */
  cancel: () => void
  /** Retry after timeout or error */
  retry: () => void
}

/**
 * Options for starting the login flow
 */
export interface StartOptions {
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
 * - Computing hash160(ephemeralPubKey) for polling
 * - Polling for wallet response by ephemeral key hash
 * - Decrypting login key via ECDH
 * - Discovering identity from response $ownerId
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
  const startTimeRef = useRef<number | null>(null)
  const timerIntervalRef = useRef<NodeJS.Timeout | null>(null)
  const lastOptionsRef = useRef<StartOptions>({})

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
   * Start the login flow.
   */
  const start = useCallback(async (options: StartOptions = {}) => {
    const { label = 'Login to Yappr' } = options
    lastOptionsRef.current = options

    // Clean up any previous attempt
    cleanup()

    // Set up new abort controller
    abortControllerRef.current = new AbortController()

    try {
      // Phase 1: Generate ephemeral keypair and URI
      setState('generating')
      setError(null)
      setResult(null)
      setNeedsKeyRegistration(false)

      // Decode contract ID
      const contractIdBytes = decodeContractId(YAPPR_CONTRACT_ID)

      // Generate ephemeral keypair
      const ephemeral = generateEphemeralKeyPair()
      ephemeralKeyRef.current = ephemeral.privateKey

      // Compute hash160 of ephemeral public key for polling
      const ephemeralPubKeyHash = hash160(ephemeral.publicKey)

      // Build URI for QR code
      const keyExchangeUri = buildKeyExchangeUri({
        appEphemeralPubKey: ephemeral.publicKey,
        contractId: contractIdBytes,
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

      // Poll for response by ephemeral key hash
      const decrypted = await keyExchangeService.pollForResponse(
        contractIdBytes,
        ephemeralPubKeyHash,
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

      // Identity discovered from response $ownerId
      const identityId = decrypted.identityId
      setKeyIndex(decrypted.keyIndex)

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

      // Compute hash160 of public keys for ECDSA_HASH160 comparison
      const authHash = hash160(authPublicKey)
      const encHash = hash160(encPublicKey)

      // Check if auth key exists (purpose=0, type=2/ECDSA_HASH160)
      const authKeyExists = identity.publicKeys.some(key => {
        if (key.purpose !== 0 || key.type !== 2 || key.disabledAt) return false

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

        return keyData.length === authHash.length &&
          keyData.every((b, i) => b === authHash[i])
      })

      // Check if encryption key exists (purpose=1, type=2/ECDSA_HASH160)
      const encKeyExists = identity.publicKeys.some(key => {
        if (key.purpose !== 1 || key.type !== 2 || key.disabledAt) return false

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

        return keyData.length === encHash.length &&
          keyData.every((b, i) => b === encHash[i])
      })

      // Build result
      const loginResult: KeyExchangeLoginResult = {
        loginKey: decrypted.loginKey,
        authKey,
        encryptionKey,
        keyIndex: decrypted.keyIndex,
        needsKeyRegistration: !authKeyExists || !encKeyExists,
        identityId
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
    start(lastOptionsRef.current)
  }, [start])

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
