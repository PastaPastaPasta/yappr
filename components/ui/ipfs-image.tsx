'use client'

import { useState, useCallback, useEffect, useMemo } from 'react'
import { isIpfsProtocol, getAllGatewayUrls } from '@/lib/utils/ipfs-gateway'

interface IpfsImageProps {
  /** The image URL (ipfs:// or http(s)://) */
  src: string
  alt: string
  className?: string
  /** Called when image loads successfully */
  onLoad?: () => void
  /** Called when all gateways fail */
  onError?: () => void
  /** Fallback element to show when all gateways fail */
  fallback?: React.ReactNode
}

/**
 * Image component with IPFS gateway fallback support.
 * Automatically tries multiple gateways if one fails (common for freshly uploaded content).
 */
export function IpfsImage({
  src,
  alt,
  className = '',
  onLoad,
  onError,
  fallback,
}: IpfsImageProps) {
  // Get all gateway URLs for IPFS content, or just use the src directly
  const gatewayUrls = useMemo(() => {
    if (isIpfsProtocol(src)) {
      return getAllGatewayUrls(src)
    }
    return [src]
  }, [src])

  const [currentIndex, setCurrentIndex] = useState(0)
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)

  // Reset state when src changes
  useEffect(() => {
    setCurrentIndex(0)
    setLoaded(false)
    setFailed(false)
  }, [src])

  const handleLoad = useCallback(() => {
    setLoaded(true)
    onLoad?.()
  }, [onLoad])

  const handleError = useCallback(() => {
    // Try next gateway
    if (currentIndex < gatewayUrls.length - 1) {
      setCurrentIndex(prev => prev + 1)
    } else {
      // All gateways failed
      setFailed(true)
      onError?.()
    }
  }, [currentIndex, gatewayUrls.length, onError])

  const currentUrl = gatewayUrls[currentIndex]

  // Show fallback if all gateways failed
  if (failed && fallback) {
    return <>{fallback}</>
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={currentUrl}
      alt={alt}
      className={className}
      onLoad={handleLoad}
      onError={handleError}
      style={{ display: loaded ? undefined : 'none' }}
    />
  )
}
