'use client'

import { logger } from '@/lib/logger';
import * as Dialog from '@radix-ui/react-dialog'
import { Modal, ModalTitle } from '@/components/ui/modal'
import { XMarkIcon, TrashIcon } from '@heroicons/react/24/outline'
import { Button } from '@/components/ui/button'
import { useDeleteConfirmationModal } from '@/hooks/use-delete-confirmation-modal'
import { targetKindOf } from '@/lib/contract-topology'

export function DeleteConfirmationModal() {
  const { isOpen, post, isDeleting, onConfirm, close, setDeleting } = useDeleteConfirmationModal()

  const noun = post && targetKindOf(post) === 'reply' ? 'reply' : 'post'
  // One sentence on every topology: whether the document is erased (v10) or
  // blanked to a tombstone (v9, v11) is the network's business, and either
  // way what named it shows that it was deleted. Never "permanently removed
  // from the platform", which a blockchain's history doesn't bear out.
  const description = "This can't be undone. Replies and quotes will show that it was deleted."

  const handleConfirm = async () => {
    if (!onConfirm || isDeleting) return

    setDeleting(true)
    try {
      await onConfirm()
      close()
    } catch (error) {
      logger.error('Delete failed:', error)
      setDeleting(false)
    }
  }

  return (
    <Modal open={isOpen} onOpenChange={(open) => !open && !isDeleting && close()} className="w-[400px] max-w-[90vw]">
                    <ModalTitle>
                      <TrashIcon className="h-6 w-6 text-red-500" />
                      Delete {noun}?
                    </ModalTitle>

                    <Dialog.Description className="text-gray-600 dark:text-gray-400 mb-6">
                      {description}
                    </Dialog.Description>

                    {!isDeleting && (
                      <button
                        onClick={close}
                        className="absolute top-4 right-4 p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors"
                      >
                        <XMarkIcon className="h-5 w-5" />
                      </button>
                    )}

                    {/* Preview of post being deleted */}
                    {post && (
                      <div className="mb-6 p-3 bg-gray-50 dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
                        <p className="text-sm text-gray-600 dark:text-gray-400 line-clamp-3">
                          {post.content}
                        </p>
                      </div>
                    )}

                    <div className="flex flex-col gap-3">
                      <Button
                        onClick={handleConfirm}
                        disabled={isDeleting}
                        className="w-full bg-red-500 hover:bg-red-600 text-white"
                      >
                        {isDeleting ? (
                          <span className="flex items-center gap-2">
                            <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                              <circle
                                className="opacity-25"
                                cx="12"
                                cy="12"
                                r="10"
                                stroke="currentColor"
                                strokeWidth="4"
                                fill="none"
                              />
                              <path
                                className="opacity-75"
                                fill="currentColor"
                                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                              />
                            </svg>
                            Deleting...
                          </span>
                        ) : (
                          'Delete'
                        )}
                      </Button>
                      <Button
                        onClick={close}
                        variant="outline"
                        disabled={isDeleting}
                        className="w-full"
                      >
                        Cancel
                      </Button>
                    </div>
    </Modal>
  )
}
