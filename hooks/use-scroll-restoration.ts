import { useEffect, useRef } from 'react'

const SCROLL_POSITION_PREFIX = 'scroll-pos:'

/**
 * Save current scroll position to sessionStorage.
 * Call this before navigating away from a list page.
 */
export function saveScrollPosition(key: string) {
  const storageKey = `${SCROLL_POSITION_PREFIX}${key}`
  sessionStorage.setItem(storageKey, String(window.scrollY))
}

/**
 * Hook to restore scroll position for list pages after back navigation.
 *
 * Reads the saved scroll position from sessionStorage and restores it
 * once the page content is ready (dataReady=true). The saved position
 * is cleared after restoration to prevent stale restores on refresh.
 *
 * Pair with saveScrollPosition() called before navigating away.
 */
export function useScrollRestoration(key: string, dataReady: boolean) {
  const restoredRef = useRef(false)

  // Reset when key changes (e.g., tab switch on the feed page)
  useEffect(() => {
    restoredRef.current = false
  }, [key])

  useEffect(() => {
    if (!dataReady || restoredRef.current) return

    restoredRef.current = true

    const storageKey = `${SCROLL_POSITION_PREFIX}${key}`
    const saved = sessionStorage.getItem(storageKey)

    if (saved) {
      const scrollY = parseInt(saved, 10)
      sessionStorage.removeItem(storageKey)

      // Wait for the DOM to paint the loaded content before scrolling
      requestAnimationFrame(() => {
        window.scrollTo(0, scrollY)
      })
    }
  }, [key, dataReady])
}
