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
import { CharterReasonPicker, useSeatedReasons } from './charter-reason-picker'

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
  /**
   * A seated elected team must cite one of its charter's reasons on every
   * deletion (41203). Read only while the modal is open (only moderators can
   * open it), and again on every open, so a team seated mid-session is seen.
   */
  const seatedReasons = useSeatedReasons(isOpen)
  const [reasonDocumentId, setReasonDocumentId] = useState('')
  const noun = post && targetKindOf(post) === 'reply' ? 'reply' : 'post'

  const reset = () => {
    setReason('')
    setReasonDocumentId('')
  }

  const handleClose = () => {
    if (busy) return
    reset()
    close()
  }

  const handleRemove = async () => {
    if (!post || !user || busy) return
    if (seatedReasons.loading) return
    if (seatedReasons.failed) {
      toast.error('Could not read the elected team\'s charter; try again')
      return
    }
    if (seatedReasons.required && !reasonDocumentId) {
      toast.error('Choose the charter reason this removal is taken on')
      return
    }
    setBusy(true)
    const result = await moderationService.removeDocument(user.identityId, targetKindOf(post), post.id, {
      text: reason.trim(),
      ...(seatedReasons.required && reasonDocumentId ? { reasonDocumentId } : {}),
    })
    setBusy(false)
    if (result.errorCode === 'MAYBE_APPLIED') {
      // The DAPI gateway often times out on a delete that landed: say so, keep
      // the dialog closed, and do not drop the card until it is checked.
      toast(`This ${noun} may have been removed — the network did not confirm in time. Check again before retrying.`
        + (result.snapshotSaved ? ' A copy is kept on this device in case it needs restoring.' : ''), { duration: 8000 })
      reset()
      close()
      return
    }
    if (!result.success) {
      toast.error(result.error || 'Removal failed')
      return
    }
    const removed = `${noun === 'reply' ? 'Reply' : 'Post'} removed`
    toast.success(result.snapshotSaved
      ? `${removed}. A copy is kept on this device for a week, so it can be restored from the moderation settings.`
      : `${removed}. No copy could be kept on this device, so it cannot be restored.`)
    onRemoved?.()
    reset()
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
        and a public removal record with your reason stays on-chain. This device will try to keep a copy for a week,
        so the removal can be undone from here.
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
      {(seatedReasons.required || seatedReasons.failed) && (
        <div className="mb-4">
          <CharterReasonPicker id="moderator-remove-charter-reason" state={seatedReasons} value={reasonDocumentId} onChange={setReasonDocumentId} />
        </div>
      )}
      <div className="flex flex-col gap-3">
        <Button onClick={handleRemove} disabled={busy || seatedReasons.loading} className="w-full bg-red-500 hover:bg-red-600 text-white">
          {busy ? 'Removing…' : `Remove ${noun}`}
        </Button>
        <Button onClick={handleClose} variant="outline" disabled={busy} className="w-full">
          Cancel
        </Button>
      </div>
    </Modal>
  )
}
