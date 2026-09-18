'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { CurrencyDollarIcon } from '@heroicons/react/24/outline'
import { logger } from '@/lib/logger'
import { useAuth } from '@/contexts/auth-context'
import { tipHistoryService, totalTipped, TIP_PAGE_LIMIT, type ProvedTip } from '@/lib/services/tip-history-service'

interface PostTipsProps {
  postId: string
  authorId: string
}

/** A tipper we have no profile for: show enough of the identity to be checkable. */
function shortIdentity(identityId: string): string {
  return `${identityId.slice(0, 6)}…${identityId.slice(-4)}`
}

/**
 * Tips on one post, read back from the token-history contract.
 *
 * Deliberately NOT rendered on feed cards: this costs a DAPI request per post,
 * so it belongs to the detail view where the user asked for this post.
 * Nothing renders until at least one proved transfer names the post — there is
 * no "0 tips" state and no self-reported number to fall back to.
 *
 * Tip notes are permanent, immutable and written by whoever paid the minimum
 * tip, so the note is attacker-controlled text on someone else's post. Amounts
 * from blocked identities still count (the transfer happened, and hiding it
 * would make the total wrong), but their notes are not rendered.
 */
export function PostTips({ postId, authorId }: PostTipsProps) {
  const { user } = useAuth()
  const viewerId = user?.identityId
  const [tips, setTips] = useState<ProvedTip[] | null>(null)
  const [names, setNames] = useState<Map<string, string>>(new Map())
  const [blocked, setBlocked] = useState<Set<string>>(new Set())

  useEffect(() => {
    let active = true
    setTips(null)
    setNames(new Map())
    setBlocked(new Set())
    tipHistoryService
      .getTipsForPost(postId, authorId)
      .then(async (result) => {
        if (!active) return
        setTips(result)
        if (result.length === 0) return
        const senders = result.map((tip) => tip.from)

        const { unifiedProfileService } = await import('@/lib/services/unified-profile-service')
        const profiles = await unifiedProfileService.getProfilesByIdentityIds(senders)
        if (!active) return
        setNames(new Map(profiles.map((profile) => [profile.$ownerId, profile.displayName])))

        if (!viewerId) return
        const { blockService } = await import('@/lib/services/block-service')
        const statuses = await blockService.checkBlockedBatch(viewerId, senders)
        if (!active) return
        setBlocked(new Set([...statuses].filter(([, isBlocked]) => isBlocked).map(([id]) => id)))
      })
      .catch((error) => {
        logger.warn('PostTips: could not load tips', error)
        if (active) setTips([])
      })
    return () => { active = false }
  }, [postId, authorId, viewerId])

  if (!tips || tips.length === 0) return null

  const tippers = new Set(tips.map((tip) => tip.from)).size

  return (
    <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-800">
      <div className="flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-400">
        <CurrencyDollarIcon className="h-4 w-4" aria-hidden="true" />
        <span>
          Tipped {totalTipped(tips).toString()} YAPP by {tippers} {tippers === 1 ? 'person' : 'people'}
        </span>
      </div>
      <ul className="mt-2 space-y-1">
        {tips.map((tip) => (
          <li key={tip.id} className="text-sm text-gray-600 dark:text-gray-400">
            <span className="font-medium text-gray-900 dark:text-gray-100">{tip.amount.toString()} YAPP</span>
            {' from '}
            <Link href={`/user?id=${tip.from}`} className="hover:underline">
              {names.get(tip.from) || shortIdentity(tip.from)}
            </Link>
            {tip.message && !blocked.has(tip.from) && (
              <span className="block text-gray-500">{tip.message}</span>
            )}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-gray-500">
        Each line is a signed YAPP transfer recorded on Dash Platform: the amount and the sender are proved. That a
        transfer was meant for this post is the sender&apos;s own note. Read from the author&apos;s last {TIP_PAGE_LIMIT}{' '}
        incoming transfers.
      </p>
    </div>
  )
}
