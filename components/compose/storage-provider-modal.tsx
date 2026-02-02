'use client'

import * as Dialog from '@radix-ui/react-dialog'
import { motion, AnimatePresence } from 'framer-motion'
import { CloudArrowUpIcon } from '@heroicons/react/24/outline'
import { Button } from '@/components/ui/button'
import Link from 'next/link'
import { useSettingsStore } from '@/lib/store'

interface StorageProviderModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSettingsNavigate?: () => void
}

/**
 * Modal prompting user to connect a storage provider for image uploads.
 * Shown when user tries to attach an image without a configured provider.
 */
export function StorageProviderModal({
  open,
  onOpenChange,
  onSettingsNavigate,
}: StorageProviderModalProps) {
  const potatoMode = useSettingsStore((s) => s.potatoMode)

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className={`fixed inset-0 bg-black/60 z-[60] flex items-center justify-center px-4 ${potatoMode ? '' : 'backdrop-blur-sm'}`}
              >
                <Dialog.Content asChild>
                  <motion.div
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    className="w-full max-w-md bg-white dark:bg-neutral-900 rounded-2xl shadow-2xl overflow-hidden"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Dialog.Title className="sr-only">Connect Storage Provider</Dialog.Title>
                    <Dialog.Description className="sr-only">
                      You need to connect a storage provider to attach images to posts
                    </Dialog.Description>

                    <div className="p-6">
                      <div className="flex items-center justify-center w-12 h-12 mx-auto mb-4 rounded-full bg-yappr-100 dark:bg-yappr-900/30">
                        <CloudArrowUpIcon className="w-6 h-6 text-yappr-600 dark:text-yappr-400" />
                      </div>

                      <h3 className="text-lg font-semibold text-center text-gray-900 dark:text-gray-100 mb-2">
                        Connect a Storage Provider
                      </h3>

                      <p className="text-sm text-center text-gray-600 dark:text-gray-400 mb-6">
                        To attach images to your posts, you need to connect a storage provider like Storacha or Pinata. This allows your images to be stored on IPFS.
                      </p>

                      <div className="flex flex-col gap-3">
                        <Button asChild className="w-full">
                          <Link
                            href="/settings?section=storage"
                            onClick={() => {
                              onOpenChange(false)
                              onSettingsNavigate?.()
                            }}
                          >
                            Go to Settings
                          </Link>
                        </Button>
                        <Button
                          variant="outline"
                          className="w-full"
                          onClick={() => onOpenChange(false)}
                        >
                          Cancel
                        </Button>
                      </div>
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
