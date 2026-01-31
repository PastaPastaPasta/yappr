'use client'

import { useState, useEffect } from 'react'

/**
 * Hook to detect when the virtual keyboard is likely visible on mobile devices.
 * Uses focus detection on input elements - when any text input is focused,
 * we assume the keyboard is visible on mobile.
 */
export function useKeyboardVisible(): boolean {
  const [isKeyboardVisible, setIsKeyboardVisible] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined') return

    const isTextInput = (el: Element | null): boolean => {
      if (!el) return false
      const tagName = el.tagName.toUpperCase()
      if (tagName === 'TEXTAREA') return true
      if (tagName === 'INPUT') {
        const type = (el as HTMLInputElement).type?.toLowerCase()
        // Only text-like inputs trigger keyboard
        return !type || ['text', 'email', 'password', 'search', 'tel', 'url', 'number'].includes(type)
      }
      if ((el as HTMLElement).isContentEditable) return true
      return false
    }

    const handleFocusIn = (e: FocusEvent) => {
      if (isTextInput(e.target as Element)) {
        setIsKeyboardVisible(true)
      }
    }

    const handleFocusOut = () => {
      // Small delay to handle focus moving between inputs
      setTimeout(() => {
        if (!isTextInput(document.activeElement)) {
          setIsKeyboardVisible(false)
        }
      }, 100)
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
