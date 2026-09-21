'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { CurrencyDollarIcon } from '@heroicons/react/24/outline'
import { logger } from '@/lib/logger'
import { provedTipService, totalTipped, TIP_PAGE_SIZE, type ProvedTip } from '@/lib/services/proved-tip-service'
import type { TargetKind } from '@/lib/contract-topology'

interface PostTipsProps {
  /** The tipped post or reply. */
  targetId: string
  kind: TargetKind
}

/** A tipper we have no profile for: show enough of the identity to be checkable. */
function shortIdentity(identityId: string): string {
  return `${identityId.slice(0, 6)}…${identityId.slice(-4)}`
}

/**
 * The tips on one post, read straight off the `tip` documents.
 *
 * Every number here is a consensus fact: a tip document cites the YAPP transfer
 * that paid it, and the contract binds the amount, the sender and the payee to
 * that transfer (docs/SOCIAL_V9.md). There is nothing to caveat and nothing to
 * verify on read — a tip that could not be written is not here.
 *
 * Two DAPI requests, which is why this belongs to the detail view rather than a
 * feed card: one page of tips, and the count tree that says whether the page is
 * all of them.
 */
export function PostTips({ targetId, kind }: PostTipsProps) {
  const [tips, setTips] = useState<ProvedTip[] | null>(null)
  const [total, setTotal] = useState(0)
  const [names, setNames] = useState<Map<string, string>>(new Map())

  useEffect(() => {
    let active = true
    setTips(null)
    setNames(new Map())

    // The tips are the payload; the count and the tippers' names only decorate
    // them, so a failure in either must not erase tips that DID load.
    provedTipService
      .getTipsFor(kind, targetId)
      .then((loaded) => {
        if (!active) return
        setTips(loaded)
        setTotal(loaded.length)
        if (loaded.length === 0) return

        import('@/lib/services/unified-profile-service')
          .then(({ unifiedProfileService }) =>
            unifiedProfileService.getProfilesByIdentityIds(loaded.map((tip) => tip.from))
          )
          .then((profiles) => {
            if (active) setNames(new Map(profiles.map((profile) => [profile.$ownerId, profile.displayName])))
          })
          .catch((error) => logger.warn('PostTips: could not resolve tipper names', error))

        // Only worth asking once the page could be hiding something.
        if (loaded.length < TIP_PAGE_SIZE) return
        provedTipService
          .countTipsFor(kind, targetId)
          .then((count) => { if (active) setTotal(Math.max(count, loaded.length)) })
          .catch((error) => logger.warn('PostTips: could not read the tip count', error))
      })
      .catch((error) => {
        logger.warn('PostTips: could not load tips', error)
        if (active) setTips([])
      })
    return () => { active = false }
  }, [targetId, kind])

  if (!tips || tips.length === 0) return null

  const tippers = new Set(tips.map((tip) => tip.from)).size
  const showingAll = total <= tips.length

  return (
    <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-800">
      <div className="flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-400">
        <CurrencyDollarIcon className="h-4 w-4" aria-hidden="true" />
        <span>
          {showingAll
            ? `Tipped ${totalTipped(tips).toString()} YAPP by ${tippers} ${tippers === 1 ? 'person' : 'people'}`
            : `${total} tips — showing the newest ${tips.length}`}
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
          </li>
        ))}
      </ul>
    </div>
  )
}
