'use client'

import Link from 'next/link'
import { Fragment, useMemo } from 'react'
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline'
import { HashtagValidationStatus } from '@/hooks/use-hashtag-validation'
import { MentionValidationStatus } from '@/hooks/use-mention-validation'
import { LinkPreview, LinkPreviewSkeleton, LinkPreviewEnablePrompt } from './link-preview'
import { useLinkPreview, extractFirstUrl, stripTrailingPunctuation } from '@/hooks/use-link-preview'
import { useSettingsStore } from '@/lib/store'
import { cashtagDisplayToStorage, normalizeDpnsUsername } from '@/lib/post-helpers'
import { MentionLink } from './mention-link'

interface PostContentProps {
  content: string
  className?: string
  /** Optional: validation status per tag (normalized storage format, no # or $) */
  hashtagValidations?: Map<string, HashtagValidationStatus>
  /** Optional: callback when failed hashtag/cashtag warning is clicked */
  onFailedHashtagClick?: (hashtag: string) => void
  /** Optional: validation status per mention (normalized, no @) */
  mentionValidations?: Map<string, MentionValidationStatus>
  /** Optional: callback when failed mention warning is clicked */
  onFailedMentionClick?: (username: string) => void
  /** Optional: disable link preview */
  disableLinkPreview?: boolean
}

type PartType = 'text' | 'hashtag' | 'cashtag' | 'mention' | 'url' | 'bold' | 'italic' | 'code'

