'use client'

import type { ReactNode } from 'react'
import { XMarkIcon } from '@heroicons/react/24/outline'

interface ImageCustomizationModalProps {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
}

/** The plain overlay + wide panel the avatar and banner editors sit in. */
export function ImageCustomizationModal({ open, title, onClose, children }: ImageCustomizationModalProps) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-white dark:bg-neutral-900 rounded-xl p-6 max-w-2xl w-full mx-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold">{title}</h2>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full" aria-label="Close">
            <XMarkIcon className="w-5 h-5" />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}
