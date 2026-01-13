'use client'

import Link from 'next/link'
import { Fragment, useMemo } from 'react'
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline'
import { HashtagValidationStatus } from '@/hooks/use-hashtag-validation'
import { LinkPreview, LinkPreviewSkeleton } from './link-preview'
import { useLinkPreview, extractFirstUrl } from '@/hooks/use-link-preview'
import { useSettingsStore } from '@/lib/store'
import { cashtagDisplayToStorage } from '@/lib/post-helpers'

interface PostContentProps {
  content: string
  className?: string
  /** Optional: validation status per tag (normalized storage format, no # or $) */
  hashtagValidations?: Map<string, HashtagValidationStatus>
  /** Optional: callback when failed hashtag/cashtag warning is clicked */
  onFailedHashtagClick?: (hashtag: string) => void
  /** Optional: disable link preview */
  disableLinkPreview?: boolean
}

type PartType = 'text' | 'hashtag' | 'cashtag' | 'mention' | 'url' | 'bold' | 'italic' | 'code'

interface ContentPart {
  type: PartType
  value: string
}

/**
 * Renders post content with text formatting and clickable elements
 * Supports: **bold**, *italic*, `code`, @mentions, #hashtags, $cashtags, and URLs
 */
export function PostContent({
  content,
  className = '',
  hashtagValidations,
  onFailedHashtagClick,
  disableLinkPreview = false
}: PostContentProps) {
  const richLinkPreviews = useSettingsStore((s) => s.richLinkPreviews)

  // Extract first URL for preview
  const firstUrl = useMemo(() => extractFirstUrl(content), [content])
  const { data: previewData, loading: previewLoading } = useLinkPreview(
    firstUrl,
    { disabled: disableLinkPreview, richPreview: richLinkPreviews }
  )
  const parsedContent = useMemo(() => {
    // Pattern definitions with their types
    // Order matters: more specific patterns first to avoid incorrect matches
    const patterns: Array<{ regex: RegExp; type: PartType }> = [
      // Bold: **text** (must come before italic)
      { regex: /\*\*([^*]+)\*\*/g, type: 'bold' },
      // Italic: *text* (but not **)
      { regex: /(?<!\*)\*([^*]+)\*(?!\*)/g, type: 'italic' },
      // Code: `text`
      { regex: /`([^`]+)`/g, type: 'code' },
      // URLs: http://, https://, or www. prefixed
      { regex: /(https?:\/\/[^\s<>\"\']+|www\.[^\s<>\"\']+)/g, type: 'url' },
      // Hashtags: # followed by alphanumeric/underscore (1-63 chars)
      { regex: /#([a-zA-Z0-9_]{1,63})/g, type: 'hashtag' },
      // Cashtags: $ followed by letter then alphanumeric/underscore (1-63 chars total)
      { regex: /\$([a-zA-Z][a-zA-Z0-9_]{0,62})/g, type: 'cashtag' },
      // Mentions: @ followed by alphanumeric/underscore (1-100 chars)
      { regex: /@([a-zA-Z0-9_]{1,100})/g, type: 'mention' },
    ]

    // Find all matches with their positions
    interface Match {
      type: PartType
      start: number
      end: number
      fullMatch: string
      innerContent: string
    }

    const allMatches: Match[] = []

    for (const { regex, type } of patterns) {
      let match
      const re = new RegExp(regex.source, regex.flags)
      while ((match = re.exec(content)) !== null) {
        allMatches.push({
          type,
          start: match.index,
          end: match.index + match[0].length,
          fullMatch: match[0],
          innerContent: match[1] || match[0],
        })
      }
    }

    // Sort matches by start position
    allMatches.sort((a, b) => a.start - b.start)

    // Remove overlapping matches (keep the first one)
    const filteredMatches: Match[] = []
    let lastEnd = 0
    for (const match of allMatches) {
      if (match.start >= lastEnd) {
        filteredMatches.push(match)
        lastEnd = match.end
      }
    }

    // Build parts array
    const parts: ContentPart[] = []
    let currentIndex = 0

    for (const match of filteredMatches) {
      // Add text before this match
      if (match.start > currentIndex) {
        const textContent = content.slice(currentIndex, match.start)
        if (textContent) {
          parts.push({ type: 'text', value: textContent })
        }
      }

      // Add the matched part
      // For formatting (bold/italic/code), store the inner content
      // For links/tags, store the full match (including prefix)
      if (match.type === 'bold' || match.type === 'italic' || match.type === 'code') {
        parts.push({ type: match.type, value: match.innerContent })
      } else if (match.type === 'url') {
        parts.push({ type: 'url', value: match.fullMatch })
      } else {
        // hashtag, cashtag, mention - include the prefix symbol
        parts.push({ type: match.type, value: match.fullMatch })
      }

      currentIndex = match.end
    }

    // Add remaining text
    if (currentIndex < content.length) {
      parts.push({ type: 'text', value: content.slice(currentIndex) })
    }

    return parts
  }, [content])

  return (
    <div className={className}>
      <div className="whitespace-pre-wrap break-words">
        {parsedContent.map((part, index) => {
          if (part.type === 'bold') {
            return (
              <strong key={index} className="font-semibold">
                {part.value}
              </strong>
            )
          }

          if (part.type === 'italic') {
            return (
              <em key={index} className="italic">
                {part.value}
              </em>
            )
          }

          if (part.type === 'code') {
            return (
              <code
                key={index}
                className="px-1.5 py-0.5 bg-gray-100 dark:bg-gray-800 rounded text-sm font-mono text-pink-600 dark:text-pink-400"
              >
                {part.value}
              </code>
            )
          }

          if (part.type === 'url') {
            // Ensure URL has protocol for href
            const href = part.value.startsWith('www.')
              ? `https://${part.value}`
              : part.value
            // Clean up trailing punctuation that might have been captured
            const cleanHref = href.replace(/[.,;:!?)]+$/, '')
            const cleanDisplay = part.value.replace(/[.,;:!?)]+$/, '')
            const trailingPunctuation = part.value.slice(cleanDisplay.length)

            return (
              <Fragment key={index}>
                <a
                  href={cleanHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="text-yappr-500 hover:underline break-all"
                >
                  {cleanDisplay}
                </a>
                {trailingPunctuation}
              </Fragment>
            )
          }

          if (part.type === 'hashtag') {
            const tag = part.value.slice(1).toLowerCase() // Remove # and lowercase
            const validationStatus = hashtagValidations?.get(tag)
            const isFailed = validationStatus === 'invalid'

            return (
              <span key={index} className="inline-flex items-center">
                <Link
                  href={`/hashtag?tag=${encodeURIComponent(tag)}`}
                  onClick={(e) => e.stopPropagation()}
                  className={`text-yappr-500 hover:underline ${isFailed ? 'opacity-70' : ''}`}
                >
                  {part.value}
                </Link>
                {isFailed && onFailedHashtagClick && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      e.preventDefault()
                      onFailedHashtagClick(tag)
                    }}
                    className="ml-0.5 text-amber-500 hover:text-amber-600 transition-colors"
                    title="Hashtag not registered - click to fix"
                  >
                    <ExclamationTriangleIcon className="h-3.5 w-3.5" />
                  </button>
                )}
              </span>
            )
          }

          if (part.type === 'cashtag') {
            // Cashtags are stored with _cashtag suffix (e.g., $DASH -> dash_cashtag)
            const storageTag = cashtagDisplayToStorage(part.value) // e.g., "dash_cashtag"
            const validationStatus = hashtagValidations?.get(storageTag)
            const isFailed = validationStatus === 'invalid'
            // Display cashtags in uppercase
            const displayValue = '$' + part.value.slice(1).toUpperCase()

            return (
              <span key={index} className="inline-flex items-center">
                <Link
                  href={`/hashtag?tag=${encodeURIComponent(storageTag)}`}
                  onClick={(e) => e.stopPropagation()}
                  className={`text-yappr-500 hover:underline ${isFailed ? 'opacity-70' : ''}`}
                >
                  {displayValue}
                </Link>
                {isFailed && onFailedHashtagClick && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      e.preventDefault()
                      onFailedHashtagClick(storageTag)
                    }}
                    className="ml-0.5 text-amber-500 hover:text-amber-600 transition-colors"
                    title="Cashtag not registered - click to fix"
                  >
                    <ExclamationTriangleIcon className="h-3.5 w-3.5" />
                  </button>
                )}
              </span>
            )
          }

          if (part.type === 'mention') {
            // For mentions, we'd need to resolve the username to an identity ID
            // For now, just style it but don't link
            return (
              <span key={index} className="text-yappr-500">
                {part.value}
              </span>
            )
          }

          return <Fragment key={index}>{part.value}</Fragment>
        })}
      </div>
      {/* Link preview */}
      {!disableLinkPreview && previewLoading && <LinkPreviewSkeleton />}
      {!disableLinkPreview && previewData && (
        <LinkPreview data={previewData} />
      )}
    </div>
  )
}
