'use client'

import Link from 'next/link'
import { Fragment, useMemo } from 'react'

interface PostContentProps {
  content: string
  className?: string
}

/**
 * Renders post content with clickable hashtags, mentions, and URLs
 */
export function PostContent({ content, className = '' }: PostContentProps) {
  const parsedContent = useMemo(() => {
    // Combined pattern to match URLs, hashtags, and mentions
    // Order matters - URLs first to avoid partial matches
    // URLs: http://, https://, or www. prefixed
    // Hashtags: # followed by alphanumeric/underscore (1-63 chars)
    // Mentions: @ followed by alphanumeric/underscore (1-100 chars)
    const combinedPattern = /(https?:\/\/[^\s<>\"\']+|www\.[^\s<>\"\']+)|(#[a-zA-Z0-9_]{1,63})|(@[a-zA-Z0-9_]{1,100})/gi

    const parts: Array<{ type: 'text' | 'hashtag' | 'mention' | 'url'; value: string }> = []
    let lastIndex = 0
    let match

    while ((match = combinedPattern.exec(content)) !== null) {
      // Add text before the match
      if (match.index > lastIndex) {
        parts.push({
          type: 'text',
          value: content.slice(lastIndex, match.index)
        })
      }

      // Add the matched element
      const value = match[0]
      if (match[1]) {
        // URL match (first capture group)
        parts.push({ type: 'url', value })
      } else if (match[2]) {
        // Hashtag match (second capture group)
        parts.push({ type: 'hashtag', value })
      } else if (match[3]) {
        // Mention match (third capture group)
        parts.push({ type: 'mention', value })
      }

      lastIndex = match.index + match[0].length
    }

    // Add remaining text
    if (lastIndex < content.length) {
      parts.push({
        type: 'text',
        value: content.slice(lastIndex)
      })
    }

    return parts
  }, [content])

  return (
    <div className={`whitespace-pre-wrap break-words ${className}`}>
      {parsedContent.map((part, index) => {
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
          return (
            <Link
              key={index}
              href={`/hashtag?tag=${encodeURIComponent(tag)}`}
              onClick={(e) => e.stopPropagation()}
              className="text-yappr-500 hover:underline"
            >
              {part.value}
            </Link>
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
  )
}
