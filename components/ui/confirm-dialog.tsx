'use client'

import * as Dialog from '@radix-ui/react-dialog'
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline'
import { motion, AnimatePresence } from 'framer-motion'
import { Button } from './button'

interface ConfirmDialogProps {
  isOpen: boolean
  onClose: () => void
  onConfirm: () => void
  title: string
  message: string
  confirmText?: string
  cancelText?: string
  variant?: 'danger' | 'warning' | 'default'
  isLoading?: boolean
}

export function ConfirmDialog({
  isOpen,
  onClose,
  onConfirm,
  title,
  message,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  variant = 'danger',
  isLoading = false
}: ConfirmDialogProps) {
  const iconColors = {
    danger: 'text-red-500',
    warning: 'text-amber-500',
    default: 'text-surface-500'
  }

  const buttonColors = {
    danger: 'bg-red-600 hover:bg-red-700 text-white',
    warning: 'bg-amber-600 hover:bg-amber-700 text-white',
    default: ''
  }

  return (
    <Dialog.Root open={isOpen} onOpenChange={onClose}>
      <AnimatePresence>
        {isOpen && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fixed inset-0 bg-surface-950/50 dark:bg-black/60 z-50 flex items-center justify-center px-4 backdrop-blur-sm"
              >
                <Dialog.Content asChild>
                  <motion.div
                    initial={{ opacity: 0, scale: 0.95, y: 8 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.95, y: 8 }}
                    transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                    className="bg-white dark:bg-surface-900 rounded-2xl p-6 w-[400px] max-w-[90vw] shadow-elevated-lg border border-surface-200/40 dark:border-surface-800/40"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div className="flex items-start gap-4">
                      <div className={`p-2 rounded-full bg-surface-100 dark:bg-surface-800 ${iconColors[variant]}`}>
                        <ExclamationTriangleIcon className="h-6 w-6" />
                      </div>
                      <div className="flex-1">
                        <Dialog.Title className="text-lg font-display font-semibold">
                          {title}
                        </Dialog.Title>
                        <Dialog.Description className="text-sm text-surface-500 dark:text-surface-400 mt-1">
                          {message}
                        </Dialog.Description>
                      </div>
                    </div>

                    <div className="flex gap-3 mt-6 justify-end">
                      <Button
                        variant="outline"
                        onClick={onClose}
                        disabled={isLoading}
                      >
                        {cancelText}
                      </Button>
                      <Button
                        className={variant !== 'default' ? buttonColors[variant] : ''}
                        onClick={onConfirm}
                        disabled={isLoading}
                      >
                        {isLoading ? 'Deleting...' : confirmText}
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
