'use client'

import Link from 'next/link'
import toast from 'react-hot-toast'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

interface UserDisplayNameProps {
  userId: string
  username: string | null | undefined // undefined = loading, null = no DPNS, string = DPNS username
  displayName?: string
  verified?: boolean
  showLink?: boolean
  className?: string
}

/**
 * Resolves what text to display for a user's identity.
 * Priority: DPNS username > Profile display name > Truncated identity ID
 */
export function resolveUserDisplayText(
  userId: string,
  username: string | null | undefined,
  displayName?: string
): { text: string; showAt: boolean } {
  // Has DPNS username (non-empty, not a placeholder)
  if (username && !username.startsWith('user_')) {
    return { text: username, showAt: true }
  }

  // Has profile display name (not a placeholder)
  if (displayName && displayName !== 'Unknown User' && !displayName.startsWith('User ')) {
    return { text: displayName, showAt: false }
  }

  // Fallback to truncated identity ID
  return { text: `${userId.slice(0, 8)}...${userId.slice(-6)}`, showAt: false }
}

/**
 * Checks if user has a real profile (display name that's not a placeholder)
 */
export function hasRealProfile(displayName?: string): boolean {
  return !!(
    displayName &&
    displayName !== 'Unknown User' &&
    !displayName.startsWith('User ')
  )
}

/**
 * Truncates an identity ID for display
 */
export function truncateIdentityId(id: string): string {
  return `${id.slice(0, 8)}...${id.slice(-6)}`
}

/**
 * Component for displaying user display name with loading state and verified badge
 */
export function UserDisplayName({
  userId,
  username,
  displayName,
  verified = false,
  showLink = true,
  className = ''
}: UserDisplayNameProps): JSX.Element {
  const isLoading = username === undefined

  if (isLoading) {
    return (
      <span className="inline-block w-24 h-4 bg-gray-200 dark:bg-gray-700 rounded animate-pulse" />
    )
  }

  const displayNameContent = (
    <span className={`font-semibold ${showLink ? 'hover:underline' : ''} truncate ${className}`}>
      {displayName || `User ${userId.slice(-6)}`}
    </span>
  )

  return (
    <>
      {showLink ? (
        <Link
          href={`/user?id=${userId}`}
          onClick={(e) => e.stopPropagation()}
          className="font-semibold hover:underline truncate"
        >
          {displayName || `User ${userId.slice(-6)}`}
        </Link>
      ) : (
        displayNameContent
      )}
      {verified && (
        <svg className="h-4 w-4 text-yappr-500 flex-shrink-0" viewBox="0 0 24 24" fill="currentColor">
          <path d="M22.5 12.5c0-1.58-.875-2.95-2.148-3.6.154-.435.238-.905.238-1.4 0-2.21-1.71-3.998-3.818-3.998-.47 0-.92.084-1.336.25C14.818 2.415 13.51 1.5 12 1.5s-2.816.917-3.437 2.25c-.415-.165-.866-.25-1.336-.25-2.11 0-3.818 1.79-3.818 4 0 .494.083.964.237 1.4-1.272.65-2.147 2.018-2.147 3.6 0 1.495.782 2.798 1.942 3.486-.02.17-.032.34-.032.514 0 2.21 1.708 4 3.818 4 .47 0 .92-.086 1.335-.25.62 1.334 1.926 2.25 3.437 2.25 1.512 0 2.818-.916 3.437-2.25.415.163.865.248 1.336.248 2.11 0 3.818-1.79 3.818-4 0-.174-.012-.344-.033-.513 1.158-.687 1.943-1.99 1.943-3.484zm-6.616-3.334l-4.334 6.5c-.145.217-.382.334-.625.334-.143 0-.288-.04-.416-.126l-.115-.094-2.415-2.415c-.293-.293-.293-.768 0-1.06s.768-.294 1.06 0l1.77 1.767 3.825-5.74c.23-.345.696-.436 1.04-.207.346.23.44.696.21 1.04z" />
        </svg>
      )}
    </>
  )
}

interface UserHandleProps {
  userId: string
  username: string | null | undefined
  displayName?: string
  showLink?: boolean
}

/**
 * Component for displaying user handle (@username, identity ID, or nothing if profile-only)
 */
export function UserHandle({
  userId,
  username,
  displayName,
  showLink = true
}: UserHandleProps): JSX.Element | null {
  const isLoading = username === undefined
  const hasProfile = hasRealProfile(displayName)

  if (isLoading) {
    return (
      <span className="inline-block w-20 h-4 bg-gray-200 dark:bg-gray-700 rounded animate-pulse" />
    )
  }

  // Has DPNS username
  if (username) {
    const content = (
      <span className="text-gray-500 hover:underline truncate">@{username}</span>
    )
    return showLink ? (
      <Link href={`/user?id=${userId}`} onClick={(e) => e.stopPropagation()}>
        {content}
      </Link>
    ) : content
  }

  // No DPNS and no profile - show clickable identity ID
  if (!hasProfile) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={(e) => {
                e.stopPropagation()
                void navigator.clipboard.writeText(userId).then(() => {
                  toast.success('Identity ID copied')
                })
              }}
              className="text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 truncate font-mono text-xs"
            >
              {truncateIdentityId(userId)}
            </button>
          </TooltipTrigger>
          <TooltipContent>Click to copy full identity ID</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }

  // Has profile but no DPNS - display name is sufficient, return nothing
  return null
}

interface CopyableIdentityIdProps {
  userId: string
  className?: string
}

/**
 * A clickable identity ID that copies to clipboard on click
 */
export function CopyableIdentityId({ userId, className = '' }: CopyableIdentityIdProps): JSX.Element {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={(e) => {
              e.stopPropagation()
              void navigator.clipboard.writeText(userId).then(() => {
                toast.success('Identity ID copied')
              })
            }}
            className={`font-mono text-xs hover:text-gray-700 dark:hover:text-gray-300 ${className}`}
          >
            {truncateIdentityId(userId)}
          </button>
        </TooltipTrigger>
        <TooltipContent>Click to copy full identity ID</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
