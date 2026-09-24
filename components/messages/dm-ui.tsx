'use client'

import type { MouseEvent, ReactNode } from 'react'
import { XMarkIcon } from '@heroicons/react/24/outline'
import * as Dialog from '@radix-ui/react-dialog'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Modal } from '@/components/ui/modal'
import { cn } from '@/lib/utils'

/** A thrown error's message for a toast, or `fallback` when it is not an `Error`. */
export function errorText(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

interface DmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  /** Screen-reader description. */
  description: string
  closeLabel: string
  className?: string
  children: ReactNode
}

/** The messages dialogs' shell: a modal with a title and a close button. */
export function DmDialog({ open, onOpenChange, title, description, closeLabel, className, children }: DmDialogProps) {
  return (
    <Modal open={open} onOpenChange={onOpenChange} className={cn('w-full max-w-md max-h-[85vh] overflow-y-auto p-4 sm:p-6', className)}>
      <div className="flex items-center justify-between mb-4">
        <Dialog.Title className="text-xl font-bold">{title}</Dialog.Title>
        <Dialog.Description className="sr-only">{description}</Dialog.Description>
        <button aria-label={closeLabel} onClick={() => onOpenChange(false)} className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full">
          <XMarkIcon className="h-5 w-5" />
        </button>
      </div>
      {children}
    </Modal>
  )
}

/** A dropdown menu's panel, aligned to the end of its trigger. */
export function MenuContent({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        align="end"
        sideOffset={5}
        className={cn('bg-white dark:bg-neutral-900 rounded-xl shadow-lg border border-gray-200 dark:border-gray-800 py-2 z-50', className)}
      >
        {children}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  )
}

export function MenuItem({ onClick, className, children }: { onClick: (event: MouseEvent<HTMLDivElement>) => void; className?: string; children: ReactNode }) {
  return (
    <DropdownMenu.Item onClick={onClick} className={cn('px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-900 cursor-pointer outline-none', className)}>
      {children}
    </DropdownMenu.Item>
  )
}
