'use client'

import { useState, useEffect } from 'react'

/**
 * Hook to detect when the virtual keyboard is visible on mobile devices.
 * Uses the visualViewport API to detect viewport height changes that indicate
 * keyboard visibility.
 */
export function useKeyboardVisible(): boolean {
  const [isKeyboardVisible, setIsKeyboardVisible] = useState(false)

  useEffect(() => {
    // Only run on client-side
    if (typeof window === 'undefined') return

    const visualViewport = window.visualViewport
    if (!visualViewport) return

    // Threshold: if viewport height is less than 75% of window height, keyboard is likely open
    const KEYBOARD_THRESHOLD = 0.75

    const checkKeyboard = () => {
      const viewportHeight = visualViewport.height
      const windowHeight = window.innerHeight
      const ratio = viewportHeight / windowHeight

      setIsKeyboardVisible(ratio < KEYBOARD_THRESHOLD)
    }

    // Check initially
    checkKeyboard()

    // Listen for viewport changes
    visualViewport.addEventListener('resize', checkKeyboard)

    return () => {
      visualViewport.removeEventListener('resize', checkKeyboard)
    }
  }, [])

  return isKeyboardVisible
}
