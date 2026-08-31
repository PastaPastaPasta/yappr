'use client'

import type { QueryRecord } from '@/lib/query-inspector/types'
import { ProofChip } from './proof-chip'

/** Best-effort short context from the query params, e.g. the document type. */
function paramHint(record: QueryRecord): string | null {
  const params = record.params
  if (params && typeof params === 'object' && !Array.isArray(params)) {
    const obj = params as Record<string, unknown>
    if (typeof obj.documentTypeName === 'string') return obj.documentTypeName
    if (typeof obj.type === 'string') return obj.type
  }
  if (typeof params === 'string') {
    return params.length > 24 ? `${params.slice(0, 24)}…` : params
  }
  return null
}

function formatClock(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('en-US', { hour12: false })
}

export function EntryRow({ record, onSelect }: { record: QueryRecord; onSelect: () => void }) {
  const hint = paramHint(record)
  return (
    <button
      onClick={onSelect}
      className="block w-full px-4 py-2 text-left hover:bg-gray-50 dark:hover:bg-neutral-900 transition-colors"
    >
      <div className="flex items-center gap-2">
        <span className="shrink-0 font-mono text-xs font-medium text-gray-900 dark:text-gray-100">
          {record.method}
        </span>
        {hint && (
          <span className="truncate font-mono text-[11px] text-yappr-600 dark:text-yappr-400">
            {hint}
          </span>
        )}
        <span className="flex-1" />
        <ProofChip record={record} />
      </div>
      <div className="mt-0.5 flex items-baseline gap-2 font-mono text-[10px] text-gray-500">
        <span className="shrink-0">{Math.round(record.durationMs)}ms</span>
        <span className="truncate">
          {record.status === 'error' ? record.error : record.resultSummary}
        </span>
        <span className="ml-auto shrink-0 text-gray-400 dark:text-gray-600">
          {formatClock(record.timestamp)}
        </span>
      </div>
    </button>
  )
}
