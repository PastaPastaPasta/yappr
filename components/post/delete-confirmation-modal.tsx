'use client'

import * as Dialog from '@radix-ui/react-dialog'
import { XMarkIcon, TrashIcon } from '@heroicons/react/24/outline'
import { motion, AnimatePresence } from 'framer-motion'
import { Button } from '@/components/ui/button'
import { useDeleteConfirmationModal } from '@/hooks/use-delete-confirmation-modal'

export function DeleteConfirmationModal() {
  const { isOpen, post, isDeleting, onConfirm, close, setDeleting } = useDeleteConfirmationModal()

  const handleConfirm = async () => {
    if (!onConfirm || isDeleting) return

    setDeleting(true)
    try {
      await onConfirm()
      close()
    } catch (error) {
      console.error('Delete failed:', error)
      setDeleting(false)
    }
  }

  return (
    <Dialog.Root open={isOpen} onOpenChange={(open) => !open && !isDeleting && close()}>
      <AnimatePresence>
        {isOpen && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center px-4"
              >
                <Dialog.Content asChild>
                  <motion.div
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    className="bg-white dark:bg-surface-900 rounded-2xl p-6 w-[400px] max-w-[90vw] shadow-xl relative"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Dialog.Title className="text-xl font-bold mb-2 flex items-center gap-2">
                      <TrashIcon className="h-6 w-6 text-red-500" />
                      Delete post?
                    </Dialog.Title>

                    <Dialog.Description className="text-gray-600 dark:text-gray-400 mb-6">
                      This action cannot be undone. The post will be permanently removed from the platform.
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
                      <div className="mb-6 p-3 bg-gray-50 dark:bg-gray-800 rounded-lg border border-surface-200 dark:border-neutral-750">
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
                  </motion.div>
                </Dialog.Content>
              </motion.div>
            </Dialog.Overlay>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  )
}
