'use client'

import { useState } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { LinkIcon, SparklesIcon, PlayIcon } from '@heroicons/react/24/solid'
import { useSettingsStore } from '@/lib/store'
import { CORS_PROXY_INFO, isDirectImageUrl, isYouTubeUrl } from '@/hooks/use-link-preview'

// YouTube brand icon SVG
function YouTubeIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor">
      <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
    </svg>
  )
}

/**
 * Prompt shown when link previews are disabled but a URL exists
 * Allows users to enable link previews with privacy disclosure
 */
export function LinkPreviewEnablePrompt() {
  const [showEnableHint, setShowEnableHint] = useState(false)
  const setLinkPreviews = useSettingsStore((s) => s.setLinkPreviews)

  const handleEnablePreviews = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setLinkPreviews(true)
  }

  return (
    <div className="mt-3">
      {showEnableHint ? (
        <div className="p-3 bg-neutral-100 dark:bg-neutral-800 rounded-lg border border-neutral-200 dark:border-neutral-700 space-y-2">
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            {CORS_PROXY_INFO.warning}
          </p>
          <div className="flex items-center gap-3">
            <button
              onClick={handleEnablePreviews}
              className="px-3 py-1.5 bg-yappr-500 hover:bg-yappr-600 text-white text-sm font-medium rounded-md transition-colors"
            >
              Enable link previews
            </button>
            <button
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setShowEnableHint(false)
              }}
              className="text-sm text-neutral-500 hover:text-neutral-600 dark:hover:text-neutral-400"
            >
              Cancel
            </button>
          </div>
          <p className="text-neutral-500 text-xs">
            Uses:{' '}
            {CORS_PROXY_INFO.proxies.map((p, i) => (
              <span key={p.name}>
                {i > 0 && ', '}
                <a
                  href={p.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:text-neutral-600"
                  onClick={(e) => e.stopPropagation()}
                >
                  {p.name}
                </a>
              </span>
            ))}
          </p>
          <p className="text-neutral-500 text-xs">
            You can change this anytime in{' '}
            <Link
              href="/settings"
              className="underline hover:text-neutral-600"
              onClick={(e) => e.stopPropagation()}
            >
              Settings
            </Link>
          </p>
        </div>
      ) : (
        <button
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            setShowEnableHint(true)
          }}
          className="flex items-center gap-1.5 px-3 py-2 text-sm text-yappr-500 dark:text-yappr-400 bg-yappr-50 dark:bg-yappr-900/20 hover:bg-yappr-100 dark:hover:bg-yappr-900/30 border border-yappr-200 dark:border-yappr-800 rounded-lg transition-colors"
        >
          <SparklesIcon className="h-4 w-4" />
          <span className="font-medium">Enable link previews</span>
        </button>
      )}
    </div>
  )
}

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
  /** True if URL points directly to an image (detected via Content-Type or extension) */
  isDirectImage?: boolean
  /** YouTube video ID for embedded player (when URL is a YouTube video) */
  youtubeVideoId?: string
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
  // YouTube player state
  const [isPlaying, setIsPlaying] = useState(false)
  const [thumbnailUrl, setThumbnailUrl] = useState(() =>
    data.youtubeVideoId
      ? `https://img.youtube.com/vi/${data.youtubeVideoId}/maxresdefault.jpg`
      : ''
  )

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

  // Check if URL points directly to an image (via Content-Type detection or file extension)
  const isDirectImage = data.isDirectImage || isDirectImageUrl(data.url)

  // Handler to check actual image dimensions after load
  const handleImageLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget
    if (img.naturalWidth < MIN_IMAGE_SIZE || img.naturalHeight < MIN_IMAGE_SIZE) {
      setImageTooSmall(true)
    }
  }

  // YouTube video preview with click-to-play embedded player
  if (data.youtubeVideoId) {
    return (
      <div className={`mt-3 ${className}`}>
        <div className="border border-neutral-200 dark:border-neutral-700 rounded-xl overflow-hidden">
          {!isPlaying ? (
            <button
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setIsPlaying(true)
              }}
              className="relative w-full aspect-video bg-black cursor-pointer group"
            >
              {/* Thumbnail */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={thumbnailUrl}
                alt="YouTube video thumbnail"
                className="w-full h-full object-cover"
                onError={() => {
                  // Fallback from maxresdefault to hqdefault if maxres doesn't exist
                  if (thumbnailUrl.includes('maxresdefault')) {
                    setThumbnailUrl(
                      `https://img.youtube.com/vi/${data.youtubeVideoId}/hqdefault.jpg`
                    )
                  }
                }}
              />
              {/* Play button overlay */}
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="w-16 h-16 bg-red-600 rounded-full flex items-center justify-center shadow-lg group-hover:bg-red-700 transition-colors">
                  <PlayIcon className="h-8 w-8 text-white ml-1" />
                </div>
              </div>
              {/* Gradient overlay for better play button visibility */}
              <div className="absolute inset-0 bg-gradient-to-t from-black/30 via-transparent to-transparent pointer-events-none" />
            </button>
          ) : (
            <div className="relative w-full aspect-video bg-black">
              <iframe
                src={`https://www.youtube-nocookie.com/embed/${data.youtubeVideoId}?autoplay=1`}
                title="YouTube video player"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
                className="absolute inset-0 w-full h-full"
                // credentialless attribute helps with COEP restrictions
                {...{ credentialless: 'true' } as React.IframeHTMLAttributes<HTMLIFrameElement>}
              />
            </div>
          )}
          {/* Footer with YouTube branding */}
          <a
            href={safeUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="flex items-center gap-1.5 px-3 py-2 text-xs text-neutral-500 dark:text-neutral-400 border-t border-neutral-200 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-800/50 transition-colors"
          >
            <YouTubeIcon className="h-4 w-4 text-red-600 flex-shrink-0" />
            <span>YouTube</span>
          </a>
        </div>
      </div>
    )
  }

  // Direct image URL - use larger layout with prominent image display
  if (isDirectImage) {
    return (
      <div className={`mt-3 ${className}`}>
        <a
          href={safeUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="block border border-neutral-200 dark:border-neutral-700 rounded-xl overflow-hidden hover:bg-neutral-50 dark:hover:bg-neutral-800/50 transition-colors"
        >
          {/* Large image display */}
          {!imageError ? (
            <div className="relative bg-neutral-100 dark:bg-neutral-800">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={safeUrl}
                alt="Image preview"
                className="w-full max-h-[400px] object-contain"
                onError={() => setImageError(true)}
              />
            </div>
          ) : (
            <div className="flex items-center justify-center h-32 bg-neutral-100 dark:bg-neutral-800 text-neutral-400">
              Failed to load image
            </div>
          )}
          {/* Domain info footer */}
          <div className="flex items-center gap-1.5 px-3 py-2 text-xs text-neutral-500 dark:text-neutral-400 border-t border-neutral-200 dark:border-neutral-700">
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
            <span className="truncate">{hostname}</span>
          </div>
        </a>
      </div>
    )
  }

  // Compact horizontal layout with small thumbnail (for articles/pages)
  return (
    <div className={`mt-3 ${className}`}>
      <a
        href={safeUrl}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="flex border border-neutral-200 dark:border-neutral-700 rounded-xl overflow-hidden hover:bg-neutral-50 dark:hover:bg-neutral-800/50 transition-colors"
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
          ) : (
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
    </div>
  )
}

