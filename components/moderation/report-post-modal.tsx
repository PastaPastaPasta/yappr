'use client'

import { useEffect, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { FlagIcon } from '@heroicons/react/24/outline'
import toast from 'react-hot-toast'
import { Modal, ModalTitle } from '@/components/ui/modal'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/contexts/auth-context'
import { useReportPostModal } from '@/hooks/use-report-post-modal'
import { reportsAreResolved, targetKindOf } from '@/lib/contract-topology'
import { logger } from '@/lib/logger'
import {
  OTHER_REASON_CODE,
  REPORT_NOTE_MAX_LENGTH,
  REPORT_REASONS,
  isAlreadyReportedError,
  isReportGoneError,
  reportFailureMessage,
  reportInputProblem,
  reportReasonLabel,
  reportStatusLabel,
  withdrawFailureMessage,
  type ReportRecord,
} from '@/lib/reports'
import { reportService } from '@/lib/services/report-service'
import { reportBarredWrite } from './barred-writer-notice'

/** The reader's own report on the open target: still being read, read, or unreadable. */
type OwnReport = { state: 'loading' } | { state: 'none' } | { state: 'filed'; report: ReportRecord } | { state: 'failed' }

/**
 * Reports a post or reply to the contract's moderators, or shows the report
 * the reader already filed and lets them withdraw it. One report per reader
 * and target: the dialog reads the reader's own report first and never offers
 * a second (a paid 40105).
 */
export function ReportPostModal() {
  const { user } = useAuth()
  const { isOpen, post, close } = useReportPostModal()
  const [own, setOwn] = useState<OwnReport>({ state: 'loading' })
  const [reason, setReason] = useState<number | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const kind = post ? targetKindOf(post) : 'post'
  const noun = kind === 'reply' ? 'reply' : 'post'
  const identityId = user?.identityId
  /** v10: the moderators mark a report handled (and the reporter sees how) instead of deleting it. */
  const resolving = reportsAreResolved()

  useEffect(() => {
    if (!isOpen || !post || !identityId) return
    let cancelled = false
    setOwn({ state: 'loading' })
    reportService.getOwnReport(identityId, targetKindOf(post), post.id).then((report) => {
      if (!cancelled) setOwn(report ? { state: 'filed', report } : { state: 'none' })
    }).catch((error: unknown) => {
      logger.warn('ReportPostModal: could not read the reader\'s own report', error)
      if (!cancelled) setOwn({ state: 'failed' })
    })
    return () => {
      cancelled = true
    }
  }, [isOpen, post, identityId])

  /** Close, leaving nothing of this target behind for the next one opened. */
  const finish = () => {
    setReason(null)
    setNote('')
    setOwn({ state: 'loading' })
    close()
  }

  const handleClose = () => {
    if (!busy) finish()
  }

  const handleReport = async () => {
    if (!post || !identityId || busy) return
    const problem = reportInputProblem(reason, note)
    if (problem || reason === null) {
      toast.error(problem ?? 'Choose why you are reporting this')
      return
    }
    setBusy(true)
    const result = await reportService.fileReport(identityId, {
      kind,
      targetId: post.id,
      targetOwnerId: post.author.id,
      reason,
      note,
    })
    setBusy(false)
    if (!result.success) {
      if (isAlreadyReportedError(result.error)) {
        toast.error(reportFailureMessage(result.error, noun))
        finish()
        return
      }
      if (!reportBarredWrite(result.error, identityId)) toast.error(reportFailureMessage(result.error, noun))
      return
    }
    toast.success(result.confirmed === false
      ? 'Report sent. The network has not confirmed it yet; it reaches the moderators once it does.'
      : resolving
        ? `Reported. The moderators will review this ${noun} and mark your report handled.`
        : `Reported. The moderators will review this ${noun}.`)
    finish()
  }

  const handleWithdraw = async (report: ReportRecord) => {
    if (!identityId || busy) return
    setBusy(true)
    const result = await reportService.withdrawReport(identityId, report.id)
    setBusy(false)
    if (!result.success) {
      if (isReportGoneError(result.error)) {
        toast(withdrawFailureMessage(result.error))
        finish()
        return
      }
      if (!reportBarredWrite(result.error, identityId)) toast.error(withdrawFailureMessage(result.error))
      return
    }
    toast.success('Report withdrawn')
    finish()
  }

  const filed = own.state === 'filed' ? own.report : null

  return (
    <Modal open={isOpen} onOpenChange={(open) => !open && handleClose()} className="w-[440px] max-w-[90vw] max-h-[90vh] overflow-y-auto">
      <ModalTitle>
        <FlagIcon className="h-6 w-6 text-red-500" />
        {filed ? `You reported this ${noun}` : `Report this ${noun}`}
      </ModalTitle>

      {own.state === 'loading' && (
        <Dialog.Description className="text-sm text-gray-500 dark:text-gray-400 py-6 text-center">Checking whether you already reported it…</Dialog.Description>
      )}

      {own.state === 'failed' && (
        <div className="flex flex-col gap-3">
          <Dialog.Description role="alert" className="text-sm text-red-500">
            Could not check whether you already reported this {noun}. Try again in a moment.
          </Dialog.Description>
          <Button onClick={handleClose} variant="outline" className="w-full">Close</Button>
        </div>
      )}

      {filed && (
        <div className="flex flex-col gap-3">
          <Dialog.Description className="text-gray-600 dark:text-gray-400">
            On {new Date(filed.createdAt).toLocaleDateString()} you reported it for <strong>{reportReasonLabel(filed.reason)}</strong>.
            {resolving
              ? filed.status === null ? ` The moderators haven't resolved it yet; they'll mark it handled here once they review the ${noun}.` : ''
              : ` The moderators review it and may remove the ${noun} or dismiss the report.`}
          </Dialog.Description>
          {filed.note && (
            <p className="text-sm p-3 bg-gray-50 dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 whitespace-pre-wrap break-words">{filed.note}</p>
          )}
          {filed.status !== null && (
            <div data-testid="own-report-resolution" className="text-sm p-3 rounded-lg border border-green-200 dark:border-green-900 bg-green-50 dark:bg-green-950">
              <p>
                Resolved by the moderators: <strong>{reportStatusLabel(filed.status)}</strong>
                {filed.moderatedAt ? ` on ${new Date(filed.moderatedAt).toLocaleDateString()}` : ''}.
              </p>
              {filed.resolution && <p className="mt-1 whitespace-pre-wrap break-words">{filed.resolution}</p>}
            </div>
          )}
          <Button onClick={() => handleWithdraw(filed)} variant="outline" disabled={busy} className="w-full text-red-500">
            {busy ? 'Withdrawing…' : 'Withdraw report'}
          </Button>
          <Button onClick={handleClose} disabled={busy} className="w-full">Done</Button>
        </div>
      )}

      {own.state === 'none' && (
        <div className="flex flex-col">
          <Dialog.Description className="text-gray-600 dark:text-gray-400 mb-4">
            Your report goes to this community&apos;s moderators. Reports are public on Dash Platform: anyone, including
            the {noun}&apos;s author, can see that you reported it, the reason you pick and anything you write in the details.
            {resolving && ' You can come back here to see how the moderators resolved it.'} A report expires after 90 days.
          </Dialog.Description>
          <fieldset className="mb-4" disabled={busy}>
            <legend className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">What is wrong with it?</legend>
            <div className="flex flex-col">
              {REPORT_REASONS.map((option) => (
                <label
                  key={option.code}
                  className="flex items-start gap-3 px-3 py-1.5 rounded-lg cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800 has-[:checked]:bg-gray-100 dark:has-[:checked]:bg-gray-800"
                >
                  <input
                    type="radio"
                    name="report-reason"
                    value={option.code}
                    checked={reason === option.code}
                    onChange={() => setReason(option.code)}
                    className="mt-1 accent-yappr-500"
                  />
                  <span>
                    <span className="block text-sm font-medium">{option.label}</span>
                    <span className="block text-xs text-gray-500 dark:text-gray-400">{option.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <label htmlFor="report-note" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Details {reason === OTHER_REASON_CODE ? '(required)' : '(optional)'}
          </label>
          <textarea
            id="report-note"
            value={note}
            maxLength={REPORT_NOTE_MAX_LENGTH}
            rows={3}
            disabled={busy}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Anything the moderators should know"
            className="w-full mb-1 px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-neutral-800 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-yappr-500"
          />
          <p className="text-xs text-gray-500 dark:text-gray-400 text-right mb-4">{note.length}/{REPORT_NOTE_MAX_LENGTH}</p>
          <div className="flex flex-col gap-3">
            <Button
              onClick={handleReport}
              disabled={busy || reportInputProblem(reason, note) !== null}
              className="w-full bg-red-500 hover:bg-red-600 text-white"
            >
              {busy ? 'Reporting…' : `Report ${noun}`}
            </Button>
            <Button onClick={handleClose} variant="outline" disabled={busy} className="w-full">
              Cancel
            </Button>
          </div>
        </div>
      )}
    </Modal>
  )
}
