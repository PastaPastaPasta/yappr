'use client'

import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { getAllGatewayUrls } from '@/lib/utils/ipfs-gateway'
import { getLocalImageUrl } from '@/lib/upload/local-image-cache'
import { imageSourceFor, type ProxyImageSize } from '@/lib/media/remote-media'

interface IpfsImageProps {
  /** The image URL as stored: ipfs://, an https URL, or an inline data:/blob: URL */
  src: string
  /** How large the proxy should serve a non-IPFS https image (default 'full') */
  size?: ProxyImageSize
  alt: string
  className?: string
  /** Called when the image loads, with the candidate URL that served it and the element */
  onLoad?: (loadedUrl: string, image: HTMLImageElement) => void
  /** Called when the image cannot be shown: every source failed, or it may not be loaded at all */
  onError?: () => void
  /** Shown instead when the image cannot be shown */
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

/** Cache-bust gateway retry rounds so the browser re-requests instead of replaying a cached gateway error. */
function withRetryParam(url: string, round: number): string {
  if (round === 0 || !/^https?:/i.test(url)) return url
  return `${url}${url.includes('?') ? '&' : '?'}r=${round}`
}

/**
 * Where an image may be loaded from (lib/media/remote-media): IPFS through
 * the gateways, any other https image through the image proxy, inline and
 * same-origin images as they are. Denied, plain-http and unknown URLs have
 * no candidates, and `retries` is only true for IPFS (propagation delays).
 */
function imageCandidates(src: string, size: ProxyImageSize): { urls: string[]; retries: boolean } {
  const source = imageSourceFor(src, size)
  switch (source.kind) {
    case 'ipfs': {
      // Content uploaded in this session first (instant), then each gateway.
      const localUrl = getLocalImageUrl(source.ipfsUrl)
      const gatewayUrls = getAllGatewayUrls(source.ipfsUrl)
      return { urls: localUrl ? [localUrl, ...gatewayUrls] : gatewayUrls, retries: true }
    }
    case 'proxied':
    case 'local':
      return { urls: [source.url], retries: false }
    default:
      return { urls: [], retries: false }
  }
}

/**
 * The one way the app shows a stored image URL (any scheme, not only IPFS).
 * Resolution order:
 * 1. Local object URL for content uploaded in this session (instant)
 * 2. Each configured gateway in turn (IPFS), or the image proxy (other https)
 * 3. Retry the gateway cycle with backoff (fresh IPFS content still propagating)
 * Anything that cannot or may not be shown renders `fallback`.
 */
export function IpfsImage({
  src,
  size = 'full',
  alt,
  className = '',
  onLoad,
  onError,
  fallback,
  loadingFallback,
}: IpfsImageProps) {
  const { urls: candidateUrls, retries } = useMemo(() => imageCandidates(src, size), [src, size])

  const [currentIndex, setCurrentIndex] = useState(0)
  const [retryRound, setRetryRound] = useState(0)
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // State resets after the render in which src changes, so clamp against the
  // new candidate list to avoid indexing past its end for that one render.
  const safeIndex = Math.max(0, Math.min(currentIndex, candidateUrls.length - 1))
  const unavailable = candidateUrls.length === 0

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

  const handleLoad = useCallback((event: React.SyntheticEvent<HTMLImageElement>) => {
    setLoaded(true)
    onLoad?.(candidateUrls[safeIndex], event.currentTarget)
  }, [onLoad, candidateUrls, safeIndex])

  const handleError = useCallback(() => {
    if (safeIndex < candidateUrls.length - 1) {
      // Try next candidate URL
      setCurrentIndex(safeIndex + 1)
    } else if (retries && retryRound < RETRY_DELAYS_MS.length) {
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
  }, [safeIndex, candidateUrls.length, retries, retryRound, onError])

  // Nothing loadable: report it once per src, as a failed load would be.
  // Through a ref, so a caller's inline callback doesn't re-fire it.
  const onErrorRef = useRef(onError)
  useEffect(() => {
    onErrorRef.current = onError
  })
  useEffect(() => {
    if (unavailable) onErrorRef.current?.()
  }, [unavailable, src])

  if (failed || unavailable) {
    return <>{fallback}</>
  }

  return (
    <>
      {!loaded && loadingFallback}
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