interface LinkPreviewSkeletonProps {
  className?: string
  /** Optional URL to determine skeleton layout (larger for direct images) */
  url?: string
}

export function LinkPreviewSkeleton({ className = '', url }: LinkPreviewSkeletonProps) {
  // Check if URL points directly to an image file for larger skeleton
  const isDirectImage = url ? isDirectImageUrl(url) : false
  // Check if URL is a YouTube video for video-style skeleton
  const isYouTube = url ? isYouTubeUrl(url) : false

  // YouTube video skeleton - 16:9 aspect ratio with play button placeholder
  if (isYouTube) {
    return (
      <div
        className={`mt-3 border border-neutral-200 dark:border-neutral-700 rounded-xl overflow-hidden ${className}`}
      >
        {/* Video thumbnail skeleton with 16:9 aspect ratio */}
        <div className="relative w-full aspect-video bg-neutral-200 dark:bg-neutral-700 animate-pulse">
          {/* Play button placeholder */}
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="w-16 h-16 bg-neutral-300 dark:bg-neutral-600 rounded-full" />
          </div>
        </div>
        {/* YouTube footer skeleton */}
        <div className="flex items-center gap-1.5 px-3 py-2 border-t border-neutral-200 dark:border-neutral-700">
          <div className="w-4 h-4 bg-neutral-200 dark:bg-neutral-700 rounded animate-pulse" />
          <div className="h-3 w-16 bg-neutral-200 dark:bg-neutral-700 rounded animate-pulse" />
        </div>
      </div>
    )
  }

  if (isDirectImage) {
    return (
      <div
        className={`mt-3 border border-neutral-200 dark:border-neutral-700 rounded-xl overflow-hidden ${className}`}
      >
        {/* Large image skeleton */}
        <div className="h-48 bg-neutral-200 dark:bg-neutral-700 animate-pulse" />
        {/* Domain footer skeleton */}
        <div className="flex items-center gap-1.5 px-3 py-2 border-t border-neutral-200 dark:border-neutral-700">
          <div className="w-3.5 h-3.5 bg-neutral-200 dark:bg-neutral-700 rounded animate-pulse" />
          <div className="h-3 w-24 bg-neutral-200 dark:bg-neutral-700 rounded animate-pulse" />
        </div>
      </div>
    )
  }

  // Compact skeleton for articles/pages
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
