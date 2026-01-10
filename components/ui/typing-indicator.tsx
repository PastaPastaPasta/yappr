'use client'

import { memo, useEffect, useState } from 'react'
import { useTyping } from '@/hooks/use-typing'
import { cn } from '@/lib/utils'

interface TypingIndicatorProps {
  conversationId: string
  className?: string
  /** Optional: Map of userId to display name for better UX */
  usernames?: Map<string, string>
}

/**
 * Animated typing dots
 */
function TypingDots({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-0.5', className)}>
      <span className="h-1.5 w-1.5 rounded-full bg-gray-500 animate-bounce" style={{ animationDelay: '0ms' }} />
      <span className="h-1.5 w-1.5 rounded-full bg-gray-500 animate-bounce" style={{ animationDelay: '150ms' }} />
      <span className="h-1.5 w-1.5 rounded-full bg-gray-500 animate-bounce" style={{ animationDelay: '300ms' }} />
    </span>
  )
}

/**
 * Format typing users into a readable string
 */
function formatTypingUsers(
  userIds: string[],
  usernames?: Map<string, string>
): string {
  if (userIds.length === 0) return ''

  const names = userIds.map(id => {
    const name = usernames?.get(id)
    // Show first 8 chars of ID if no username
    return name || id.slice(0, 8) + '...'
  })

  if (names.length === 1) {
    return `${names[0]} is typing`
  }

  if (names.length === 2) {
    return `${names[0]} and ${names[1]} are typing`
  }

  return `${names.length} people are typing`
}

/**
 * Typing indicator component for DM conversations
 * Shows animated dots and usernames when someone is typing
 */
export const TypingIndicator = memo(function TypingIndicator({
  conversationId,
  className,
  usernames,
}: TypingIndicatorProps) {
  const { typingUsers, isTyping } = useTyping(conversationId)

  if (!isTyping) {
    return null
  }

  const label = formatTypingUsers(typingUsers, usernames)

  return (
    <div
      className={cn(
        'flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400',
        className
      )}
    >
      <TypingDots />
      <span>{label}</span>
    </div>
  )
})

/**
 * Compact typing indicator (just dots, no text)
 */
export const TypingDotsIndicator = memo(function TypingDotsIndicator({
  conversationId,
  className,
}: {
  conversationId: string
  className?: string
}) {
  const { isTyping } = useTyping(conversationId)

  if (!isTyping) {
    return null
  }

  return <TypingDots className={className} />
})

/**
 * Typing indicator that resolves usernames automatically via DPNS
 */
export const TypingIndicatorWithNames = memo(function TypingIndicatorWithNames({
  conversationId,
  className,
}: {
  conversationId: string
  className?: string
}) {
  const { typingUsers, isTyping } = useTyping(conversationId)
  const [usernames, setUsernames] = useState<Map<string, string>>(new Map())

  // Resolve usernames for typing users
  useEffect(() => {
    if (typingUsers.length === 0) {
      return
    }

    let mounted = true

    const resolveUsernames = async () => {
      try {
        const { dpnsService } = await import('@/lib/services/dpns-service')

        const resolved = new Map<string, string>()

        await Promise.all(
          typingUsers.map(async (userId) => {
            try {
              const username = await dpnsService.resolveUsername(userId)
              if (username && mounted) {
                resolved.set(userId, username)
              }
            } catch {
              // Ignore errors for individual users
            }
          })
        )

        if (mounted && resolved.size > 0) {
          setUsernames(prev => {
            const next = new Map(prev)
            resolved.forEach((name, id) => next.set(id, name))
            return next
          })
        }
      } catch (error) {
        console.error('TypingIndicatorWithNames: Error resolving usernames:', error)
      }
    }

    resolveUsernames()

    return () => {
      mounted = false
    }
  }, [typingUsers.join(',')])

  if (!isTyping) {
    return null
  }

  const label = formatTypingUsers(typingUsers, usernames)

  return (
    <div
      className={cn(
        'flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400',
        className
      )}
    >
      <TypingDots />
      <span>{label}</span>
    </div>
  )
})
