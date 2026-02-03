'use client'

import { XMarkIcon } from '@heroicons/react/24/solid'
import { motion } from 'framer-motion'
import { AlertTriangle } from 'lucide-react'
import { useNsfwDetection } from '@/hooks/use-nsfw-detection'

interface ImageAttachmentProps {
  /** Object URL for preview */
  previewUrl: string
  /** Whether the image is currently uploading */
  isUploading?: boolean
  /** Whether the image has been uploaded */
  isUploaded?: boolean
  /** Called when the remove button is clicked */
  onRemove: () => void
  /** Upload progress (0-100) */
  progress?: number
}

/**
 * Image attachment preview component for the compose modal.
 * Shows the image with a remove button and optional upload progress overlay.
 */
export function ImageAttachment({
  previewUrl,
  isUploading = false,
  isUploaded = false,
  onRemove,
  progress = 0,
}: ImageAttachmentProps) {
  const { isNsfw } = useNsfwDetection(previewUrl)

  return (
    <div>
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="relative mt-3 rounded-xl overflow-hidden border border-gray-200 dark:border-gray-700"
      >
        {/* Preview image */}
        <img
          src={previewUrl}
          alt="Attachment preview"
          className={`max-h-64 w-auto mx-auto object-contain ${isUploading ? 'opacity-50' : ''}`}
        />

        {/* Remove button */}
        {!isUploading && (
          <button
            type="button"
            onClick={onRemove}
            className="absolute top-2 right-2 p-1.5 bg-black/60 hover:bg-black/80 rounded-full text-white transition-colors"
            title="Remove image"
          >
            <XMarkIcon className="w-4 h-4" />
          </button>
        )}

        {/* Upload progress overlay */}
        {isUploading && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/40">
            <div className="text-center text-white">
              <div className="w-16 h-16 mb-2 mx-auto">
                <svg className="w-full h-full -rotate-90" viewBox="0 0 36 36">
                  {/* Background circle */}
                  <circle
                    cx="18"
                    cy="18"
                    r="16"
                    fill="none"
                    stroke="rgba(255,255,255,0.3)"
                    strokeWidth="3"
                  />
                  {/* Progress circle */}
                  <circle
                    cx="18"
                    cy="18"
                    r="16"
                    fill="none"
                    stroke="white"
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeDasharray={`${progress}, 100`}
                    className="transition-all duration-300"
                  />
                </svg>
              </div>
              <span className="text-sm font-medium">{progress}%</span>
            </div>
          </div>
        )}

        {/* Uploaded indicator */}
        {isUploaded && !isUploading && (
          <div className="absolute bottom-2 left-2 flex items-center gap-1 px-2 py-1 bg-green-500/90 rounded-full text-white text-xs font-medium">
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
            Uploaded
          </div>
        )}
      </motion.div>

      {/* NSFW warning banner */}
      {isNsfw && (
        <div className="mt-2 flex items-start gap-2 px-3 py-2 rounded-lg bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800">
          <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-medium text-amber-800 dark:text-amber-200">
              This image may be sensitive
            </p>
            <p className="text-xs text-amber-700 dark:text-amber-300 mt-0.5">
              Users with content filtering enabled may not see this image.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
