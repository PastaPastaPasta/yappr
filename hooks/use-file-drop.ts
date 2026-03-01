'use client'

import { useCallback, useState } from 'react'

interface UseFileDropOptions {
  /** When true, drag events are accepted but no file processing occurs */
  disabled?: boolean
  /** Called with the first dropped file */
  onDrop: (file: File) => void | Promise<void>
  /** Optional MIME type prefix filter, e.g. 'image/' */
  accept?: string
}

interface UseFileDropResult {
  /** Whether a drag is currently hovering over the drop zone */
  isDragging: boolean
  /** Spread these onto the drop-zone element */
  dropZoneProps: {
    onDrop: (e: React.DragEvent) => void
    onDragOver: (e: React.DragEvent) => void
    onDragEnter: (e: React.DragEvent) => void
    onDragLeave: (e: React.DragEvent) => void
  }
}

/**
 * Shared hook for file drag-and-drop zones.
 *
 * Encapsulates the boilerplate preventDefault/stopPropagation handling,
 * isDragging visual state, and disabled guards that were duplicated across
 * profile-image-upload, compose-post, and blog-editor.
 */
export function useFileDrop({ disabled, onDrop, accept }: UseFileDropOptions): UseFileDropResult {
  const [isDragging, setIsDragging] = useState(false)

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)

    if (disabled) return

    const file = e.dataTransfer.files[0]
    if (!file) return
    if (accept && !file.type.startsWith(accept)) return

    onDrop(file)
  }, [disabled, onDrop, accept])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }, [])

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (!disabled) setIsDragging(true)
  }, [disabled])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.currentTarget === e.target) setIsDragging(false)
  }, [])

  return {
    isDragging,
    dropZoneProps: {
      onDrop: handleDrop,
      onDragOver: handleDragOver,
      onDragEnter: handleDragEnter,
      onDragLeave: handleDragLeave,
    },
  }
}
