'use client'

import { useState, useEffect, useCallback } from 'react'
import { cryptoPriceService } from '@/lib/services/crypto-price-service'

export interface UseCryptoPriceResult {
  cryptoAmount: number | null
  cryptoPrice: number | null
  priceSources: string[]
  isLoading: boolean
  error: string | null
  refetch: () => void
}

/**
 * Hook to convert fiat amount to crypto using averaged prices from multiple APIs
 *
 * @param fiatAmount - The amount in fiat currency (e.g., 25.99)
 * @param fiatCurrency - The fiat currency code (e.g., 'USD')
 * @param scheme - The crypto payment scheme (e.g., 'dash:', 'bitcoin:')
 */
export function useCryptoPrice(
  fiatAmount: number | undefined | null,
  fiatCurrency: string | undefined | null,
  scheme: string | undefined | null
): UseCryptoPriceResult {
  const [cryptoAmount, setCryptoAmount] = useState<number | null>(null)
  const [cryptoPrice, setCryptoPrice] = useState<number | null>(null)
  const [priceSources, setPriceSources] = useState<string[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fetchTrigger, setFetchTrigger] = useState(0)
  const [skipCache, setSkipCache] = useState(false)

  const refetch = useCallback(() => {
    setSkipCache(true)
    setFetchTrigger((prev) => prev + 1)
  }, [])

  useEffect(() => {
    // Reset state if inputs are invalid
    if (!fiatAmount || !fiatCurrency || !scheme || fiatAmount <= 0) {
      setCryptoAmount(null)
      setCryptoPrice(null)
      setPriceSources([])
      setError(null)
      setIsLoading(false)
      return
    }

    // Check if scheme is supported
    if (!cryptoPriceService.isSchemeSupported(scheme)) {
      setCryptoAmount(null)
      setCryptoPrice(null)
      setPriceSources([])
      setError('Unsupported cryptocurrency')
      setIsLoading(false)
      return
    }

    let cancelled = false

    const fetchPrice = async () => {
      setIsLoading(true)
      setError(null)

      try {
        const result = await cryptoPriceService.convertToCrypto(fiatAmount, fiatCurrency, scheme, skipCache)

        if (cancelled) return

        if (result) {
          setCryptoAmount(result.cryptoAmount)
          setCryptoPrice(result.price)
          setPriceSources(result.sources)
          setError(null)
        } else {
          setCryptoAmount(null)
          setCryptoPrice(null)
          setPriceSources([])
          setError('Price unavailable')
        }
      } catch (err) {
        if (cancelled) return
        setCryptoAmount(null)
        setCryptoPrice(null)
        setPriceSources([])
        setError(err instanceof Error ? err.message : 'Failed to fetch price')
      } finally {
        if (!cancelled) {
          setIsLoading(false)
          setSkipCache(false)
        }
      }
    }

    fetchPrice().catch(() => {
      // Error already handled in try/catch
    })

    return () => {
      cancelled = true
    }
  }, [fiatAmount, fiatCurrency, scheme, fetchTrigger, skipCache])

  return {
    cryptoAmount,
    cryptoPrice,
    priceSources,
    isLoading,
    error,
    refetch,
  }
}
