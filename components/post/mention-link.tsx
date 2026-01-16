'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline'
import { dpnsService } from '@/lib/services/dpns-service'

interface MentionLinkProps {
  username: string
  displayText: string
  /** Whether the mention document failed to register on-chain */
  isFailed?: boolean
  /** Callback when the warning icon is clicked for a failed mention */
  onFailedClick?: (username: string) => void
}

/**
 * Renders a clickable mention (@username) that resolves to a user profile.
 * Handles DPNS resolution to get the identity ID from the username.
 * Shows a warning icon if the mention document was not registered on-chain.
 */
export function MentionLink({ username, displayText, isFailed, onFailedClick }: MentionLinkProps) {
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

    resolveUser().catch(err => console.error('Failed to resolve user:', err))
    return () => { cancelled = true }
  }, [username])

  // If resolved successfully, link to user profile
  if (identityId) {
    return (
      <span className="inline-flex items-center">
        <Link
          href={`/user?id=${encodeURIComponent(identityId)}`}
          onClick={(e) => e.stopPropagation()}
          className={`text-yappr-500 hover:underline ${isFailed ? 'opacity-70' : ''}`}
        >
          {displayText}
        </Link>
        {isFailed && onFailedClick && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              e.preventDefault()
              onFailedClick(username)
            }}
            className="ml-0.5 text-amber-500 hover:text-amber-600 transition-colors"
            title="Mention not registered - click to fix"
          >
            <ExclamationTriangleIcon className="h-3.5 w-3.5" />
          </button>
        )}
      </span>
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
    <span className="inline-flex items-center">
      <span className={`text-yappr-500 ${error ? 'opacity-60' : ''}`}>
        {displayText}
      </span>
      {isFailed && onFailedClick && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            e.preventDefault()
            onFailedClick(username)
          }}
          className="ml-0.5 text-amber-500 hover:text-amber-600 transition-colors"
          title="Mention not registered - click to fix"
        >
          <ExclamationTriangleIcon className="h-3.5 w-3.5" />
        </button>
      )}
    </span>
  )
}
