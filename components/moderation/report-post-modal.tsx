'use client'

import { useEffect, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { FlagIcon } from '@heroicons/react/24/outline'
import toast from 'react-hot-toast'
import { Modal, ModalTitle } from '@/components/ui/modal'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/contexts/auth-context'
import { useReportPostModal, type ReportSubject } from '@/hooks/use-report-post-modal'
import { CREDITS_PER_DASH } from '@/lib/constants'
import { reportsAreResolved } from '@/lib/contract-topology'
import { logger } from '@/lib/logger'
import {
  MODERATION_EMAIL,
  OTHER_REASON_CODE,
  REPORT_NOTE_MAX_LENGTH,
  isAlreadyReportedError,
  isReportGoneError,
  isReportResolvedError,
  isUrgentReason,
  reportEmailHref,
  reportFailureMessage,
  reportInputProblem,
  reportReasonLabel,
  reportFeeCredits,
  reportCanBeWithdrawn,
  reportReasonsOffered,
  reportStatusLabel,
  withdrawFailureMessage,
  type ReportRecord,
  type ReportTargetKind,
} from '@/lib/reports'
import { buildReportBox, reportNeedsBox } from '@/lib/services/report-box-service'
import { reportService } from '@/lib/services/report-service'
import { reportBarredWrite } from './barred-writer-notice'
import { useModeratedTypeOpen } from '@/hooks/use-moderated-type-open'
import { POSTING_CLOSED_COPY } from '@/lib/error-utils'

/** The report's target as the write names it. */
function reportTargetOf(subject: ReportSubject | null): { kind: ReportTargetKind; targetId: string; targetOwnerId: string } | null {
  if (!subject) return null
  if (subject.kind === 'profile') return { kind: 'profile', targetId: subject.identityId, targetOwnerId: subject.identityId }
  return { kind: subject.kind, targetId: subject.post.id, targetOwnerId: subject.post.author.id }
}

/** The moderators' action fee a report pays (v13: 50M credits), as DASH, or null where reports are free. */
function reportFeeDash(): string | null {
  const fee = reportFeeCredits()
  return fee === null ? null : (Number(fee) / CREDITS_PER_DASH).toFixed(4)
}

/** The reader's own report on the open target: still being read, read, or unreadable. */
type OwnReport = { state: 'loading' } | { state: 'none' } | { state: 'filed'; report: ReportRecord } | { state: 'failed' }

/**
 * Reports a post, a reply or (v13) a profile to the contract's moderators, or
 * shows the report the reader already filed and lets them withdraw it (on v14
 * only until a moderator resolves it: a resolved report stays). One
 * report per reader and target: the dialog reads the reader's own report
 * first and never offers a second (a paid 40105).
 *
 * A report of private content (v13) carries the moderators' box: the
 * reader's key to it, sealed to every current moderator's encryption key.
 * Where no moderator holds one, the report is filed without it and the reader
 * is pointed at the team's email.
 */
export function ReportPostModal() {
  const { user } = useAuth()
  const { isOpen, subject, close } = useReportPostModal()
  const [own, setOwn] = useState<OwnReport>({ state: 'loading' })
  const [reason, setReason] = useState<number | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const target = reportTargetOf(subject)
  const noun: ReportTargetKind = target?.kind ?? 'post'
  const privatePost = subject && subject.kind !== 'profile' && reportNeedsBox(subject.post) ? subject.post : null
  const identityId = user?.identityId
  /** v10: the moderators mark a report handled (and the reporter sees how) instead of deleting it. */
  const resolving = reportsAreResolved()
  const feeDash = reportFeeDash()
  // Mainnet v13 (`notYetUsable`): reports wait for the first seated team (41200, paid).
  const reportsOpen = useModeratedTypeOpen('report', isOpen)
  const targetKind = target?.kind
  const targetId = target?.targetId

  useEffect(() => {
    if (!isOpen || !targetKind || !targetId || !identityId) return
    let cancelled = false
    setOwn({ state: 'loading' })
    reportService.getOwnReport(identityId, targetKind, targetId).then((report) => {
      if (!cancelled) setOwn(report ? { state: 'filed', report } : { state: 'none' })
    }).catch((error: unknown) => {
      logger.warn('ReportPostModal: could not read the reader\'s own report', error)
      if (!cancelled) setOwn({ state: 'failed' })
    })
    return () => {
      cancelled = true
    }
  }, [isOpen, targetKind, targetId, identityId])

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

  /**
   * The moderators' box for a private post or reply, or undefined to file
   * without one (said why). Null when the team could not be read: filing
   * then waits rather than send a report its moderators cannot open.
   */
  const sealForModerators = async (reporterId: string): Promise<Uint8Array | undefined | null> => {
    if (!privatePost) return undefined
    try {
      const outcome = await buildReportBox(reporterId, privatePost)
      if (outcome.kind === 'sealed') return outcome.box
      if (outcome.kind === 'no-recipients') {
        toast(`No moderator can read private posts yet. Your report is filed without the ${noun}'s content; email ${MODERATION_EMAIL} if they need to see it.`, { duration: 10000 })
      } else if (outcome.kind === 'no-key') {
        toast(`This device could not confirm a key that opens the ${noun}, so the moderators will not be able to read it.`, { duration: 8000 })
      }
      return undefined
    } catch (error) {
      logger.warn('ReportPostModal: could not seal the report for the moderators', error)
      toast.error('Could not read the moderation team. Try again in a moment.')
      return null
    }
  }

  const handleReport = async () => {
    if (!target || !identityId || busy) return
    const problem = reportInputProblem(reason, note)
    if (problem || reason === null) {
      toast.error(problem ?? 'Choose why you are reporting this')
      return
    }
    setBusy(true)
    const box = await sealForModerators(identityId)
    if (box === null) {
      setBusy(false)
      return
    }
    const result = await reportService.fileReport(identityId, { ...target, reason, note, box })
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
      // Gone, or resolved since the dialog read it: nothing left to withdraw here.
      if (isReportGoneError(result.error) || isReportResolvedError(result.error)) {
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
          {reportCanBeWithdrawn(filed) ? (
            <Button onClick={() => handleWithdraw(filed)} variant="outline" disabled={busy} className="w-full text-red-500">
              {busy ? 'Withdrawing…' : 'Withdraw report'}
            </Button>
          ) : (
            <p data-testid="own-report-kept" className="text-sm text-gray-500 dark:text-gray-400">
              A resolved report can&apos;t be withdrawn. It expires 90 days after you filed it.
            </p>
          )}
          <Button onClick={handleClose} disabled={busy} className="w-full">Done</Button>
        </div>
      )}

      {own.state === 'none' && (
        <div className="flex flex-col">
          <Dialog.Description className="text-gray-600 dark:text-gray-400 mb-4">
            Your report goes to this community&apos;s moderators. Reports are public on Dash Platform: anyone, including
            the {noun === 'profile' ? 'account\'s owner' : `${noun}'s author`}, can see that you reported it, the reason you pick and anything you write in the details.
            {resolving && ' You can come back here to see how the moderators resolved it.'} A report expires after 90 days.
          </Dialog.Description>
          {privatePost && (
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-4" data-testid="report-private-note">
              This {noun} is private. Your report gives the current moderators the key to read it, sealed so only they can
              open it. That key also opens the feed owner&apos;s other private posts from this key period and all earlier ones.
              {noun === 'reply' && ' For a reply in a private thread, that is the thread owner\'s feed.'}
            </p>
          )}
          {feeDash && (
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-4" data-testid="report-fee">
              Filing a report pays a moderation fee of about {feeDash} DASH to the moderators, plus the network fee.
            </p>
          )}
          {!reportsOpen && (
            <p role="status" data-testid="reports-closed" className="text-sm mb-4 p-3 rounded-lg bg-amber-50 dark:bg-amber-950 text-amber-800 dark:text-amber-200">
              {POSTING_CLOSED_COPY} Until then, email <a href={`mailto:${MODERATION_EMAIL}`} className="underline">{MODERATION_EMAIL}</a>.
            </p>
          )}
          <fieldset className="mb-4" disabled={busy}>
            <legend className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">What is wrong with it?</legend>
            <div className="flex flex-col">
              {reportReasonsOffered().map((option) => (
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
          {reason !== null && isUrgentReason(reason) && target && (
            <div role="alert" data-testid="report-urgent" className="mb-4 text-sm p-3 rounded-lg border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950 text-red-800 dark:text-red-200 space-y-1">
              <p className="font-medium">If a child is in danger, contact your local police now.</p>
              <p>
                Report it to the{' '}
                <a href="https://report.cybertip.org/" target="_blank" rel="noopener noreferrer" className="underline">NCMEC CyberTipline</a>
                {' '}or your country&apos;s hotline, and{' '}
                <a href={reportEmailHref(target, reason)} className="underline">email the team</a>.
                Do not share or describe the material: reports are public.
              </p>
            </div>
          )}
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
              disabled={busy || !reportsOpen || reportInputProblem(reason, note) !== null}
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
