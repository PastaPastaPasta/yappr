import { useCallback, useRef, type KeyboardEvent } from 'react'

/**
 * Keyboard model for a horizontal WAI-ARIA tablist: ArrowLeft/ArrowRight move
 * between tabs (wrapping), Home/End jump to the first/last, and focus follows
 * selection. Pair it with roving tabIndex (0 on the selected tab, -1 on the
 * rest). Attach `listRef` and `onKeyDown` to the `role="tablist"` element.
 *
 * With `manualActivation` the arrow keys, Home and End only move focus, from
 * wherever focus is now; Enter or Space (a button's own click) selects. Use it
 * when selecting a tab is costly, such as a reload.
 */
export function useTabKeyboard<K extends string>({
  keys,
  active,
  onSelect,
  manualActivation = false,
}: {
  keys: readonly K[]
  active: K
  onSelect: (key: K) => void
  manualActivation?: boolean
}) {
  const listRef = useRef<HTMLDivElement>(null)

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      if (keys.length === 0) return
      const tabs = listRef.current?.querySelectorAll<HTMLElement>('[role="tab"]')
      const focused = manualActivation && tabs ? Array.prototype.indexOf.call(tabs, document.activeElement) : -1
      const current = focused >= 0 ? focused : keys.indexOf(active)
      let next: number
      switch (event.key) {
        case 'ArrowRight':
          next = (current + 1) % keys.length
          break
        case 'ArrowLeft':
          next = current < 0 ? keys.length - 1 : (current - 1 + keys.length) % keys.length
          break
        case 'Home':
          next = 0
          break
        case 'End':
          next = keys.length - 1
          break
        default:
          return
      }
      event.preventDefault()
      // Focusing scrolls the tab into view within its bar.
      tabs?.[next]?.focus()
      if (!manualActivation && keys[next] !== active) onSelect(keys[next])
    },
    [keys, active, onSelect, manualActivation],
  )

  return { listRef, onKeyDown }
}
