'use client'

import Link from 'next/link'
import { Fragment, useMemo } from 'react'

interface PostContentProps {
  content: string
  className?: string
}

/**
 * Renders post content with clickable hashtags and mentions
 */
export function PostContent({ content, className = '' }: PostContentProps) {
  const parsedContent = useMemo(() => {
    // Regex patterns for hashtags and mentions
    const hashtagPattern = /#([a-zA-Z0-9_]{1,63})/g
    const mentionPattern = /@([a-zA-Z0-9_]{1,100})/g

    // Combined pattern to match both
    const combinedPattern = /(#[a-zA-Z0-9_]{1,63})|(@[a-zA-Z0-9_]{1,100})/g

    const parts: Array<{ type: 'text' | 'hashtag' | 'mention'; value: string }> = []
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

      // Add the matched hashtag or mention
      const value = match[0]
      if (value.startsWith('#')) {
        parts.push({ type: 'hashtag', value })
      } else if (value.startsWith('@')) {
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
