'use client'

import { useCallback } from 'react'
import toast from 'react-hot-toast'
import { logger } from '@/lib/logger'

/** Copy text to the clipboard with toast feedback. */
export function useCopy() {
  return useCallback((text: string, label = 'Copied to clipboard') => {
    navigator.clipboard
      .writeText(text)
      .then(() => toast.success(label))
      .catch((error) => {
        logger.error('Failed to copy to clipboard:', error)
        toast.error('Copy failed')
      })
  }, [])
}
