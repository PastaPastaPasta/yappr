'use client'

import { useState, useEffect } from 'react'

/**
 * Hook to detect when the virtual keyboard is likely visible on mobile devices.
 * Uses focus detection on input elements, which is more reliable than
 * visualViewport API across different mobile browsers (especially iOS).
 */
export function useKeyboardVisible(): boolean {
  const [isKeyboardVisible, setIsKeyboardVisible] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined') return

    // Check if we're on a mobile device
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent)
    if (!isMobile) return

    const handleFocusIn = (e: FocusEvent) => {
      const target = e.target as HTMLElement
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      ) {
        setIsKeyboardVisible(true)
      }
    }

    const handleFocusOut = (e: FocusEvent) => {
      const target = e.target as HTMLElement
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      ) {
        // Small delay to handle focus moving between inputs
        setTimeout(() => {
          const activeElement = document.activeElement as HTMLElement
          if (
            activeElement?.tagName !== 'INPUT' &&
            activeElement?.tagName !== 'TEXTAREA' &&
            !activeElement?.isContentEditable
          ) {
            setIsKeyboardVisible(false)
          }
        }, 100)
      }
    }

    document.addEventListener('focusin', handleFocusIn)
    document.addEventListener('focusout', handleFocusOut)

    return () => {
      document.removeEventListener('focusin', handleFocusIn)
      document.removeEventListener('focusout', handleFocusOut)
    }
  }, [])

  return isKeyboardVisible
}
