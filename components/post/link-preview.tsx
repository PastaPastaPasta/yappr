'use client'

import { useState } from 'react'
import Image from 'next/image'
import { LinkIcon } from '@heroicons/react/24/outline'

// Note: We use next/image for favicon (small, fixed size) but regular img
// for preview images so we can check naturalWidth/Height on load

export interface LinkPreviewData {
  url: string
  title?: string
  description?: string
  image?: string
  imageWidth?: number
  imageHeight?: number
  siteName?: string
  favicon?: string
}

interface LinkPreviewProps {
  data: LinkPreviewData
  className?: string
}

// Sanitize URL to prevent XSS via javascript: or other dangerous protocols
function sanitizeUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    // Only allow safe protocols
    if (['http:', 'https:', 'mailto:', 'tel:'].includes(parsed.protocol)) {
      return parsed.href
    }
    return null
  } catch {
    return null
  }
}

// Minimum dimensions for a "useful" preview image
const MIN_IMAGE_SIZE = 200

export function LinkPreview({ data, className = '' }: LinkPreviewProps) {
  const [imageError, setImageError] = useState(false)
  const [imageTooSmall, setImageTooSmall] = useState(() => {
    // Check OG metadata dimensions if available
    if (data.imageWidth && data.imageHeight) {
      return data.imageWidth < MIN_IMAGE_SIZE || data.imageHeight < MIN_IMAGE_SIZE
    }
    return false
  })
  const [faviconError, setFaviconError] = useState(false)

  const safeUrl = sanitizeUrl(data.url)

  // Don't render if URL is invalid/unsafe
  if (!safeUrl) {
    return null
  }

  const hostname = (() => {
    try {
      return new URL(safeUrl).hostname.replace(/^www\./, '')
    } catch {
      return safeUrl
    }
  })()

  // Hide image if error, too small, or dimensions indicate it's not useful
  const showImage = data.image && !imageError && !imageTooSmall
  const hasRichContent = data.title || data.description || data.image

  // Handler to check actual image dimensions after load
  const handleImageLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget
    if (img.naturalWidth < MIN_IMAGE_SIZE || img.naturalHeight < MIN_IMAGE_SIZE) {
      setImageTooSmall(true)
    }
  }

  // Compact horizontal layout with small thumbnail
  return (
    <a
      href={safeUrl}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className={`flex mt-3 border border-neutral-200 dark:border-neutral-700 rounded-xl overflow-hidden hover:bg-neutral-50 dark:hover:bg-neutral-800/50 transition-colors ${className}`}
    >
      {/* Text content */}
      <div className="flex-1 p-3 min-w-0">
        <div className="flex items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-400 mb-1">
          {data.favicon && !faviconError ? (
            <Image
              src={data.favicon}
              alt=""
              width={14}
              height={14}
              className="rounded-sm flex-shrink-0"
              onError={() => setFaviconError(true)}
              unoptimized
            />
          ) : (
            <LinkIcon className="h-3.5 w-3.5 flex-shrink-0" />
          )}
          <span className="truncate">{data.siteName || hostname}</span>
        </div>
        {data.title ? (
          <h4 className="font-medium text-sm text-neutral-900 dark:text-neutral-100 line-clamp-2 mb-0.5">
            {data.title}
          </h4>
        ) : !hasRichContent && (
          <p className="text-sm text-neutral-600 dark:text-neutral-400 truncate">
            {data.url}
          </p>
        )}
        {data.description && (
          <p className="text-xs text-neutral-600 dark:text-neutral-400 line-clamp-2">
            {data.description}
          </p>
        )}
      </div>
      {/* Small thumbnail on the right - use img tag to check naturalWidth/Height */}
      {showImage && (
        <div className="relative w-24 h-24 flex-shrink-0 bg-neutral-100 dark:bg-neutral-800 overflow-hidden">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={data.image}
            alt={data.title || 'Link preview'}
            className="w-full h-full object-cover"
            onError={() => setImageError(true)}
            onLoad={handleImageLoad}
          />
        </div>
      )}
    </a>
  )
}

interface LinkPreviewSkeletonProps {
  className?: string
}

export function LinkPreviewSkeleton({ className = '' }: LinkPreviewSkeletonProps) {
  return (
    <div
      className={`flex mt-3 border border-neutral-200 dark:border-neutral-700 rounded-xl overflow-hidden ${className}`}
    >
      <div className="flex-1 p-3 space-y-2">
        <div className="h-3 w-24 bg-neutral-200 dark:bg-neutral-700 rounded animate-pulse" />
        <div className="h-4 w-3/4 bg-neutral-200 dark:bg-neutral-700 rounded animate-pulse" />
        <div className="h-3 w-full bg-neutral-200 dark:bg-neutral-700 rounded animate-pulse" />
      </div>
      <div className="w-24 h-24 flex-shrink-0 bg-neutral-200 dark:bg-neutral-700 animate-pulse" />
    </div>
  )
}
