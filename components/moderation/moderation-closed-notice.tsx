'use client'

import { ClockIcon } from '@heroicons/react/24/outline'
import { MODERATION_CLOSED_COPY, type ModerationClosedProduct } from '@/lib/error-utils'
import { cn } from '@/lib/utils'
import { useModeratedTypeOpen } from '@/hooks/use-moderated-type-open'

/**
 * Says, before anyone tries, that a product is closed until its first
 * moderators are elected (a `notYetUsable` interim with no team seated: every
 * write of its moderated types is refused, 41200). Render it only while
 * `useModeratedTypeOpen(…, contract)` answers false; it lifts on its own once
 * a team is seated.
 */
export function ModerationClosedNotice({ product, className }: { product: ModerationClosedProduct; className?: string }) {
  return (
    <div
      role="status"
      data-testid={`moderation-closed-${product}`}
      className={cn(
        'flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800',
        'dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200',
        className
      )}
    >
      <ClockIcon className="h-5 w-5 flex-shrink-0" aria-hidden="true" />
      <span>{MODERATION_CLOSED_COPY[product]}</span>
    </div>
  )
}

/**
 * {@link ModerationClosedNotice}, shown only while `docType` on the product's
 * contract is closed: for a page that announces it without gating a write of
 * its own (a product's home or dashboard).
 */
export function ModerationClosedBanner({ product, docType, className }: { product: ModerationClosedProduct; docType: string; className?: string }) {
  const open = useModeratedTypeOpen(docType, true, product)
  return open ? null : <ModerationClosedNotice product={product} className={className} />
}
