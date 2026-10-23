'use client'

import { useEffect, useMemo, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { EyeIcon, EyeSlashIcon, LockOpenIcon, NoSymbolIcon } from '@heroicons/react/24/outline'
import toast from 'react-hot-toast'
import { Modal, ModalTitle } from '@/components/ui/modal'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/contexts/auth-context'
import { useModeratorHideModal, type ModeratorHideAction, type ModeratorHideOutcome, type ModeratorHideTarget } from '@/hooks/use-moderator-hide-modal'
import { useBulkHideModal } from '@/hooks/use-bulk-hide-modal'
import { labelOptions, type LabelOption } from '@/lib/moderation-labels'
import { forgetModeratedReads } from '@/lib/moderation-refresh'
import { outcomeWhenAlready } from '@/lib/moderation-view'
import { moderationServiceFor, type ModerationReasonInput, type ModerationResult } from '@/lib/services/moderation-service'
import { bulkHideAvailable } from '@/lib/services/bulk-hide-service'
import { CharterReasonPicker, useSeatedReasons } from './charter-reason-picker'

const INPUT = 'w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-neutral-800 text-sm focus:outline-none focus:ring-2 focus:ring-yappr-500'

/** Whether the action writes a label (a hide's `modLabel`, a restriction's `reason`) the moderator picks. */
const labelled = (action: ModeratorHideAction) => action === 'hide' || action === 'restrict'

interface Copy {
  title: string
  body: string
  confirm: string
  busy: string
  done: string
}

/** What the dialog says for each action. Never "removed" or "deleted": nothing is. */
export function hideModalCopy(target: Pick<ModeratorHideTarget, 'action' | 'noun'>): Copy {
  const { noun } = target
  const Noun = noun.charAt(0).toUpperCase() + noun.slice(1)
  switch (target.action) {
    case 'hide':
      return {
        title: `Hide this ${noun}?`,
        body: `It leaves feeds, search and profiles for everyone. Nothing is deleted: anyone who opens it by link sees that the moderators hid it, without its content, and any moderator can unhide it. The hide is public: it records the reason, who hid it and when.`,
        confirm: `Hide ${noun}`,
        busy: 'Hiding…',
        done: `${Noun} hidden`,
      }
    case 'unhide':
      return {
        title: `Unhide this ${noun}?`,
        body: `It shows in feeds, search and profiles again.`,
        confirm: `Unhide ${noun}`,
        busy: 'Unhiding…',
        done: `${Noun} visible again`,
      }
    case 'restrict':
      return {
        title: 'Restrict this account?',
        body: 'What they post from now on stays out of feeds, search and profiles until a moderator lifts the restriction. What they already posted stays up unless you hide it. The restriction is public, with its reason.',
        confirm: 'Restrict account',
        busy: 'Restricting…',
        done: 'Account restricted',
      }
    case 'lift':
      return {
        title: 'Lift this restriction?',
        body: 'What they post from now on shows normally again. What they posted while restricted stays out of feeds.',
        confirm: 'Lift restriction',
        busy: 'Lifting…',
        done: 'Restriction lifted',
      }
  }
}

/**
 * The one dialog for every moderator action on a "hide, don't delete" cut
 * (social v18, blog v10, storefront v11): hide or unhide a document, restrict
 * an account or lift its restriction. A hide and a restriction carry a reason:
 * with a seated team, one of its charter's reasons (which the transition also
 * cites, 41203); otherwise one of the interim classes
 * (lib/moderation-labels.ts). An unhide or lift by a seated team still cites a
 * charter reason. Legal hold (`mod` 2) is not offered: no charter grants it as
 * a power of its own.
 */
export function ModeratorHideModal() {
  const { user } = useAuth()
  const { isOpen, target, onDone, close } = useModeratorHideModal()
  const contract = target?.contract ?? 'social'
  const seatedReasons = useSeatedReasons(isOpen, contract)
  const [label, setLabel] = useState<number | null>(null)
  const [reasonDocumentId, setReasonDocumentId] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [alsoHide, setAlsoHide] = useState(false)
  const { open: openBulkHide } = useBulkHideModal()

  useEffect(() => {
    if (!isOpen) return
    setLabel(null)
    setReasonDocumentId('')
    setNote('')
    setAlsoHide(false)
  }, [isOpen, target])

  const options: readonly LabelOption[] = useMemo(
    () => (seatedReasons.required ? labelOptions(seatedReasons.reasons) : labelOptions(null)),
    [seatedReasons.required, seatedReasons.reasons]
  )

  if (!target) return null
  const copy = hideModalCopy(target)
  const action = target.action
  const needsLabel = labelled(action)
  const chosen = options.find((option) => option.label === label) ?? null
  const charterReasonId = needsLabel ? chosen?.reasonDocumentId ?? '' : reasonDocumentId
  const ready = !busy && !seatedReasons.loading && !seatedReasons.failed
    && (!needsLabel || chosen !== null)
    && (!seatedReasons.required || charterReasonId !== '')

  // A restriction keeps what they post from now on out of the feeds; what they already posted can be hidden next, in bulk.
  const offersBulkHide = action === 'restrict' && contract === 'social' && bulkHideAvailable()

  const handleClose = () => {
    if (!busy) close()
  }

  /** Closes, then, when asked, opens the bulk hide on the restricted account with the restriction's reason. */
  const finish = () => {
    close()
    if (offersBulkHide && alsoHide) openBulkHide({ authorId: target.authorId, label: chosen?.label, note: note.trim() })
  }

  const run = async () => {
    if (!ready || !user) return
    const service = moderationServiceFor(contract)
    const reason: ModerationReasonInput = {
      text: [chosen?.text, note.trim()].filter(Boolean).join(': ') || copy.done,
      ...(target.docType && target.documentId && action !== 'restrict' && action !== 'lift'
        ? { documents: [{ documentTypeName: target.docType, documentId: target.documentId }] }
        : {}),
      ...(seatedReasons.required && charterReasonId ? { reasonDocumentId: charterReasonId } : {}),
    }
    setBusy(true)
    let result: ModerationResult
    let outcome: ModeratorHideOutcome
    const now = Date.now()
    switch (action) {
      case 'hide':
        result = await service.hide(user.identityId, target.docType ?? '', target.documentId ?? '', { label: chosen?.label ?? 0, reason })
        outcome = { moderation: { mod: 1, modLabel: chosen?.label, moderatedBy: user.identityId, moderatedAt: now } }
        break
      case 'unhide':
        result = await service.unhide(user.identityId, target.docType ?? '', target.documentId ?? '', reason)
        outcome = { moderation: null }
        break
      case 'restrict':
        result = await service.restrict(user.identityId, target.authorId, chosen?.label ?? 0, reason)
        outcome = { restricted: true }
        break
      case 'lift':
        result = await service.liftRestriction(user.identityId, target.authorId, reason)
        outcome = { restricted: false }
        break
    }
    setBusy(false)
    // Ordered by the change's own block time when the proved answer gave it (hooks/use-recent-moderation.ts).
    if (result.moderatedAt !== undefined) {
      outcome = { ...outcome, at: result.moderatedAt, ...(outcome.moderation ? { moderation: { ...outcome.moderation, moderatedAt: result.moderatedAt } } : {}) }
    }
    // The moderator closed the key sheet: nothing was signed, so the dialog stays open.
    if (result.errorCode === 'CANCELLED') return
    if (result.errorCode === 'MAYBE_APPLIED') {
      // The DAPI gateway often times out on a write that landed: show it as
      // done, drop the reads that could contradict it, and say to look again.
      toast(`${copy.done}. The network hasn't confirmed it yet, so check back in a moment.`, { duration: 8000 })
      forgetModeratedReads(contract)
      onDone?.({ ...outcome, unconfirmed: true })
      finish()
      return
    }
    // Already the way it was asked for (another moderator, or an earlier attempt): this tab changed
    // nothing, so it claims no change of its own (no author, label or clock): the state shows until the next read.
    if (result.errorCode === 'NOTHING_TO_CHANGE' || result.errorCode === 'ALREADY_RESTRICTED' || result.errorCode === 'NOT_RESTRICTED') {
      toast(result.error ?? 'Already done', { duration: 6000 })
      onDone?.(outcomeWhenAlready(outcome))
      finish()
      return
    }
    if (!result.success) {
      toast.error(result.error || 'That did not go through. Try again.')
      return
    }
    toast.success(copy.done)
    forgetModeratedReads(contract)
    onDone?.(outcome)
    finish()
  }

  const Icon = action === 'hide' ? EyeSlashIcon : action === 'unhide' ? EyeIcon : action === 'restrict' ? NoSymbolIcon : LockOpenIcon
  return (
    <Modal open={isOpen} onOpenChange={(open) => !open && handleClose()} className="w-[420px] max-w-[90vw]">
      <ModalTitle>
        <Icon className="h-6 w-6 text-amber-600" />
        {copy.title}
      </ModalTitle>
      <Dialog.Description className="text-gray-600 dark:text-gray-400 mb-4">{copy.body}</Dialog.Description>
      {target.preview && (
        <div className="mb-4 p-3 bg-gray-50 dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
          <p className="text-sm text-gray-600 dark:text-gray-400 line-clamp-3">{target.preview}</p>
        </div>
      )}
      {needsLabel && (
        seatedReasons.failed ? (
          <p role="alert" className="mb-4 text-xs text-red-500">Could not read the moderation team&apos;s charter. Close and try again.</p>
        ) : (
          <div className="mb-4">
            <label htmlFor="moderator-hide-reason" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Reason (public)
            </label>
            <select
              id="moderator-hide-reason"
              value={label ?? ''}
              disabled={seatedReasons.loading}
              onChange={(e) => setLabel(e.target.value ? Number(e.target.value) : null)}
              className={INPUT}
            >
              <option value="">{seatedReasons.loading ? 'Reading the charter…' : 'Choose a reason…'}</option>
              {options.map((option) => <option key={option.label} value={option.label}>{option.text}</option>)}
            </select>
            {seatedReasons.required && options.length === 0 && (
              <p className="mt-1 text-xs text-red-500">The team&apos;s charter lists no reasons, so it cannot do this.</p>
            )}
          </div>
        )
      )}
      {!needsLabel && (seatedReasons.required || seatedReasons.failed) && (
        <div className="mb-4">
          <CharterReasonPicker id="moderator-hide-charter-reason" state={seatedReasons} value={reasonDocumentId} onChange={setReasonDocumentId} />
        </div>
      )}
      <label htmlFor="moderator-hide-note" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
        Note (optional, public)
      </label>
      <input
        id="moderator-hide-note"
        type="text"
        value={note}
        maxLength={500}
        onChange={(e) => setNote(e.target.value)}
        className={`${INPUT} mb-4`}
      />
      {offersBulkHide && (
        <label className="flex items-start gap-2 mb-4 text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 rounded border-gray-300 text-yappr-600 focus:ring-yappr-500"
            checked={alsoHide}
            onChange={(e) => setAlsoHide(e.target.checked)}
            data-testid="moderator-restrict-also-hide"
          />
          <span>
            Also hide this account&apos;s earlier posts
            <span className="block text-xs text-gray-500 dark:text-gray-400">Next, you pick which of their posts and replies to hide.</span>
          </span>
        </label>
      )}
      <div className="flex flex-col gap-3">
        <Button data-testid="moderator-hide-confirm" onClick={() => { run().catch(() => { /* reported inside */ }) }} disabled={!ready} className="w-full">
          {busy ? copy.busy : copy.confirm}
        </Button>
        <Button onClick={handleClose} variant="outline" disabled={busy} className="w-full">Cancel</Button>
      </div>
    </Modal>
  )
}
