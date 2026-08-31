'use client'

import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { isIpfsProtocol, getAllGatewayUrls } from '@/lib/utils/ipfs-gateway'
import { getLocalImageUrl } from '@/lib/upload/local-image-cache'

interface IpfsImageProps {
  /** The image URL (ipfs:// or http(s)://) */
  src: string
  alt: string
  className?: string
  /** Called when image loads successfully */
  onLoad?: () => void
  /** Called when all gateways fail (after retries are exhausted) */
  onError?: () => void
  /** Fallback element to show when all gateways fail */
  fallback?: React.ReactNode
  /** Element to show while the image is still loading (or between retry rounds) */
  loadingFallback?: React.ReactNode
}

/**
 * Delays between retry rounds after every gateway has failed once.
 * Freshly uploaded content often takes a little while to propagate to public
 * gateways, so a failed cycle is retried before giving up. Kept short so
 * genuinely dead CIDs (deleted pins, stale references) still reach their
 * fallback within ~20s instead of churning requests indefinitely.
 */
const RETRY_DELAYS_MS = [5_000, 15_000]

/** Cache-bust retry rounds so the browser re-requests instead of replaying a cached gateway error. */
function withRetryParam(url: string, round: number): string {
  if (round === 0 || !/^https?:/i.test(url)) return url
  return `${url}${url.includes('?') ? '&' : '?'}r=${round}`
}

/**
 * Image component with IPFS gateway fallback support.
 * Resolution order:
 * 1. Local object URL for content uploaded in this session (instant)
 * 2. Each configured gateway in turn
 * 3. Retry the gateway cycle with backoff (fresh content still propagating)
 */
export function IpfsImage({
  src,
  alt,
  className = '',
  onLoad,
  onError,
  fallback,
  loadingFallback,
}: IpfsImageProps) {
  // Get all candidate URLs: local preview first (if we uploaded this content
  // in the current session), then gateway URLs.
  const candidateUrls = useMemo(() => {
    if (isIpfsProtocol(src)) {
      const localUrl = getLocalImageUrl(src)
      const gatewayUrls = getAllGatewayUrls(src)
      return localUrl ? [localUrl, ...gatewayUrls] : gatewayUrls
    }
    return [src]
  }, [src])

  const [currentIndex, setCurrentIndex] = useState(0)
  const [retryRound, setRetryRound] = useState(0)
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // State resets after the render in which src changes, so clamp against the
  // new candidate list to avoid indexing past its end for that one render.
  const safeIndex = Math.min(currentIndex, candidateUrls.length - 1)

  // Reset state when src changes; cleanup also cancels any pending retry.
  useEffect(() => {
    setCurrentIndex(0)
    setRetryRound(0)
    setLoaded(false)
    setFailed(false)
    return () => {
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current)
        retryTimerRef.current = null
      }
    }
  }, [src])

  const handleLoad = useCallback(() => {
    setLoaded(true)
    onLoad?.()
  }, [onLoad])

  const handleError = useCallback(() => {
    if (safeIndex < candidateUrls.length - 1) {
      // Try next candidate URL
      setCurrentIndex(safeIndex + 1)
    } else if (retryRound < RETRY_DELAYS_MS.length) {
      // All candidates failed this round — content may still be propagating.
      // Wait, then restart the gateway cycle.
      retryTimerRef.current = setTimeout(() => {
        setCurrentIndex(0)
        setRetryRound(prev => prev + 1)
      }, RETRY_DELAYS_MS[retryRound])
    } else {
      // All gateways failed after every retry round
      setFailed(true)
      onError?.()
    }
  }, [safeIndex, candidateUrls.length, retryRound, onError])

  // Show fallback if all gateways failed
  if (failed) {
    return <>{fallback}</>
  }

  return (
    <>
      {!loaded && loadingFallback}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={withRetryParam(candidateUrls[safeIndex], retryRound)}
        alt={alt}
        className={className}
        onLoad={handleLoad}
        onError={handleError}
        style={{ display: loaded ? undefined : 'none' }}
      />
    </>
  )
}
