'use client'

import type { ProofStatus, QueryRecord } from '@/lib/query-inspector/types'

const CHIPS: Record<ProofStatus | 'error', { label: string; className: string }> = {
  proven: {
    label: 'proven',
    className: 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10',
  },
  unavailable: {
    label: 'no proof',
    className: 'text-amber-600 dark:text-amber-400 bg-amber-500/10',
  },
  'proof-failed': {
    label: 'proof failed',
    className: 'text-red-600 dark:text-red-400 bg-red-500/10',
  },
  error: {
    label: 'error',
    className: 'text-red-600 dark:text-red-400 bg-red-500/10',
  },
}

/** Worst-news-first pill: a failed call outranks its proof state. */
export function ProofChip({ record }: { record: QueryRecord }) {
  const chip = CHIPS[record.status === 'error' ? 'error' : record.proofStatus]
  return (
    <span
      className={`shrink-0 rounded-full px-1.5 py-0.5 font-mono text-[10px] leading-none ${chip.className}`}
    >
      {chip.label}
    </span>
  )
}
