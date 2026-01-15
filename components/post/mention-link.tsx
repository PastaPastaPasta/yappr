'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { dpnsService } from '@/lib/services/dpns-service'

interface MentionLinkProps {
  username: string
  displayText: string
}

/**
 * Renders a clickable mention (@username) that resolves to a user profile.
 * Handles DPNS resolution to get the identity ID from the username.
 */
export function MentionLink({ username, displayText }: MentionLinkProps) {
  const [identityId, setIdentityId] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false

    async function resolveUser() {
      try {
        const id = await dpnsService.resolveIdentity(username)
        if (!cancelled) {
          setIdentityId(id)
          setError(!id)
        }
      } catch (e) {
        console.warn('Failed to resolve mention:', username, e)
        if (!cancelled) {
          setError(true)
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false)
        }
      }
    }

    resolveUser()
    return () => { cancelled = true }
  }, [username])

  // If resolved successfully, link to user profile
  if (identityId) {
    return (
      <Link
        href={`/user?id=${encodeURIComponent(identityId)}`}
        onClick={(e) => e.stopPropagation()}
        className="text-yappr-500 hover:underline"
      >
        {displayText}
      </Link>
    )
  }

  // If still loading, show styled text (not clickable yet)
  if (isLoading) {
    return (
      <span className="text-yappr-500">
        {displayText}
      </span>
    )
  }

  // If failed to resolve, render as styled text (not clickable)
  // with slight opacity to indicate it's not a valid user
  return (
    <span className={`text-yappr-500 ${error ? 'opacity-60' : ''}`}>
      {displayText}
    </span>
  )
}
