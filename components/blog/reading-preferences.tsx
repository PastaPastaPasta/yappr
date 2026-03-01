'use client'

import * as Popover from '@radix-ui/react-popover'
import { useState } from 'react'
import { useReaderPreferencesStore } from '@/lib/store'
import type { ReadingMode, FontSizeLevel } from '@/lib/blog/reader-preferences'

const FONT_SIZES: { level: FontSizeLevel; label: string }[] = [
  { level: 'small', label: 'A' },
  { level: 'medium', label: 'A' },
  { level: 'large', label: 'A' },
  { level: 'xlarge', label: 'A' },
]

const READING_MODES: { mode: ReadingMode; label: string; swatch: string }[] = [
  { mode: 'author', label: 'Author', swatch: 'bg-gradient-to-br from-purple-500 to-blue-500' },
  { mode: 'light', label: 'Light', swatch: 'bg-white border border-gray-300' },
  { mode: 'dark', label: 'Dark', swatch: 'bg-neutral-900 border border-gray-600' },
  { mode: 'sepia', label: 'Sepia', swatch: 'bg-[#faf4e8] border border-[#d7cbb8]' },
]

export function ReadingPreferencesPopover() {
  const [open, setOpen] = useState(false)
  const { readingMode, fontSize, setReadingMode, setFontSize, resetPreferences } =
    useReaderPreferencesStore()

  const isDefault = readingMode === 'author' && fontSize === 'medium'

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          title="Reading preferences"
          aria-label="Reading preferences"
          aria-expanded={open}
          className="rounded-full border border-gray-300 px-3 py-1 text-xs font-medium text-gray-700 transition hover:bg-gray-100 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-900"
        >
          Aa
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="end"
          sideOffset={8}
          className="z-[100] w-[220px] animate-in fade-in-0 zoom-in-95 rounded-xl border border-gray-800 bg-neutral-900 p-3 shadow-lg"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          {/* Font size */}
          <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-gray-400">
            Font size
          </p>
          <div className="mb-3 grid grid-cols-4 gap-1.5">
            {FONT_SIZES.map(({ level, label }, i) => (
              <button
                key={level}
                type="button"
                onClick={() => setFontSize(level)}
                className={`rounded-lg py-1.5 text-center transition ${
                  fontSize === level
                    ? 'bg-blue-600 text-white'
                    : 'bg-neutral-800 text-gray-300 hover:bg-neutral-700'
                }`}
                style={{ fontSize: `${12 + i * 3}px` }}
                title={level}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Reading mode */}
          <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-gray-400">
            Reading mode
          </p>
          <div className="mb-3 grid grid-cols-4 gap-1.5">
            {READING_MODES.map(({ mode, label, swatch }) => (
              <button
                key={mode}
                type="button"
                onClick={() => setReadingMode(mode)}
                className={`flex flex-col items-center gap-1 rounded-lg p-1.5 transition ${
                  readingMode === mode
                    ? 'ring-2 ring-blue-500'
                    : 'hover:bg-neutral-800'
                }`}
                title={label}
              >
                <span className={`h-5 w-5 rounded-full ${swatch}`} />
                <span className="text-[10px] text-gray-400">{label}</span>
              </button>
            ))}
          </div>

          {/* Reset */}
          {!isDefault && (
            <button
              type="button"
              onClick={resetPreferences}
              className="w-full text-center text-xs text-gray-500 hover:text-gray-300 transition"
            >
              Reset to defaults
            </button>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
