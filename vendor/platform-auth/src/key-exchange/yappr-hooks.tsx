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
  remainingTime: number | null
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
  remainingTime: number | null
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
  const [remainingTime, setRemainingTime] = useState<number | null>(null)
  const [keyIndex, setKeyIndex] = useState(0)
  const [needsKeyRegistration, setNeedsKeyRegistration] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<YapprKeyExchangeLoginResult | null>(null)

  const abortControllerRef = useRef<AbortController | null>(null)
  const ephemeralKeyRef = useRef<Uint8Array | null>(null)
  const startTimeRef = useRef<number | null>(null)
  const timerIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const lastOptionsRef = useRef<StartYapprKeyExchangeOptions>({})

  const cleanup = useCallback(() => {
    abortControllerRef.current?.abort()
    abortControllerRef.current = null

    if (ephemeralKeyRef.current) {
      clearSensitiveBytes(ephemeralKeyRef.current)
      ephemeralKeyRef.current = null
    }

    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current)
      timerIntervalRef.current = null
    }

    startTimeRef.current = null
  }, [])

  useEffect(() => cleanup, [cleanup])

  const clearResult = useCallback((value: YapprKeyExchangeLoginResult | null) => {
    if (!value) return
    clearSensitiveBytes(value.loginKey)
    clearSensitiveBytes(value.authKey)
    clearSensitiveBytes(value.encryptionKey)
  }, [])

  const start = useCallback(async (startOptions: StartYapprKeyExchangeOptions = {}) => {
    lastOptionsRef.current = startOptions
    cleanup()
    abortControllerRef.current = new AbortController()

    try {
      const resolvedConfig = controller.getYapprKeyExchangeConfig({
        ...options.config,
        label: startOptions.label ?? options.config?.label,
      })

      setState('generating')
      setError(null)
      setResult((previous) => {
        clearResult(previous)
        return null
      })
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
      startTimeRef.current = Date.now()

      timerIntervalRef.current = setInterval(() => {
        if (!startTimeRef.current) {
          return
        }

        const elapsed = Date.now() - startTimeRef.current
        const remaining = Math.max(0, Math.ceil((resolvedConfig.timeoutMs - elapsed) / 1000))
        setRemainingTime(remaining)

        if (remaining === 0 && timerIntervalRef.current) {
          clearInterval(timerIntervalRef.current)
          timerIntervalRef.current = null
        }
      }, 1000)

      const decrypted = await controller.pollYapprKeyExchangeResponse(
        ephemeralPubKeyHash,
        ephemeral.privateKey,
        options.config,
        { signal: abortControllerRef.current.signal },
      )

      if (timerIntervalRef.current) {
        clearInterval(timerIntervalRef.current)
        timerIntervalRef.current = null
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
      if (ephemeralKeyRef.current) {
        clearSensitiveBytes(ephemeralKeyRef.current)
        ephemeralKeyRef.current = null
      }

      if (timerIntervalRef.current) {
        clearInterval(timerIntervalRef.current)
        timerIntervalRef.current = null
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
  }, [cleanup, clearResult, controller, options.config])

  const cancel = useCallback(() => {
    cleanup()
    setResult((previous) => {
      clearResult(previous)
      return null
    })
    setState('idle')
    setUri(null)
    setRemainingTime(null)
    setError(null)
    setNeedsKeyRegistration(false)
  }, [cleanup, clearResult])

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
  const [remainingTime, setRemainingTime] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<YapprKeyRegistrationResult | null>(null)

  const abortControllerRef = useRef<AbortController | null>(null)
  const identityIdRef = useRef<string | null>(null)
  const authKeyRef = useRef<Uint8Array | null>(null)
  const encryptionKeyRef = useRef<Uint8Array | null>(null)
  const startTimeRef = useRef<number | null>(null)
  const timerIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const cancelledRef = useRef(false)

  const cleanupTimers = useCallback(() => {
    abortControllerRef.current?.abort()
    abortControllerRef.current = null

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
    abortControllerRef.current = new AbortController()
    cancelledRef.current = false

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

      if (abortControllerRef.current?.signal.aborted) {
        return
      }

      setUri(buildYapprStateTransitionUri(transition.transitionBytes, resolvedConfig.network))
      setState('waiting')
      startTimeRef.current = Date.now()

      timerIntervalRef.current = setInterval(() => {
        if (!startTimeRef.current) {
          return
        }

        const elapsed = Date.now() - startTimeRef.current
        const remaining = Math.max(0, Math.ceil((DEFAULT_REGISTRATION_TIMEOUT_MS - elapsed) / 1000))
        setRemainingTime(remaining)

        if (remaining === 0) {
          cleanupTimers()
          setError('Request timed out. Please try again.')
          setState('error')
        }
      }, 1000)

      const checkKeys = async (pendingTransition: YapprUnsignedKeyRegistrationResult) => {
        if (!abortControllerRef.current || abortControllerRef.current.signal.aborted) {
          return
        }

        try {
          const keysFound = await controller.checkYapprKeysRegistered(
            identityId,
            authPublicKey,
            encryptionPublicKey,
            options.config,
          )

          if (!abortControllerRef.current || abortControllerRef.current.signal.aborted) {
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

      if (abortControllerRef.current && !abortControllerRef.current.signal.aborted) {
        pollIntervalRef.current = setInterval(() => {
          void checkKeys(transition)
        }, 5000)
      }
    } catch (err) {
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
    setRemainingTime(null)
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
    remainingTime,
    error,
    result,
    start,
    cancel,
    retry,
  }
}
