'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import type { Post } from '@/lib/types'
import { logger } from '@/lib/logger'
import { laneKey, laneLabel, readAuthorModeratedContent, type AuthorModeratedContent } from '@/lib/services/author-moderated-content'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { PostCard } from '@/components/post/post-card'
import { HIDDEN_CONTENT_HREF } from '@/components/moderation/moderator-view'

/** Cards shown at first, and added per "Show more". */
const STEP = 20

interface ProfileModerationPanelProps {
  userId: string
  enrichProgressively: (posts: Post[]) => void
  getPostEnrichment: (post: Post) => React.ComponentProps<typeof PostCard>['enrichment']
}

/**
 * A profile's Moderation tab, for the social contract's seated moderators:
 * the account's hidden posts and replies and what it wrote while restricted,
 * newest first, each labelled, with a count per lane.
 */
export function ProfileModerationPanel({ userId, enrichProgressively, getPostEnrichment }: ProfileModerationPanelProps) {
  const [content, setContent] = useState<AuthorModeratedContent | null>(null)
  const [failed, setFailed] = useState(false)
  const [shown, setShown] = useState(STEP)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    setContent(null)
    setFailed(false)
    setShown(STEP)
    readAuthorModeratedContent(userId).then((read) => {
      if (cancelled) return
      setContent(read)
      enrichProgressively(read.items.slice(0, STEP))
    }).catch((error: unknown) => {
      logger.error('Profile: could not read the account\'s hidden and restricted posts', error)
      if (!cancelled) setFailed(true)
    })
    return () => {
      cancelled = true
    }
  }, [userId, attempt, enrichProgressively])

  if (failed) {
    return (
      <div role="alert" className="p-4 text-center text-sm">
        <p>Couldn&apos;t load hidden and restricted posts.</p>
        <Button variant="outline" size="sm" className="mt-2" onClick={() => setAttempt((n) => n + 1)}>Try again</Button>
      </div>
    )
  }
  if (!content) {
    return (
      <div className="p-8 text-center">
        <Spinner size="md" className="mx-auto mb-4" />
        <p className="text-gray-500">Loading hidden and restricted posts...</p>
      </div>
    )
  }

  const showMore = () => {
    const next = shown + STEP
    setShown(next)
    enrichProgressively(content.items.slice(0, next))
  }

  return (
    <div data-testid="profile-moderation">
      <div className="flex flex-wrap items-center gap-2 border-b border-gray-200 px-4 py-3 text-sm dark:border-gray-800">
        {content.lanes.length === 0
          ? <span className="text-gray-500">Nothing from this account is hidden or restricted.</span>
          : content.lanes.map(({ lane, count }) => (
            <span key={laneKey(lane)} data-testid={`profile-moderation-lane-${laneKey(lane)}`} className="rounded-full bg-amber-50 px-3 py-1 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
              {laneLabel(lane)} · {count}{content.more ? '+' : ''}
            </span>
          ))}
        <Link href={HIDDEN_CONTENT_HREF} className="ml-auto text-yappr-600 hover:underline dark:text-yappr-400">All hidden &amp; restricted</Link>
      </div>
      {content.items.slice(0, shown).map((post) => (
        <PostCard key={post.id} post={post} enrichment={getPostEnrichment(post)} />
      ))}
      {content.items.length > shown && (
        <div className="flex justify-center p-4">
          <Button variant="outline" onClick={showMore}>Show more</Button>
        </div>
      )}
    </div>
  )
}
