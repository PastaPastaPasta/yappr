'use client'

import { CloudArrowDownIcon } from '@heroicons/react/24/outline'
import { cn } from '@/lib/utils'

/** Marks a digital product (storefront v6): delivered online, never shipped. */
export function DigitalBadge({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300', className)}>
      <CloudArrowDownIcon className="h-3.5 w-3.5" aria-hidden="true" />
      Digital
    </span>
  )
}
