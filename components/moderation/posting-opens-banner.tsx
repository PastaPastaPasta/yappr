'use client'

import { ClockIcon } from '@heroicons/react/24/outline'
import { usePostingOpening } from '@/hooks/use-posting-opening'
import { postingOpensText } from '@/lib/posting-opens'
import { cn } from '@/lib/utils'

/**
 * A slim "Posting opens on <date>" strip for Home, Explore and the landing
 * page while the social contract is closed (`notYetUsable` interim, no team
 * seated). The date is the chain's: the end of the contest for the seat. With
 * no charter filed there is no date, and it says what posting waits for.
 * Disappears on its own once a team is seated.
 *
 * It renders nothing until it knows (or remembers), and sits above the page's
 * sticky header, so it appears with the page's own loading state rather than
 * pushing a loaded feed. The compose, blog and store notices keep explaining
 * what stays closed.
 *
 * On a test network the network pill hangs from the top edge, over the middle
 * of this strip; the strip's top padding is the pill's height
 * (`--network-pill-height`, set while the pill is shown) so the text starts
 * below it, and falls back to the normal padding without one.
 */
export function PostingOpensBanner({ className }: { className?: string }) {
  const opening = usePostingOpening()
  const text = opening ? postingOpensText(opening) : null
  if (!text) return null
  return (
    <div
      role="status"
      data-testid="posting-opens-banner"
      className={cn(
        'flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-4 pb-2 pt-[var(--network-pill-height,0.5rem)] text-sm text-amber-800',
        'dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200',
        className
      )}
    >
      <ClockIcon className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
      <span>{text}</span>
    </div>
  )
}
