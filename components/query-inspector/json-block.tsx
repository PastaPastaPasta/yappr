'use client'

import { useMemo } from 'react'
import { DocumentDuplicateIcon } from '@heroicons/react/24/outline'
import { useCopy } from '@/hooks/use-copy'

/** Pretty-printed JSON with a copy button. Values are already plain data. */
export function JsonBlock({ value }: { value: unknown }) {
  const copy = useCopy()
  const text = useMemo(() => {
    try {
      return JSON.stringify(value ?? null, null, 2)
    } catch {
      return String(value)
    }
  }, [value])

  return (
    <div className="relative group">
      <button
        onClick={() => copy(text)}
        className="absolute top-2 right-2 p-1.5 rounded-md bg-white/80 dark:bg-neutral-900/80 border border-gray-200 dark:border-neutral-800 text-gray-500 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
        aria-label="Copy JSON"
      >
        <DocumentDuplicateIcon className="h-4 w-4" />
      </button>
      <pre
        className="overflow-auto max-h-full rounded-lg border border-gray-200 dark:border-neutral-800 bg-gray-50 dark:bg-neutral-900 p-3 font-mono text-[11px] leading-relaxed text-gray-800 dark:text-gray-200 whitespace-pre-wrap break-all"
      >
        {text}
      </pre>
    </div>
  )
}
