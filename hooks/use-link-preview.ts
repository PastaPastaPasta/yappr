'use client'

import { useState, useEffect } from 'react'
import type { LinkPreviewData } from '@/lib/link-preview/types'
import { shouldSkipPreview } from '@/lib/link-preview/urls'
import { getLinkPreview, getCachedPreview } from '@/lib/link-preview/preview'

interface UseLinkPreviewOptions {
  disabled?: boolean
}

interface UseLinkPreviewResult {
  data: LinkPreviewData | null
  loading: boolean
  error: boolean
}

/**
 * Preview metadata for a URL. Serves from the module cache synchronously when
 * it can, otherwise fetches; see lib/link-preview for what a fetch involves.
 */
export function useLinkPreview(url: string | null, options: UseLinkPreviewOptions = {}): UseLinkPreviewResult {
  const { disabled = false } = options
  const inactive = !url || disabled || shouldSkipPreview(url)

  const [data, setData] = useState<LinkPreviewData | null>(() => (inactive ? null : getCachedPreview(url) ?? null))
  const [loading, setLoading] = useState(() => !inactive && getCachedPreview(url) === undefined)
  const [error, setError] = useState(false)

  useEffect(() => {
    setError(false)
    if (inactive) {
      setData(null)
      setLoading(false)
      return
    }
    const cached = getCachedPreview(url)
    if (cached) {
      setData(cached)
      setLoading(false)
      return
    }

    let cancelled = false
    setLoading(true)
    getLinkPreview(url)
      .then((result) => {
        if (cancelled) return
        setData(result)
        setLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setError(true)
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [url, inactive])

  return { data, loading, error }
}
