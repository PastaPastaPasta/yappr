'use client'

import { useState, useCallback, useRef, useEffect } from 'react'
import { getPublicKey } from '@/lib/crypto/key-exchange'
import { buildStateTransitionUri } from '@/lib/crypto/state-transition-uri'
import { decodeIdentityId, type NetworkType } from '@/lib/crypto/key-exchange-uri'
import {
  buildUnsignedKeyRegistrationTransition,
  checkKeysRegistered
} from '@/lib/services/identity-update-builder'

/**
 * Key registration flow state machine states.
 *
 * idle → building → waiting → verifying → complete | error
 */
export type KeyRegistrationState =
  | 'idle'
  | 'building'   // Building unsigned state transition
  | 'waiting'    // Showing QR, polling for keys
  | 'verifying'  // Keys found, final verification
  | 'complete'   // Keys successfully registered
  | 'error'      // Error occurred

/**
 * Result of a successful key registration
 */
export interface KeyRegistrationResult {
  /** The auth key ID that was registered */
  authKeyId: number
  /** The encryption key ID that was registered */
  encryptionKeyId: number
}

/**
 * Hook return value
 */
export interface UseKeyRegistrationReturn {
  /** Current state of the registration flow */
  state: KeyRegistrationState
  /** The dash-st: URI for QR code display (only when state === 'waiting') */
  uri: string | null
  /** Remaining time in seconds until timeout (only when state === 'waiting') */
  remainingTime: number | null
  /** Error message if state === 'error' */
  error: string | null
  /** The registration result (only when state === 'complete') */
  result: KeyRegistrationResult | null
  /** Start the registration flow */
  start: (identityId: string, authKey: Uint8Array, encryptionKey: Uint8Array) => void
  /** Cancel the current registration attempt */
  cancel: () => void
  /** Retry after error */
  retry: () => void
}

// Default configuration
const DEFAULT_POLL_INTERVAL_MS = 5000  // Check every 5 seconds
const DEFAULT_TIMEOUT_MS = 300000      // 5 minute timeout for signing

/**
 * React hook for the key registration flow.
 *
 * Implements the state machine for registering auth/encryption keys:
 * - Builds unsigned IdentityUpdateTransition
 * - Generates dash-st: URI for QR code
 * - Polls identity for new keys
 * - Calls onComplete when keys are found
 *
 * @param network - The network to use (testnet, mainnet, devnet)
 * @param onComplete - Callback when registration completes successfully
 * @returns Hook state and control methods
 */
