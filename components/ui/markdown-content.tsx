'use client'

import { useMemo } from 'react'
import Link from 'next/link'

interface MarkdownContentProps {
  content: string
  className?: string
}

interface ParsedToken {
  type: 'text' | 'bold' | 'italic' | 'code' | 'link' | 'mention' | 'hashtag' | 'cashtag'
  content: string
  href?: string
}

/**
 * Lightweight markdown renderer for social media posts
 * Supports: **bold**, *italic*, `code`, @mentions, #hashtags, $cashtags, and URLs
 */
export function MarkdownContent({ content, className = '' }: MarkdownContentProps) {
  const tokens = useMemo(() => parseContent(content), [content])

  return (
    <span className={className}>
      {tokens.map((token, index) => renderToken(token, index))}
    </span>
  )
}

function parseContent(text: string): ParsedToken[] {
  const tokens: ParsedToken[] = []

  // Combined regex for all patterns
  // Order matters: more specific patterns first
  const patterns = [
    // Bold: **text**
    { regex: /\*\*([^*]+)\*\*/g, type: 'bold' as const },
    // Italic: *text* (but not **)
    { regex: /(?<!\*)\*([^*]+)\*(?!\*)/g, type: 'italic' as const },
    // Code: `text`
    { regex: /`([^`]+)`/g, type: 'code' as const },
    // URLs: http(s)://...
    { regex: /(https?:\/\/[^\s<>\[\]]+)/g, type: 'link' as const },
    // Mentions: @username
    { regex: /@([a-zA-Z0-9_-]+)/g, type: 'mention' as const },
    // Hashtags: #tag
    { regex: /#([a-zA-Z0-9_]+)/g, type: 'hashtag' as const },
    // Cashtags: $tag
    { regex: /\$([a-zA-Z0-9_]+)/g, type: 'cashtag' as const },
  ]

  // Find all matches with their positions
  interface Match {
    type: ParsedToken['type']
    start: number
    end: number
    fullMatch: string
    content: string
  }

  const allMatches: Match[] = []

  for (const { regex, type } of patterns) {
    let match
    const re = new RegExp(regex.source, regex.flags)
    while ((match = re.exec(text)) !== null) {
      allMatches.push({
        type,
        start: match.index,
        end: match.index + match[0].length,
        fullMatch: match[0],
        content: match[1] || match[0],
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

  // Build tokens
  let currentIndex = 0
  for (const match of filteredMatches) {
    // Add text before this match
    if (match.start > currentIndex) {
      const textContent = text.slice(currentIndex, match.start)
      if (textContent) {
        tokens.push({ type: 'text', content: textContent })
      }
    }

    // Add the matched token
    if (match.type === 'link') {
      tokens.push({
        type: 'link',
        content: match.content,
        href: match.content,
      })
    } else if (match.type === 'mention') {
      tokens.push({
        type: 'mention',
        content: match.content,
        href: `/${match.content}`,
      })
    } else if (match.type === 'hashtag') {
      tokens.push({
        type: 'hashtag',
        content: match.content,
        href: `/hashtag/${match.content}`,
      })
    } else if (match.type === 'cashtag') {
      tokens.push({
        type: 'cashtag',
        content: match.content,
        href: `/hashtag/$${match.content}`,
      })
    } else {
      tokens.push({
        type: match.type,
        content: match.content,
      })
    }

    currentIndex = match.end
  }

  // Add remaining text
  if (currentIndex < text.length) {
    tokens.push({ type: 'text', content: text.slice(currentIndex) })
  }

  return tokens
}

function renderToken(token: ParsedToken, key: number): React.ReactNode {
  switch (token.type) {
    case 'bold':
      return (
        <strong key={key} className="font-semibold">
          {token.content}
        </strong>
      )
    case 'italic':
      return (
        <em key={key} className="italic">
          {token.content}
        </em>
      )
    case 'code':
      return (
        <code
          key={key}
          className="px-1.5 py-0.5 bg-surface-100 dark:bg-surface-800 rounded text-sm font-mono text-pink-600 dark:text-pink-400"
        >
          {token.content}
        </code>
      )
    case 'link':
      return (
        <a
          key={key}
          href={token.href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-yappr-500 hover:underline break-all"
          onClick={(e) => e.stopPropagation()}
        >
          {token.content}
        </a>
      )
    case 'mention':
      return (
        <Link
          key={key}
          href={token.href || '#'}
          className="text-yappr-500 hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          @{token.content}
        </Link>
      )
    case 'hashtag':
      return (
        <Link
          key={key}
          href={token.href || '#'}
          className="text-yappr-500 hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          #{token.content}
        </Link>
      )
    case 'cashtag':
      return (
        <Link
          key={key}
          href={token.href || '#'}
          className="text-yappr-500 hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          ${token.content}
        </Link>
      )
    default:
      return <span key={key}>{token.content}</span>
  }
}
