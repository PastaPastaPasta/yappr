'use client'

import { useRef, type ReactNode } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { XMarkIcon } from '@heroicons/react/24/outline'

interface ImageCustomizationModalProps {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
}

/** Accessible shared dialog for the avatar and banner editors. */
export function ImageCustomizationModal({ open, title, onClose, children }: ImageCustomizationModalProps) {
  const opener = useRef<HTMLElement | null>(null)
  if (!open) return null
  return (
    <Dialog.Root open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <div className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none">
          <Dialog.Content
            onOpenAutoFocus={() => {
              opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
            }}
            onCloseAutoFocus={(event) => {
              if (opener.current?.getClientRects().length) {
                event.preventDefault()
                opener.current.focus()
              }
            }}
            className="relative bg-white dark:bg-neutral-900 rounded-xl p-6 max-w-2xl w-full mx-4 max-h-[90vh] overflow-y-auto pointer-events-auto"
          >
            <div className="flex items-center justify-between mb-4">
              <Dialog.Title className="text-lg font-bold">{title}</Dialog.Title>
              <Dialog.Description className="sr-only">Adjust your image, then save changes to update your profile.</Dialog.Description>
              <Dialog.Close asChild>
                <button type="button" className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full" aria-label="Close">
                  <XMarkIcon className="w-5 h-5" />
                </button>
              </Dialog.Close>
            </div>
            {children}
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
