import { useState, useEffect } from 'react'

/**
 * Detects whether the user is on a Mac platform for keyboard shortcut hints.
 * Returns true for Mac/iOS devices, false for others.
 */
export function usePlatformDetection(): boolean {
  const [isMac, setIsMac] = useState(true) // Default to Mac symbol

  useEffect(() => {
    setIsMac(
      typeof navigator !== 'undefined' &&
        /Mac|iPod|iPhone|iPad/.test(navigator.platform)
    )
  }, [])

  return isMac
}
