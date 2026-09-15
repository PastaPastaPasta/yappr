'use client'

import * as Dialog from '@radix-ui/react-dialog'
import { Modal } from './modal'
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline'
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
    default: 'text-gray-500'
  }

  const buttonColors = {
    danger: 'bg-red-600 hover:bg-red-700 text-white',
    warning: 'bg-amber-600 hover:bg-amber-700 text-white',
    default: ''
  }

  return (
    <Modal open={isOpen} onOpenChange={onClose} className="w-[400px] max-w-[90vw]">
                    <div className="flex items-start gap-4">
                      <div className={`p-2 rounded-full bg-gray-100 dark:bg-gray-800 ${iconColors[variant]}`}>
                        <ExclamationTriangleIcon className="h-6 w-6" />
                      </div>
                      <div className="flex-1">
                        <Dialog.Title className="text-lg font-semibold">
                          {title}
                        </Dialog.Title>
                        <Dialog.Description className="text-sm text-gray-500 mt-1">
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
    </Modal>
  )
}
