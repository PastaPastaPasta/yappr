'use client'

import * as Dialog from '@radix-ui/react-dialog'
import { Clock3, X } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import type { BlogPost } from '@/lib/types'

interface EditHistoryModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  post: BlogPost
  isAuthor: boolean
}

function formatDate(date?: Date): string {
  if (!date) return 'Unknown'
  return date.toLocaleString()
}

export function EditHistoryModal({ open, onOpenChange, post, isAuthor }: EditHistoryModalProps) {
  const revision = post.$revision || 1

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[95vw] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-xl border border-gray-700 bg-neutral-950 p-4 sm:p-5">
          <div className="mb-3 flex items-start justify-between gap-3">
            <div>
              <Dialog.Title className="text-lg font-semibold">Edit History</Dialog.Title>
              <Dialog.Description className="mt-1 text-sm text-gray-400">
                Revision details for this post.
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button type="button" className="rounded-md border border-gray-700 p-1 text-gray-300 hover:bg-gray-800" aria-label="Close">
                <X className="h-4 w-4" />
              </button>
            </Dialog.Close>
          </div>

          <div className="space-y-3">
            <div className="rounded-lg border border-gray-800 bg-black/20 p-3">
              <div className="flex items-center gap-2 text-sm text-gray-200">
                <Clock3 className="h-4 w-4" />
                <span>Current revision</span>
                <span className="rounded-full border border-gray-700 px-2 py-0.5 text-xs">#{revision}</span>
              </div>
              <p className="mt-2 text-xs text-gray-400">Created: {formatDate(post.createdAt)}</p>
              <p className="mt-1 text-xs text-gray-400">Last updated: {formatDate(post.updatedAt || post.createdAt)}</p>
            </div>

            <div className="rounded-lg border border-dashed border-gray-700 p-3 text-sm text-gray-300">
              Full revision history with diffs will be available when Platform exposes document history API.
            </div>

            {isAuthor && (
              <div className="flex justify-end">
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span>
                        <Button type="button" variant="outline" disabled>
                          Restore
                        </Button>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>
                      Restore is unavailable until Platform exposes document history APIs.
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
