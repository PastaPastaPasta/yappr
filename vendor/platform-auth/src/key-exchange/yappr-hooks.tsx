import { useCallback, useEffect, useRef, useState } from 'react'
import { PlatformAuthController } from '../core/controller'
import type { YapprKeyExchangeConfig, YapprUnsignedKeyRegistrationResult } from '../core/types'
import {
  buildYapprKeyExchangeUri,
  buildYapprStateTransitionUri,
  clearSensitiveBytes,
  decodeYapprContractId,
  decodeYapprIdentityId,
  deriveYapprAuthKeyFromLogin,
  deriveYapprEncryptionKeyFromLogin,
  generateYapprEphemeralKeyPair,
  getYapprPublicKey,
  hash160,
} from './yappr-protocol'

export type YapprKeyExchangeState =
  | 'idle'
  | 'generating'
  | 'waiting'
  | 'decrypting'
  | 'checking'
  | 'registering'
  | 'complete'
  | 'error'
  | 'timeout'

export interface YapprKeyExchangeLoginResult {
  loginKey: Uint8Array
  authKey: Uint8Array
  encryptionKey: Uint8Array
  keyIndex: number
  needsKeyRegistration: boolean
  identityId: string
}

export interface StartYapprKeyExchangeOptions {
  label?: string
}

export interface UseYapprKeyExchangeLoginReturn {
  state: YapprKeyExchangeState
  uri: string | null
  keyIndex: number
  needsKeyRegistration: boolean
  error: string | null
  result: YapprKeyExchangeLoginResult | null
  start: (options?: StartYapprKeyExchangeOptions) => void
  cancel: () => void
  retry: () => void
}

export type YapprKeyRegistrationState =
  | 'idle'
  | 'building'
  | 'waiting'
  | 'verifying'
  | 'complete'
  | 'error'

export interface YapprKeyRegistrationResult {
  authKeyId: number
  encryptionKeyId: number
}

export interface UseYapprKeyRegistrationReturn {
  state: YapprKeyRegistrationState
  uri: string | null
  error: string | null
  result: YapprKeyRegistrationResult | null
  start: (identityId: string, authKey: Uint8Array, encryptionKey: Uint8Array) => void
  cancel: () => void
  retry: () => void
}

interface UseYapprKeyExchangeOptions {
  config?: Partial<YapprKeyExchangeConfig>
}

const DEFAULT_REGISTRATION_TIMEOUT_MS = 300000

