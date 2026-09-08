'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { logger } from '@/lib/logger'
import { useImageUpload } from '@/hooks/use-image-upload'
import type { UploadResult } from '@/lib/upload'

export interface AttachedImage {
  file: File
  /** Object URL for the preview; revoked when the image is dropped. */
  preview: string
  uploadResult?: UploadResult
}

const MAX_IMAGE_BYTES = 10 * 1024 * 1024

/**
 * The composer's single image attachment: pick or paste a file, upload it in
 * the background, keep the preview URL tidy. Attaching without a storage
 * provider opens the provider modal instead.
 */
export function useComposeImage(isOpen: boolean) {
  const { upload, isUploading, progress, isProviderConnected, checkProvider } = useImageUpload()
  const [attached, setAttached] = useState<AttachedImage | null>(null)
  const [showProviderModal, setShowProviderModal] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (isOpen) checkProvider().catch((err) => logger.error('Failed to check upload provider:', err))
  }, [isOpen, checkProvider])

  useEffect(() => {
    return () => {
      if (attached?.preview) URL.revokeObjectURL(attached.preview)
    }
  }, [attached?.preview])

  const attach = useCallback(
    (file: File) => {
      if (!file.type.startsWith('image/')) {
        toast.error('Only images are supported')
        return
      }
      if (file.size > MAX_IMAGE_BYTES) {
        toast.error('Image must be under 10MB')
        return
      }
      setAttached({ file, preview: URL.createObjectURL(file) })
      upload(file)
        .then((result) => setAttached((prev) => (prev && prev.file === file ? { ...prev, uploadResult: result } : prev)))
        .catch((err) => {
          logger.error('Failed to upload image:', err)
          toast.error('Failed to upload image')
        })
    },
    [upload]
  )

  const onFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      // Reset so the same file can be picked again.
      e.target.value = ''
      if (file) attach(file)
    },
    [attach]
  )

  const onPaste = useCallback(
    (e: React.ClipboardEvent) => {
      const item = Array.from(e.clipboardData?.items ?? []).find((i) => i.type.startsWith('image/'))
      if (!item) return
      if (attached) {
        toast.error('Only one image can be attached per post')
        return
      }
      if (!isProviderConnected) {
        setShowProviderModal(true)
        return
      }
      const file = item.getAsFile()
      if (!file) return
      // Otherwise the browser pastes a data URL into the textarea.
      e.preventDefault()
      attach(file)
    },
    [attached, isProviderConnected, attach]
  )

  const openPicker = useCallback(() => {
    if (!isProviderConnected) {
      setShowProviderModal(true)
      return
    }
    fileInputRef.current?.click()
  }, [isProviderConnected])

  // The preview-URL effect above revokes the object URL on change.
  const remove = useCallback(() => setAttached(null), [])

  /** Upload now if the attachment has not finished uploading; returns the URL, or null when nothing is attached. */
  const ensureUploaded = useCallback(async (): Promise<string | null> => {
    if (!attached) return null
    if (attached.uploadResult) return attached.uploadResult.url
    const result = await upload(attached.file)
    setAttached((prev) => (prev ? { ...prev, uploadResult: result } : null))
    return result.url
  }, [attached, upload])

  return {
    attached,
    isUploading,
    progress,
    fileInputRef,
    showProviderModal,
    setShowProviderModal,
    onFileSelect,
    onPaste,
    openPicker,
    remove,
    ensureUploaded,
  }
}
