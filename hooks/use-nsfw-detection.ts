'use client'

import { useState, useEffect } from 'react'
import { useSettingsStore } from '@/lib/store'
import {
  nsfwDetectionService,
  type NsfwPrediction,
} from '@/lib/services/nsfw-service'

interface NsfwDetectionResult {
  isNsfw: boolean
  isLoading: boolean
  predictions: NsfwPrediction | null
  error: string | null
}

export function useNsfwDetection(
  imageUrl: string | undefined
): NsfwDetectionResult {
  const nsfwFilterEnabled = useSettingsStore((s) => s.nsfwFilterEnabled)
  const nsfwSensitivity = useSettingsStore((s) => s.nsfwSensitivity)

  const [isNsfw, setIsNsfw] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [predictions, setPredictions] = useState<NsfwPrediction | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!nsfwFilterEnabled || !imageUrl) {
      setIsNsfw(false)
      setIsLoading(false)
      setPredictions(null)
      setError(null)
      return
    }

    let cancelled = false
    setIsLoading(true)
    setError(null)

    nsfwDetectionService
      .classify(imageUrl)
      .then((preds) => {
        if (cancelled) return
        const result = nsfwDetectionService.evaluateResult(
          preds,
          nsfwSensitivity
        )
        setPredictions(preds)
        setIsNsfw(result.isNsfw)
        setIsLoading(false)
      })
      .catch((err: Error) => {
        if (cancelled) return
        setError(err.message)
        setIsNsfw(false)
        setIsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [imageUrl, nsfwFilterEnabled, nsfwSensitivity])

  return { isNsfw, isLoading, predictions, error }
}