export function useKeyRegistration(
  network: NetworkType = 'testnet',
  onComplete?: () => void
): UseKeyRegistrationReturn {
  // State
  const [state, setState] = useState<KeyRegistrationState>('idle')
  const [uri, setUri] = useState<string | null>(null)
  const [remainingTime, setRemainingTime] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<KeyRegistrationResult | null>(null)

  // Refs for cleanup and retry
  const abortControllerRef = useRef<AbortController | null>(null)
  const identityIdRef = useRef<string | null>(null)
  const authKeyRef = useRef<Uint8Array | null>(null)
  const encryptionKeyRef = useRef<Uint8Array | null>(null)
  const startTimeRef = useRef<number | null>(null)
  const timerIntervalRef = useRef<NodeJS.Timeout | null>(null)
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null)

  // Cleanup function
  const cleanup = useCallback(() => {
    // Abort any pending operations
    abortControllerRef.current?.abort()
    abortControllerRef.current = null

    // Clear timers
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current)
      timerIntervalRef.current = null
    }
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current)
      pollIntervalRef.current = null
    }

    startTimeRef.current = null
  }, [])

  // Cleanup on unmount
  useEffect(() => {
    return cleanup
  }, [cleanup])

  /**
   * Start the key registration flow.
   *
   * @param identityId - The identity to register keys for
   * @param authKey - The auth private key (32 bytes)
   * @param encryptionKey - The encryption private key (32 bytes)
   */
  const start = useCallback(async (
    identityId: string,
    authKey: Uint8Array,
    encryptionKey: Uint8Array
  ) => {
    // Clean up any previous attempt
    cleanup()

    // Store for retry
    identityIdRef.current = identityId
    authKeyRef.current = authKey
    encryptionKeyRef.current = encryptionKey

    // Set up new abort controller
    abortControllerRef.current = new AbortController()

    try {
      // Phase 1: Build unsigned transition
      setState('building')
      setError(null)
      setResult(null)

      // Get public keys from private keys
      const authPublicKey = getPublicKey(authKey)
      const encryptionPublicKey = getPublicKey(encryptionKey)

      console.log('KeyRegistration: Building unsigned transition for', identityId)

      // Build the unsigned state transition
      const transition = await buildUnsignedKeyRegistrationTransition({
        identityId,
        authPublicKey,
        encryptionPublicKey
      })

      // Check for cancellation
      if (abortControllerRef.current?.signal.aborted) {
        return
      }

      console.log('KeyRegistration: Transition built, bytes:', transition.transitionBytes.length)

      // Build the dash-st: URI
      const stUri = buildStateTransitionUri(
        transition.transitionBytes,
        'identityUpdate',
        network
      )

      setUri(stUri)
      console.log('KeyRegistration: URI generated')

      // Phase 2: Wait for keys to be registered
      setState('waiting')
      startTimeRef.current = Date.now()

      // Start countdown timer
      timerIntervalRef.current = setInterval(() => {
        if (startTimeRef.current) {
          const elapsed = Date.now() - startTimeRef.current
          const remaining = Math.max(0, Math.ceil((DEFAULT_TIMEOUT_MS - elapsed) / 1000))
          setRemainingTime(remaining)

          if (remaining === 0) {
            // Timeout
            cleanup()
            setError('Request timed out. Please try again.')
            setState('error')
          }
        }
      }, 1000)

      // Start polling for key registration
      const checkKeys = async () => {
        if (abortControllerRef.current?.signal.aborted) {
          return
        }

        try {
          console.log('KeyRegistration: Polling for keys...')
          const keysFound = await checkKeysRegistered(
            identityId,
            authPublicKey,
            encryptionPublicKey
          )

          if (keysFound) {
            console.log('KeyRegistration: Keys found!')
            cleanup()

            setState('verifying')

            // Brief delay for UI feedback
            await new Promise(resolve => setTimeout(resolve, 500))

            setResult({
              authKeyId: transition.authKeyId,
              encryptionKeyId: transition.encryptionKeyId
            })
            setState('complete')

            // Call completion callback
            onComplete?.()
          }
        } catch (pollError) {
          console.warn('KeyRegistration: Poll error:', pollError)
          // Continue polling on error
        }
      }

      // Initial check
      await checkKeys()

      // Set up polling interval
      pollIntervalRef.current = setInterval(checkKeys, DEFAULT_POLL_INTERVAL_MS)

    } catch (err) {
      cleanup()

      if (err instanceof Error) {
        if (err.message === 'Cancelled') {
          setState('idle')
          return
        }
        setError(err.message)
      } else {
        setError('An unexpected error occurred')
      }
      setState('error')
    }
  }, [network, cleanup, onComplete])

  /**
   * Cancel the current registration attempt.
   */
  const cancel = useCallback(() => {
    cleanup()
    setState('idle')
    setUri(null)
    setRemainingTime(null)
    setError(null)
    setResult(null)
  }, [cleanup])

  /**
   * Retry after error.
   */
  const retry = useCallback(() => {
    const identityId = identityIdRef.current
    const authKey = authKeyRef.current
    const encryptionKey = encryptionKeyRef.current

    if (identityId && authKey && encryptionKey) {
      start(identityId, authKey, encryptionKey)
    }
  }, [start])

  return {
    state,
    uri,
    remainingTime,
    error,
    result,
    start,
    cancel,
    retry
  }
}
