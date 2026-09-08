'use client'

import Link from 'next/link'
import type { Post } from '@/lib/types'
import { useCopy } from '@/hooks/use-copy'
import { ProfileHoverCard } from '@/components/profile/profile-hover-card'
import { TooltipBadge } from '@/components/ui/tooltip-button'
import { stopPropagation } from '@/lib/utils/events'

/** `undefined` while the lookup is running, `null` for an author with no DPNS name. */
export type UsernameState = string | null | undefined

/** Progressive enrichment wins; otherwise the author's own `hasDpns` flag decides. */
export function resolveUsernameState(progressiveUsername: UsernameState, author: Post['author']): UsernameState {
  if (progressiveUsername !== undefined) return progressiveUsername
  if (author.hasDpns === undefined) return undefined
  return author.hasDpns ? author.username : null
}

/** Whether a display name is a real profile name rather than one of our placeholders. */
export function hasRealProfile(displayName: string | undefined, identityId: string): boolean {
  if (!displayName || displayName === 'Unknown User') return false
  return displayName !== `User ${identityId.slice(-6)}` && displayName !== `User ${identityId.slice(-8)}`
}

const VERIFIED_PATH =
  'M22.5 12.5c0-1.58-.875-2.95-2.148-3.6.154-.435.238-.905.238-1.4 0-2.21-1.71-3.998-3.818-3.998-.47 0-.92.084-1.336.25C14.818 2.415 13.51 1.5 12 1.5s-2.816.917-3.437 2.25c-.415-.165-.866-.25-1.336-.25-2.11 0-3.818 1.79-3.818 4 0 .494.083.964.237 1.4-1.272.65-2.147 2.018-2.147 3.6 0 1.495.782 2.798 1.942 3.486-.02.17-.032.34-.032.514 0 2.21 1.708 4 3.818 4 .47 0 .92-.086 1.335-.25.62 1.334 1.926 2.25 3.437 2.25 1.512 0 2.818-.916 3.437-2.25.415.163.865.248 1.336.248 2.11 0 3.818-1.79 3.818-4 0-.174-.012-.344-.033-.513 1.158-.687 1.943-1.99 1.943-3.484zm-6.616-3.334l-4.334 6.5c-.145.217-.382.334-.625.334-.143 0-.288-.04-.416-.126l-.115-.094-2.415-2.415c-.293-.293-.293-.768 0-1.06s.768-.294 1.06 0l1.77 1.767 3.825-5.74c.23-.345.696-.436 1.04-.207.346.23.44.696.21 1.04z'

interface PostAuthorLineProps {
  author: Post['author']
  usernameState: UsernameState
  displayName: string
  avatarUrl: string | undefined
  profileLoaded: boolean
}

/** Display name, verified mark and handle (or identity id) for the author of a card. */
export function PostAuthorLine({ author, usernameState, displayName, avatarUrl, profileLoaded }: PostAuthorLineProps) {
  const copy = useCopy()
  const hasProfile = hasRealProfile(displayName, author.id)
  const hover = { userId: author.id, displayName, avatarUrl }

  const handle = () => {
    if (usernameState) {
      return (
        <ProfileHoverCard {...hover} username={usernameState}>
          <Link href={`/user?id=${author.id}`} onClick={stopPropagation} className="text-gray-500 hover:underline truncate">
            @{usernameState}
          </Link>
        </ProfileHoverCard>
      )
    }
    if (usernameState === undefined) return <span className="inline-block w-20 h-4 bg-gray-200 dark:bg-gray-700 rounded animate-pulse" />
    // A profile name is enough on its own; only a nameless author shows the id.
    if (hasProfile) return null
    return (
      <ProfileHoverCard {...hover} username={null}>
        <TooltipBadge label="Click to copy full identity ID" className="inline-flex">
          <button
            onClick={(e) => {
              e.stopPropagation()
              copy(author.id, 'Identity ID copied')
            }}
            className="text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 truncate font-mono text-xs"
          >
            {author.id.slice(0, 8)}...{author.id.slice(-6)}
          </button>
        </TooltipBadge>
      </ProfileHoverCard>
    )
  }

  return (
    <>
      {usernameState === undefined || (!hasProfile && !profileLoaded) ? (
        <span className="inline-block w-24 h-4 bg-gray-200 dark:bg-gray-700 rounded animate-pulse" />
      ) : (
        <ProfileHoverCard {...hover} username={usernameState}>
          <Link href={`/user?id=${author.id}`} onClick={stopPropagation} className="font-semibold hover:underline truncate">
            {hasProfile ? displayName : 'Unknown User'}
          </Link>
        </ProfileHoverCard>
      )}
      {author.verified && (
        <svg className="h-4 w-4 text-yappr-500 flex-shrink-0" viewBox="0 0 24 24" fill="currentColor">
          <path d={VERIFIED_PATH} />
        </svg>
      )}
      {handle()}
      <span className="text-gray-500 flex-shrink-0">·</span>
    </>
  )
}
