'use client'

import { motion } from 'framer-motion'
import { useQueryInspectorStore } from '@/lib/query-inspector/store'

/**
 * Collapsed inspector: a live-wire console pill in the bottom-right corner.
 * The LED pulses on every captured DAPI round-trip and the counters tell the
 * story at a glance — how many queries, how many cryptographically proven.
 */
export function InspectorPill() {
  const setPanelOpen = useQueryInspectorStore((s) => s.setPanelOpen)
  const paused = useQueryInspectorStore((s) => s.paused)
  const total = useQueryInspectorStore((s) => s.totalCaptured)
  const proven = useQueryInspectorStore((s) => s.provenCaptured)
  const lastMethod = useQueryInspectorStore((s) => s.lastMethod)

  const ledColor = paused ? 'bg-amber-500' : total > 0 ? 'bg-emerald-500' : 'bg-gray-400'

  return (
    <motion.button
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 8 }}
      onClick={() => setPanelOpen(true)}
      aria-label="Open query inspector"
      className="fixed bottom-20 md:bottom-4 right-4 z-[60] flex items-center gap-2.5 rounded-full border border-gray-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 pl-3 pr-4 py-2 shadow-lg hover:border-yappr-500/50 transition-colors"
    >
      <span className="relative flex h-2 w-2 shrink-0">
        {!paused && total > 0 && (
          <motion.span
            key={total}
            initial={{ scale: 1, opacity: 0.7 }}
            animate={{ scale: 2.75, opacity: 0 }}
            transition={{ duration: 0.6, ease: 'easeOut' }}
            className={`absolute inline-flex h-full w-full rounded-full ${ledColor}`}
          />
        )}
        <span className={`relative inline-flex h-2 w-2 rounded-full ${ledColor}`} />
      </span>
      <span className="flex flex-col items-start font-mono leading-tight">
        <span className="text-xs text-gray-900 dark:text-gray-100">
          {total} {total === 1 ? 'query' : 'queries'}
          <span className="text-gray-400 dark:text-gray-600"> · </span>
          <span className="text-emerald-600 dark:text-emerald-400">{proven} proven</span>
        </span>
        <span className="max-w-[160px] truncate text-[10px] text-gray-500">
          {paused ? 'paused' : lastMethod ?? 'watching DAPI…'}
        </span>
      </span>
    </motion.button>
  )
}
