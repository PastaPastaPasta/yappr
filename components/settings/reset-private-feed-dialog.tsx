'use client'

import * as Dialog from '@radix-ui/react-dialog'
import { Modal, ModalTitle } from '@/components/ui/modal'
import { Button } from '@/components/ui/button'
import { KeyIcon, XMarkIcon } from '@heroicons/react/24/outline'

interface ResetPrivateFeedDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** Explain recovery without offering an unsupported destructive reset. */
export function ResetPrivateFeedDialog({ open, onOpenChange }: ResetPrivateFeedDialogProps) {
  return (
    <Modal open={open} onOpenChange={onOpenChange} className="w-[500px] max-w-[90vw] max-h-[90vh] overflow-y-auto">
      <button
        type="button"
        onClick={() => onOpenChange(false)}
        aria-label="Close"
        className="absolute top-4 right-4 p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors"
      >
        <XMarkIcon className="h-5 w-5" />
      </button>
      <ModalTitle>
        <KeyIcon className="h-6 w-6" />
        Private Feed Recovery
      </ModalTitle>
      <Dialog.Description className="text-sm text-gray-600 dark:text-gray-400 mb-4">
        Reset is unavailable for your existing private feed. Your feed and followers are preserved.
      </Dialog.Description>
      <div className="space-y-3 text-sm text-gray-700 dark:text-gray-300">
        <p>Use your original encryption key to recover access. Check your password manager, secure notes, or another device where you saved it.</p>
        <p>If that key is permanently lost, resetting the feed cannot recover your existing private posts.</p>
      </div>
      <div className="flex justify-end mt-6">
        <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
      </div>
    </Modal>
  )
}
