'use client'

import { useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { ShieldExclamationIcon } from '@heroicons/react/24/outline'
import toast from 'react-hot-toast'
import { Modal, ModalTitle } from '@/components/ui/modal'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/contexts/auth-context'
import { useModeratorRemoveModal } from '@/hooks/use-moderator-remove-modal'
import { targetKindOf } from '@/lib/contract-topology'
import { moderationService } from '@/lib/services/moderation-service'

/**
 * A moderator's takedown of a post or reply. Unlike the owner's tombstone,
 * this DELETES the document: it stops resolving everywhere, every reference
 * at it dangles, and a removal record with the reason stays under the
 * contract for anyone to read.
 */
export function ModeratorRemoveModal() {
  const { user } = useAuth()
  const { isOpen, post, onRemoved, close } = useModeratorRemoveModal()
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const noun = post && targetKindOf(post) === 'reply' ? 'reply' : 'post'

  const handleClose = () => {
    if (busy) return
    setReason('')
    close()
  }

  const handleRemove = async () => {
    if (!post || !user || busy) return
    setBusy(true)
    const result = await moderationService.removeDocument(user.identityId, targetKindOf(post), post.id, reason.trim())
    setBusy(false)
    if (!result.success) {
      toast.error(result.error || 'Removal failed')
      return
    }
    toast.success(`${noun === 'reply' ? 'Reply' : 'Post'} removed`)
    onRemoved?.()
    setReason('')
    close()
  }

  return (
    <Modal open={isOpen} onOpenChange={(open) => !open && handleClose()} className="w-[420px] max-w-[90vw]">
      <ModalTitle>
        <ShieldExclamationIcon className="h-6 w-6 text-red-500" />
        Remove {noun} as a moderator?
      </ModalTitle>
      <Dialog.Description className="text-gray-600 dark:text-gray-400 mb-4">
        The {noun} is deleted from the contract for everyone. Its author is not refunded, the id can never be reused,
        and a public removal record with your reason stays on-chain.
      </Dialog.Description>
      {post && (
        <div className="mb-4 p-3 bg-gray-50 dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
          <p className="text-sm text-gray-600 dark:text-gray-400 line-clamp-3">{post.content}</p>
        </div>
      )}
      <label htmlFor="moderator-remove-reason" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
        Reason (public, recorded on-chain)
      </label>
      <input
        id="moderator-remove-reason"
        type="text"
        value={reason}
        maxLength={1024}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Why this is being removed"
        className="w-full mb-4 px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-neutral-800 text-sm focus:outline-none focus:ring-2 focus:ring-yappr-500"
      />
      <div className="flex flex-col gap-3">
        <Button onClick={handleRemove} disabled={busy} className="w-full bg-red-500 hover:bg-red-600 text-white">
          {busy ? 'Removing…' : `Remove ${noun}`}
        </Button>
        <Button onClick={handleClose} variant="outline" disabled={busy} className="w-full">
          Cancel
        </Button>
      </div>
    </Modal>
  )
}
