'use client'

import { useMemo } from 'react'
import { motion } from 'framer-motion'
import { PauseIcon, PlayIcon, TrashIcon, XMarkIcon } from '@heroicons/react/24/outline'
import { useQueryInspectorStore, type FacadeFilter } from '@/lib/query-inspector/store'
import { EntryRow } from './entry-row'
import { EntryDetail } from './entry-detail'
import { PanelIconButton } from './panel-icon-button'

export function InspectorPanel() {
  const entries = useQueryInspectorStore((s) => s.entries)
  const total = useQueryInspectorStore((s) => s.totalCaptured)
  const proven = useQueryInspectorStore((s) => s.provenCaptured)
  const latestHeight = useQueryInspectorStore((s) => s.latestHeight)
  const latestEpoch = useQueryInspectorStore((s) => s.latestEpoch)
  const paused = useQueryInspectorStore((s) => s.paused)
  const setPaused = useQueryInspectorStore((s) => s.setPaused)
  const clear = useQueryInspectorStore((s) => s.clear)
  const setPanelOpen = useQueryInspectorStore((s) => s.setPanelOpen)
  const selectedId = useQueryInspectorStore((s) => s.selectedId)
  const setSelectedId = useQueryInspectorStore((s) => s.setSelectedId)
  const facadeFilter = useQueryInspectorStore((s) => s.facadeFilter)
  const setFacadeFilter = useQueryInspectorStore((s) => s.setFacadeFilter)

  const filterChips = useMemo(() => {
    const facades = Array.from(new Set(entries.map((e) => e.facade))).sort()
    const chips: FacadeFilter[] = ['all', ...facades]
    if (entries.some((e) => e.kind === 'write')) chips.push('writes')
    return chips
  }, [entries])

  const filtered = useMemo(() => {
    if (facadeFilter === 'all') return entries
    if (facadeFilter === 'writes') return entries.filter((e) => e.kind === 'write')
    return entries.filter((e) => e.facade === facadeFilter)
  }, [entries, facadeFilter])

  const selected = selectedId ? entries.find((e) => e.id === selectedId) : undefined

  return (
    <motion.aside
      initial={{ x: '100%' }}
      animate={{ x: 0 }}
      exit={{ x: '100%' }}
      transition={{ type: 'tween', duration: 0.2, ease: 'easeOut' }}
      className="fixed right-0 top-[32px] sm:top-[40px] bottom-0 z-[60] flex w-full flex-col border-l border-gray-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 shadow-2xl sm:w-[480px]"
      aria-label="Query inspector"
    >
      <header className="shrink-0 border-b border-gray-200 dark:border-neutral-800">
        <div className="flex items-center justify-between px-4 pt-3 pb-2">
          <div>
            <h2 className="text-sm font-bold">Query inspector</h2>
            <p className="font-mono text-[10px] text-gray-500">
              every DAPI call, proven against Platform
            </p>
          </div>
          <div className="flex items-center gap-1">
            <PanelIconButton
              onClick={() => setPaused(!paused)}
              label={paused ? 'Resume capture' : 'Pause capture'}
            >
              {paused ? <PlayIcon className="h-4 w-4" /> : <PauseIcon className="h-4 w-4" />}
            </PanelIconButton>
            <PanelIconButton onClick={clear} label="Clear captured queries">
              <TrashIcon className="h-4 w-4" />
            </PanelIconButton>
            <PanelIconButton onClick={() => setPanelOpen(false)} label="Close query inspector">
              <XMarkIcon className="h-4 w-4" />
            </PanelIconButton>
          </div>
        </div>
        <div className="flex flex-wrap gap-x-3 px-4 pb-2 font-mono text-[11px] text-gray-500">
          <span>
            {total} {total === 1 ? 'query' : 'queries'}
          </span>
          <span className="text-emerald-600 dark:text-emerald-400">{proven} proven</span>
          {latestHeight && <span>height {latestHeight}</span>}
          {latestEpoch !== null && <span>epoch {latestEpoch}</span>}
          {paused && <span className="text-amber-600 dark:text-amber-400">paused</span>}
        </div>
        {!selected && (
          <div className="flex gap-1.5 overflow-x-auto scrollbar-hide px-4 pb-3">
            {filterChips.map((chip) => (
              <button
                key={chip}
                onClick={() => setFacadeFilter(chip)}
                className={`shrink-0 rounded-full border px-2.5 py-0.5 font-mono text-[10px] transition-colors ${
                  facadeFilter === chip
                    ? 'border-yappr-500 bg-yappr-500/10 text-yappr-600 dark:text-yappr-400'
                    : 'border-gray-200 dark:border-neutral-800 text-gray-500 hover:border-gray-300 dark:hover:border-neutral-700'
                }`}
              >
                {chip}
              </button>
            ))}
          </div>
        )}
      </header>

      {selected ? (
        <EntryDetail record={selected} onBack={() => setSelectedId(null)} />
      ) : (
        <div className="flex-1 overflow-y-auto divide-y divide-gray-100 dark:divide-neutral-900">
          {filtered.length === 0 ? (
            <div className="px-6 py-16 text-center">
              <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
                No queries captured yet
              </p>
              <p className="mt-1 text-xs text-gray-500">
                Browse the app — every Dash Platform request will appear here as it happens.
              </p>
            </div>
          ) : (
            filtered.map((record) => (
              <EntryRow
                key={record.id}
                record={record}
                onSelect={() => setSelectedId(record.id)}
              />
            ))
          )}
        </div>
      )}
    </motion.aside>
  )
}