export function useYapprKeyExchangeLogin(
  controller: PlatformAuthController,
  options: UseYapprKeyExchangeOptions = {},
): UseYapprKeyExchangeLoginReturn {
  const [state, setState] = useState<YapprKeyExchangeState>('idle')
  const [uri, setUri] = useState<string | null>(null)
  const [keyIndex, setKeyIndex] = useState(0)
  const [needsKeyRegistration, setNeedsKeyRegistration] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResultState] = useState<YapprKeyExchangeLoginResult | null>(null)

  const abortControllerRef = useRef<AbortController | null>(null)
  const ephemeralKeyRef = useRef<Uint8Array | null>(null)
  const lastOptionsRef = useRef<StartYapprKeyExchangeOptions>({})
  // Mirrors `result` so the unmount cleanup can zero the decrypted keys even
  // though state updaters no longer run once the component is gone.
  const resultRef = useRef<YapprKeyExchangeLoginResult | null>(null)

  const clearResult = useCallback((value: YapprKeyExchangeLoginResult | null) => {
    if (!value) return
    clearSensitiveBytes(value.loginKey)
    clearSensitiveBytes(value.authKey)
    clearSensitiveBytes(value.encryptionKey)
  }, [])

  // Zeroes whatever result is currently held, then stores the new one.
  const setResult = useCallback((value: YapprKeyExchangeLoginResult | null) => {
    if (resultRef.current !== value) {
      clearResult(resultRef.current)
    }
    resultRef.current = value
    setResultState(value)
  }, [clearResult])

  const cleanup = useCallback(() => {
    abortControllerRef.current?.abort()
    abortControllerRef.current = null

    if (ephemeralKeyRef.current) {
      clearSensitiveBytes(ephemeralKeyRef.current)
      ephemeralKeyRef.current = null
    }
  }, [])

  // On unmount: abort any in-flight request and zero decrypted key material,
  // whether or not the caller got around to cancel().
  useEffect(() => () => {
    cleanup()
    clearResult(resultRef.current)
    resultRef.current = null
  }, [cleanup, clearResult])

  const start = useCallback(async (startOptions: StartYapprKeyExchangeOptions = {}) => {
    lastOptionsRef.current = startOptions
    cleanup()
    const runController = new AbortController()
    abortControllerRef.current = runController
    // A later start()/cancel()/unmount supersedes this run by swapping the
    // controller. Once superseded, this run must not touch shared refs or
    // state: they now belong to the newer run (or to nothing, after unmount).
    const isCurrentRun = () => abortControllerRef.current === runController

    try {
      const resolvedConfig = controller.getYapprKeyExchangeConfig({
        ...options.config,
        label: startOptions.label ?? options.config?.label,
      })

      setState('generating')
      setError(null)
      setResult(null)
      setNeedsKeyRegistration(false)

      const contractIdBytes = decodeYapprContractId(resolvedConfig.appContractId)
      const ephemeral = generateYapprEphemeralKeyPair()
      ephemeralKeyRef.current = ephemeral.privateKey

      const ephemeralPubKeyHash = hash160(ephemeral.publicKey)
      setUri(buildYapprKeyExchangeUri({
        appEphemeralPubKey: ephemeral.publicKey,
        contractId: contractIdBytes,
        label: resolvedConfig.label,
      }, resolvedConfig.network))

      setState('waiting')

      const decrypted = await controller.pollYapprKeyExchangeResponse(
        ephemeralPubKeyHash,
        ephemeral.privateKey,
        options.config,
        { signal: runController.signal },
      )

      if (!isCurrentRun()) {
        clearSensitiveBytes(decrypted.loginKey)
        return
      }

      clearSensitiveBytes(ephemeral.privateKey)
      ephemeralKeyRef.current = null

      setState('decrypting')

      const identityId = decrypted.identityId
      setKeyIndex(decrypted.keyIndex)
      const identityIdBytes = decodeYapprIdentityId(identityId)
      const authKey = deriveYapprAuthKeyFromLogin(decrypted.loginKey, identityIdBytes)
      const encryptionKey = deriveYapprEncryptionKeyFromLogin(decrypted.loginKey, identityIdBytes)

      setState('checking')

      const authPublicKey = getYapprPublicKey(authKey)
      const encPublicKey = getYapprPublicKey(encryptionKey)
      const keysExist = await controller.checkYapprKeysRegistered(
        identityId,
        authPublicKey,
        encPublicKey,
        options.config,
      )

      if (!isCurrentRun()) {
        clearSensitiveBytes(decrypted.loginKey)
        clearSensitiveBytes(authKey)
        clearSensitiveBytes(encryptionKey)
        return
      }

      const loginResult: YapprKeyExchangeLoginResult = {
        loginKey: decrypted.loginKey,
        authKey,
        encryptionKey,
        keyIndex: decrypted.keyIndex,
        needsKeyRegistration: !keysExist,
        identityId,
      }

      setResult(loginResult)

      if (loginResult.needsKeyRegistration) {
        setNeedsKeyRegistration(true)
        setState('registering')
        return
      }

      setState('complete')
    } catch (err) {
      // Superseded runs were already cleaned up (key zeroed, timer cleared,
      // state owned by the successor) by the cleanup() that superseded them.
      if (!isCurrentRun()) {
        return
      }

      if (ephemeralKeyRef.current) {
        clearSensitiveBytes(ephemeralKeyRef.current)
        ephemeralKeyRef.current = null
      }

      if (err instanceof Error) {
        if (err.message === 'Cancelled') {
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
  }, [cleanup, setResult, controller, options.config])

  const cancel = useCallback(() => {
    cleanup()
    setResult(null)
    setState('idle')
    setUri(null)
    setError(null)
    setNeedsKeyRegistration(false)
  }, [cleanup, setResult])

  const retry = useCallback(() => {
    start(lastOptionsRef.current)
  }, [start])

  return {
    state,
    uri,
    keyIndex,
    needsKeyRegistration,
    error,
    result,
    start,
    cancel,
    retry,
  }
}

export function useYapprKeyRegistration(
  controller: PlatformAuthController,
  onComplete?: () => void,
  options: UseYapprKeyExchangeOptions = {},
): UseYapprKeyRegistrationReturn {
  const [state, setState] = useState<YapprKeyRegistrationState>('idle')
  const [uri, setUri] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<YapprKeyRegistrationResult | null>(null)

  const abortControllerRef = useRef<AbortController | null>(null)
  const identityIdRef = useRef<string | null>(null)
  const authKeyRef = useRef<Uint8Array | null>(null)
  const encryptionKeyRef = useRef<Uint8Array | null>(null)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const cancelledRef = useRef(false)

  const cleanupTimers = useCallback(() => {
    abortControllerRef.current?.abort()
    abortControllerRef.current = null

    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current)
      pollIntervalRef.current = null
    }
  }, [])

  const cleanup = useCallback(() => {
    cleanupTimers()

    if (authKeyRef.current) {
      clearSensitiveBytes(authKeyRef.current)
      authKeyRef.current = null
    }
    if (encryptionKeyRef.current) {
      clearSensitiveBytes(encryptionKeyRef.current)
      encryptionKeyRef.current = null
    }

    identityIdRef.current = null
  }, [cleanupTimers])

  useEffect(() => cleanup, [cleanup])

  const start = useCallback(async (identityId: string, authKey: Uint8Array, encryptionKey: Uint8Array) => {
    cleanup()

    identityIdRef.current = identityId
    authKeyRef.current = new Uint8Array(authKey)
    encryptionKeyRef.current = new Uint8Array(encryptionKey)
    const runController = new AbortController()
    abortControllerRef.current = runController
    cancelledRef.current = false
    // See useYapprKeyExchangeLogin: a superseded run must leave shared refs
    // and state alone.
    const isCurrentRun = () => abortControllerRef.current === runController

    try {
      const resolvedConfig = controller.getYapprKeyExchangeConfig(options.config)

      setState('building')
      setError(null)
      setResult(null)

      const authPublicKey = getYapprPublicKey(authKey)
      const encryptionPublicKey = getYapprPublicKey(encryptionKey)

      const transition = await controller.buildYapprUnsignedKeyRegistrationTransition({
        identityId,
        authPrivateKey: authKey,
        authPublicKey,
        encryptionPrivateKey: encryptionKey,
        encryptionPublicKey,
      }, options.config)

      if (!isCurrentRun()) {
        return
      }

      setUri(buildYapprStateTransitionUri(transition.transitionBytes, resolvedConfig.network))
      setState('waiting')

      // Silent budget for the wallet to broadcast. When it runs out the caller
      // shows a retry prompt; there is deliberately no visible countdown.
      timeoutRef.current = setTimeout(() => {
        if (!isCurrentRun()) return
        cleanupTimers()
        setError('No response from your wallet yet. Check again to send a fresh request.')
        setState('error')
      }, DEFAULT_REGISTRATION_TIMEOUT_MS)

      const checkKeys = async (pendingTransition: YapprUnsignedKeyRegistrationResult) => {
        if (!isCurrentRun() || runController.signal.aborted) {
          return
        }

        try {
          const keysFound = await controller.checkYapprKeysRegistered(
            identityId,
            authPublicKey,
            encryptionPublicKey,
            options.config,
          )

          if (!isCurrentRun() || runController.signal.aborted) {
            return
          }

          if (!keysFound) {
            return
          }

          cleanup()
          setState('verifying')
          await new Promise((resolve) => setTimeout(resolve, 500))

          if (cancelledRef.current) {
            return
          }

          setResult({
            authKeyId: pendingTransition.authKeyId,
            encryptionKeyId: pendingTransition.encryptionKeyId,
          })
          setState('complete')
          onComplete?.()
        } catch {
          // Keep polling on transient failures to preserve current Yappr behavior.
        }
      }

      await checkKeys(transition)

      if (isCurrentRun() && !runController.signal.aborted) {
        pollIntervalRef.current = setInterval(() => {
          void checkKeys(transition)
        }, 5000)
      }
    } catch (err) {
      if (!isCurrentRun()) {
        return
      }

      cleanupTimers()

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
  }, [cleanup, cleanupTimers, controller, onComplete, options.config])

  const cancel = useCallback(() => {
    cancelledRef.current = true
    cleanup()
    setState('idle')
    setUri(null)
    setError(null)
    setResult(null)
  }, [cleanup])

  const retry = useCallback(() => {
    const identityId = identityIdRef.current
    const authKey = authKeyRef.current
    const encryptionKey = encryptionKeyRef.current

    if (identityId && authKey && encryptionKey) {
      start(identityId, new Uint8Array(authKey), new Uint8Array(encryptionKey))
    }
  }, [start])

  return {
    state,
    uri,
    error,
    result,
    start,
    cancel,
    retry,
  }
}
