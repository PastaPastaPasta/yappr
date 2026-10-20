'use client'

import { useEffect, useId, useRef, type ReactNode } from 'react'
import { useTabKeyboard } from '@/hooks/use-tab-keyboard'

export interface ScrollTab<K extends string> {
  key: K
  label: ReactNode
  /** Small unread dot beside the label. */
  dot?: boolean
  testId?: string
}

/** The DOM id of a tab, so a `role="tabpanel"` can point `aria-labelledby` at it. */
export function scrollTabId(panelId: string, key: string): string {
  return `${panelId}-tab-${key}`
}

/**
 * An underline tab bar that fills the row when the tabs fit and scrolls
 * sideways when they don't, keeping the active tab in view (X and Bluesky
 * do the same on narrow screens).
 */
export function ScrollTabs<K extends string>({
  tabs,
  active,
  onSelect,
  testIdPrefix,
  ariaLabel,
  panelId,
}: {
  tabs: ScrollTab<K>[]
  active: K
  onSelect: (key: K) => void
  /** Buttons render as `${testIdPrefix}-${key}` unless the tab names its own. */
  testIdPrefix?: string
  ariaLabel?: string
  /**
   * The id of the tabpanel these tabs control. The caller gives that element
   * `role="tabpanel"`, this id and `aria-labelledby={scrollTabId(panelId, active)}`.
   */
  panelId?: string
}) {
  const generatedId = useId()
  const idBase = panelId ?? generatedId
  const activeRef = useRef<HTMLButtonElement>(null)
  const { listRef, onKeyDown } = useTabKeyboard({ keys: tabs.map((tab) => tab.key), active, onSelect })

  useEffect(() => {
    const bar = listRef.current
    const tab = activeRef.current
    if (!bar || !tab) return
    // Scroll only the bar, never the page.
    const left = tab.offsetLeft
    const right = left + tab.offsetWidth
    if (left < bar.scrollLeft) {
      bar.scrollTo({ left: Math.max(0, left - 24), behavior: 'smooth' })
    } else if (right > bar.scrollLeft + bar.clientWidth) {
      bar.scrollTo({ left: right - bar.clientWidth + 24, behavior: 'smooth' })
    }
  }, [active, listRef])

  return (
    <div
      ref={listRef}
      onKeyDown={onKeyDown}
      role="tablist"
      aria-label={ariaLabel}
      className="relative flex overflow-x-auto scrollbar-hide border-b border-gray-200 dark:border-gray-800"
    >
      {tabs.map((tab) => {
        const selected = tab.key === active
        return (
          <button
            key={tab.key}
            ref={selected ? activeRef : undefined}
            id={scrollTabId(idBase, tab.key)}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={panelId}
            tabIndex={selected ? 0 : -1}
            data-testid={tab.testId ?? (testIdPrefix ? `${testIdPrefix}-${tab.key}` : undefined)}
            onClick={() => onSelect(tab.key)}
            className={`relative flex-1 min-w-max px-4 py-3.5 text-sm font-semibold whitespace-nowrap transition-colors hover:bg-gray-50 dark:hover:bg-gray-900/50 ${
              selected ? 'text-foreground' : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
            }`}
          >
            <span className="relative">
              {tab.label}
              {tab.dot && (
                <>
                  <span aria-hidden className="absolute -right-2.5 top-0 h-1.5 w-1.5 rounded-full bg-yappr-500" />
                  <span className="sr-only"> (unread)</span>
                </>
              )}
            </span>
            {selected && <span className="absolute bottom-0 inset-x-3 h-[3px] rounded-full bg-yappr-500" />}
          </button>
        )
      })}
    </div>
  )
}