interface ContentPart {
  type: PartType
  value: string
  // For bold/italic, children contains parsed inner content (hashtags, mentions, etc.)
  children?: ContentPart[]
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
  mentionValidations,
  onFailedMentionClick,
  disableLinkPreview = false
}: PostContentProps) {
  const linkPreviews = useSettingsStore((s) => s.linkPreviews)

  // Extract first URL for preview
  const firstUrl = useMemo(() => extractFirstUrl(content), [content])

  // Only fetch preview if link previews are enabled
  const { data: previewData, loading: previewLoading } = useLinkPreview(
    firstUrl,
    { disabled: disableLinkPreview || !linkPreviews }
  )
  const parsedContent = useMemo(() => {
    // Patterns for inline elements (hashtags, cashtags, mentions, urls)
    const inlinePatterns: Array<{ regex: RegExp; type: PartType }> = [
      // URLs: http://, https://, or www. prefixed
      { regex: /(https?:\/\/[^\s<>\"\']+|www\.[^\s<>\"\']+)/g, type: 'url' },
      // Hashtags: # followed by alphanumeric/underscore (1-63 chars)
      { regex: /#([a-zA-Z0-9_]{1,63})/g, type: 'hashtag' },
      // Cashtags: $ followed by letter then alphanumeric/underscore (1-63 chars total)
      { regex: /\$([a-zA-Z][a-zA-Z0-9_]{0,62})/g, type: 'cashtag' },
      // Mentions: @ followed by alphanumeric/underscore, optionally with .dash suffix (no hyphens - DPNS doesn't allow them)
      { regex: /@([a-zA-Z0-9_]{1,100}(?:\.dash)?)/gi, type: 'mention' },
    ]

    // Parse text for inline elements only (used for inner content of bold/italic)
    function parseInlineContent(text: string): ContentPart[] {
      interface Match {
        type: PartType
        start: number
        end: number
        fullMatch: string
      }

      const allMatches: Match[] = []

      for (const { regex, type } of inlinePatterns) {
        let match
        const re = new RegExp(regex.source, regex.flags)
        while ((match = re.exec(text)) !== null) {
          allMatches.push({
            type,
            start: match.index,
            end: match.index + match[0].length,
            fullMatch: match[0],
          })
        }
      }

      // Sort by position and remove overlaps
      allMatches.sort((a, b) => a.start - b.start)
      const filteredMatches: Match[] = []
      let lastEnd = 0
      for (const match of allMatches) {
        if (match.start >= lastEnd) {
          filteredMatches.push(match)
          lastEnd = match.end
        }
      }

      // Build parts
      const parts: ContentPart[] = []
      let currentIndex = 0

      for (const match of filteredMatches) {
        if (match.start > currentIndex) {
          parts.push({ type: 'text', value: text.slice(currentIndex, match.start) })
        }
        parts.push({ type: match.type, value: match.fullMatch })
        currentIndex = match.end
      }

      if (currentIndex < text.length) {
        parts.push({ type: 'text', value: text.slice(currentIndex) })
      }

      return parts
    }

    // All patterns including formatting
    const allPatterns: Array<{ regex: RegExp; type: PartType }> = [
      // Bold: **text** (must come before italic)
      { regex: /\*\*([^*]+)\*\*/g, type: 'bold' },
      // Italic: *text* (but not **)
      { regex: /(?<!\*)\*([^*]+)\*(?!\*)/g, type: 'italic' },
      // Code: `text`
      { regex: /`([^`]+)`/g, type: 'code' },
      ...inlinePatterns,
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

    for (const { regex, type } of allPatterns) {
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
      if (match.type === 'bold' || match.type === 'italic') {
        // For bold/italic, recursively parse inner content for hashtags, mentions, etc.
        const children = parseInlineContent(match.innerContent)
        parts.push({ type: match.type, value: match.innerContent, children })
      } else if (match.type === 'code') {
        // Code blocks are literal - no nested parsing
        parts.push({ type: 'code', value: match.innerContent })
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

  // Helper to render a single inline part (hashtag, cashtag, mention, url, text)
  // Used for both top-level and nested content inside bold/italic
  const renderInlinePart = (part: ContentPart, key: string | number): React.ReactNode => {
    if (part.type === 'url') {
      const href = part.value.startsWith('www.')
        ? `https://${part.value}`
        : part.value
      // Use stripTrailingPunctuation for cleanHref to match extractFirstUrl's normalization
      const cleanHref = stripTrailingPunctuation(href)
      const cleanDisplay = part.value.replace(/[.,;:!?)]+$/, '')
      const trailingPunctuation = part.value.slice(cleanDisplay.length)

      // If link previews are enabled and this URL is being previewed (loading or loaded), strip it from content
      // Keep only trailing punctuation (if any). If preview fetch fails, the raw URL remains visible.
      if (linkPreviews && firstUrl && cleanHref === firstUrl && (previewLoading || previewData)) {
        return trailingPunctuation ? <Fragment key={key}>{trailingPunctuation}</Fragment> : null
      }

      return (
        <Fragment key={key}>
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
      const tag = part.value.slice(1).toLowerCase()
      const validationStatus = hashtagValidations?.get(tag)
      const isFailed = validationStatus === 'invalid'

      return (
        <span key={key} className="inline-flex items-center">
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
      const storageTag = cashtagDisplayToStorage(part.value)
      const validationStatus = hashtagValidations?.get(storageTag)
      const isFailed = validationStatus === 'invalid'
      const displayValue = '$' + part.value.slice(1).toUpperCase()

      return (
        <span key={key} className="inline-flex items-center">
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
      // Extract and normalize username (removes @ prefix and .dash suffix)
      const rawUsername = part.value.slice(1)
      const normalizedUsername = normalizeDpnsUsername(rawUsername)
      const validationStatus = mentionValidations?.get(normalizedUsername)
      const isFailed = validationStatus === 'invalid'

      return (
        <MentionLink
          key={key}
          username={normalizedUsername}
          displayText={part.value}
          isFailed={isFailed}
          onFailedClick={onFailedMentionClick}
        />
      )
    }

    // text
    return <Fragment key={key}>{part.value}</Fragment>
  }

  // Render children array (for bold/italic inner content)
  const renderChildren = (children: ContentPart[]): React.ReactNode => {
    return children.map((child, i) => renderInlinePart(child, i))
  }

  return (
    <div className={className}>
      <div className="whitespace-pre-wrap break-words">
        {parsedContent.map((part, index) => {
          if (part.type === 'bold') {
            return (
              <strong key={index} className="font-semibold">
                {part.children ? renderChildren(part.children) : part.value}
              </strong>
            )
          }

          if (part.type === 'italic') {
            return (
              <em key={index} className="italic">
                {part.children ? renderChildren(part.children) : part.value}
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

          return renderInlinePart(part, index)
        })}
      </div>
      {/* Link preview */}
      {!disableLinkPreview && linkPreviews && previewLoading && <LinkPreviewSkeleton url={firstUrl ?? undefined} />}
      {!disableLinkPreview && linkPreviews && previewData && (
        <LinkPreview data={previewData} />
      )}
      {/* Enable link previews prompt - shown when disabled and URL exists */}
      {!disableLinkPreview && !linkPreviews && firstUrl && (
        <LinkPreviewEnablePrompt />
      )}
    </div>
  )
}
