'use client'

import { useEffect, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import toast from 'react-hot-toast'
import { declaredActionFeeFor } from '@/lib/transition-agreements'
import { useAuth } from '@/contexts/auth-context'
import { Modal, ModalTitle } from '@/components/ui/modal'
import { Button } from '@/components/ui/button'
import { LimitedTextarea } from '@/components/ui/limited-text'
import { useModeratedTypeOpen } from '@/hooks/use-moderated-type-open'
import { documentNoun, moderatedContract } from '@/lib/moderated-contracts'
import { categorizeError, POSTING_CLOSED_COPY } from '@/lib/error-utils'
import { OTHER_REASON_CODE, REPORT_REASONS, reportReasonLabel, reportStatusLabel, isUrgentReason, MODERATION_EMAIL } from '@/lib/reports'
import { contractReportService, contractReportProblem, type ContractReport, type ContractReportTarget } from '@/lib/services/contract-report-service'

export function ContractReportButton(props: ContractReportTarget) {
  const { user } = useAuth()
  const [open, setOpen] = useState(false)
  if (!user || user.identityId === props.ownerId || !moderatedContract(props.contract).reportTargets().some(t => t.docType === props.docType)) return null
  return <>
    <button type="button" className="text-xs text-gray-500 hover:text-red-500 px-2 py-1" onClick={() => setOpen(true)}>Report</button>
    {open && <ContractReportDialog key={`${props.contract}:${props.docType}:${props.targetId}`} target={props} reporterId={user.identityId} close={() => setOpen(false)} />}
  </>
}
function ContractReportDialog({ target, reporterId, close }: { target: ContractReportTarget; reporterId: string; close: () => void }) {
  const [own, setOwn] = useState<ContractReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [reason, setReason] = useState<number | null>(null)
  const [note, setNote] = useState('')
  const available = useModeratedTypeOpen('report', true, target.contract)
  const noun = documentNoun(target.docType)
  const fee = declaredActionFeeFor(moderatedContract(target.contract).contractId, 'report', 'create')
  const feeCredits = fee ? Number(fee.owner + fee.moderators) : 0
  const { contract, docType, targetId, ownerId } = target
  useEffect(() => {
    let cancelled = false
    contractReportService.own(reporterId, { contract, docType, targetId, ownerId }).then(report => {
      if (!cancelled) { setOwn(report); setLoading(false) }
    }).catch(() => { if (!cancelled) { setFailed(true); setLoading(false) } })
    return () => { cancelled = true }
  }, [reporterId, contract, docType, targetId, ownerId])
  const problem = contractReportProblem(contract, reason, note)
  const submit = async () => {
    if (busy || reason === null || !available || problem) return
    setBusy(true)
    try {
      const result = await contractReportService.file(reporterId, target, reason, note)
      if (!result.success) { toast.error(categorizeError(result.error)); return }
      toast.success(result.confirmed === false ? 'Report sent. Waiting for network confirmation.' : 'Report published for the community-elected moderators.')
      close()
    } catch (error) { toast.error(categorizeError(error)) }
    finally { setBusy(false) }
  }
  const withdraw = async () => {
    if (!own || busy) return
    setBusy(true)
    try {
      const result = await contractReportService.withdraw(reporterId, contract, own.id)
      if (!result.success) { toast.error(categorizeError(result.error)); return }
      toast.success(result.confirmed === false ? 'Withdrawal sent. Waiting for network confirmation.' : 'Report withdrawn')
      close()
    } finally { setBusy(false) }
  }
  return <Modal open onOpenChange={value => { if (!value && !busy) close() }} className="w-[440px] max-w-[90vw] max-h-[90vh] overflow-y-auto">
    <ModalTitle>{own ? `You reported this ${noun}` : `Report this ${noun}`}</ModalTitle>
    <Dialog.Description className="text-sm text-gray-500 mb-4">
      Your report goes to on-chain moderators, elected by the community through masternode votes. These teams are independent of Yappr. Reports are public: anyone can see who reported it, the reason and the details. Reports expire after 90 days.
    </Dialog.Description>
    {loading ? <p>Checking your reports…</p> : failed ? <p role="alert">Could not check your reports. Close this window and try again.</p> : own ? <div className="space-y-3">
      <p>You reported it for {reportReasonLabel(own.reason)}.</p>
      {own.note && <p className="whitespace-pre-wrap break-words">{own.note}</p>}
      <p>{own.status === null ? 'Waiting for moderator review.' : `Resolved: ${reportStatusLabel(own.status)}.`}</p>
      {own.resolution && <p className="whitespace-pre-wrap break-words">{own.resolution}</p>}
      {own.status === null && <Button variant="outline" disabled={busy} onClick={() => withdraw().catch(error => toast.error(categorizeError(error)))}>Withdraw report</Button>}
    </div> : <div className="space-y-3">
      {feeCredits > 0 && <p className="text-xs text-gray-500">Filing a report pays a moderation fee of {(feeCredits / 1_000_000).toLocaleString()}M credits (about {(feeCredits / 1_000_000 * 0.06).toFixed(2)}¢), plus the network fee.</p>}
      {!available && <p role="status">{POSTING_CLOSED_COPY}</p>}
      <fieldset disabled={busy} className="space-y-2">
        <legend className="font-medium mb-2">What is wrong with it?</legend>
        {REPORT_REASONS.map(option => <label key={option.code} className="flex items-start gap-2 text-sm">
          <input type="radio" name="contract-report-reason" checked={reason === option.code} onChange={() => setReason(option.code)} />
          <span>{option.label}<span className="block text-xs text-gray-500">{option.hint}</span></span>
        </label>)}
      </fieldset>
      {reason !== null && isUrgentReason(reason) && <p role="alert" className="text-sm text-red-500">If a child is in danger, contact your local police now. Report to the <a href="https://report.cybertip.org/" target="_blank" rel="noopener noreferrer" className="underline">NCMEC CyberTipline</a> and <a href={`mailto:${MODERATION_EMAIL}`} className="underline">email support</a>. Do not share or describe the material here.</p>}
      <label className="block text-sm">Details {reason === OTHER_REASON_CODE ? '(required)' : '(optional)'}
        <LimitedTextarea contract={contract} document="report" field="note" value={note} onChange={e => setNote(e.target.value)} disabled={busy} placeholder="Anything the moderators should know" />
      </label>
      <Button disabled={busy || !available || problem !== null} onClick={submit}>{busy ? 'Reporting…' : `Report ${noun}`}</Button>
    </div>}
    <Button className="mt-3" variant="outline" disabled={busy} onClick={close}>Close</Button>
  </Modal>
}
