'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import {
  waitForUtxo,
  isDashScheme,
  getNetworkFromScheme,
  satoshisToDash,
  type WaitForUtxoResult
} from '@/lib/services/insight-api-service'
import { INSIGHT_API_CONFIG } from '@/lib/constants'

export type WatcherStatus = 'idle' | 'watching' | 'detected' | 'timeout' | 'error'

interface UseDashTransactionWatcherOptions {
  enabled?: boolean
  scheme?: string
  address?: string
  onDetected?: (txid: string, amountDash: number) => void
  onTimeout?: () => void
}

interface UseDashTransactionWatcherResult {
  status: WatcherStatus
  detectedTxid: string | null
  detectedAmount: number | null
  remainingTime: number
  elapsedTime: number
  retry: () => void
  stop: () => void
}

export function useDashTransactionWatcher({
  enabled = true,
  scheme,
  address,
  onDetected,
  onTimeout
}: UseDashTransactionWatcherOptions): UseDashTransactionWatcherResult {
  const [status, setStatus] = useState<WatcherStatus>('idle')
  const [detectedTxid, setDetectedTxid] = useState<string | null>(null)
  const [detectedAmount, setDetectedAmount] = useState<number | null>(null)
  const [remainingTime, setRemainingTime] = useState<number>(INSIGHT_API_CONFIG.timeoutMs)
  const [elapsedTime, setElapsedTime] = useState<number>(0)

  const abortControllerRef = useRef<AbortController | null>(null)
  const watchCountRef = useRef(0)

  const startWatching = useCallback(() => {
    if (!scheme || !address || !isDashScheme(scheme)) {
      return
    }

    // Cancel any existing watcher
    abortControllerRef.current?.abort()
    abortControllerRef.current = new AbortController()

    const watchId = ++watchCountRef.current

    setStatus('watching')
    setDetectedTxid(null)
    setDetectedAmount(null)
    setRemainingTime(INSIGHT_API_CONFIG.timeoutMs)
    setElapsedTime(0)

    const network = getNetworkFromScheme(scheme)

    waitForUtxo(address, {
      network,
      signal: abortControllerRef.current.signal,
      onProgress: (elapsed, remaining) => {
        // Only update if this is still the current watcher
        if (watchCountRef.current === watchId) {
          setElapsedTime(elapsed)
          setRemainingTime(remaining)
        }
      }
    }).then((result: WaitForUtxoResult) => {
      // Only process if this is still the current watcher
      if (watchCountRef.current !== watchId) return

      if (result.success && result.utxo) {
        const amountDash = satoshisToDash(result.utxo.satoshis)
        setDetectedTxid(result.utxo.txid)
        setDetectedAmount(amountDash)
        setStatus('detected')
        onDetected?.(result.utxo.txid, amountDash)
      } else if (result.timedOut) {
        setStatus('timeout')
        onTimeout?.()
      } else if (result.error) {
        setStatus('error')
      }
    })
  }, [scheme, address, onDetected, onTimeout])

  const stop = useCallback(() => {
    abortControllerRef.current?.abort()
    abortControllerRef.current = null
    watchCountRef.current++
    setStatus('idle')
  }, [])

  const retry = useCallback(() => {
    startWatching()
  }, [startWatching])

  // Start watching when enabled and we have a valid Dash address
  useEffect(() => {
    if (enabled && scheme && address && isDashScheme(scheme)) {
      startWatching()
    } else {
      stop()
    }

    return () => {
      abortControllerRef.current?.abort()
    }
  }, [enabled, scheme, address, startWatching, stop])

  return {
    status,
    detectedTxid,
    detectedAmount,
    remainingTime,
    elapsedTime,
    retry,
    stop
  }
}
