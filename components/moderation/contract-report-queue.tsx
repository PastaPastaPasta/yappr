'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import toast from 'react-hot-toast'
import { useAuth } from '@/contexts/auth-context'
import { Button } from '@/components/ui/button'
import { LimitedTextarea } from '@/components/ui/limited-text'
import { documentNoun } from '@/lib/moderated-contracts'
import { categorizeError } from '@/lib/error-utils'
import { isUrgentReason, reportReasonLabel, reportStatusLabel, reportStatuses, resolutionInputProblem, type ReportStatus, type ReportView } from '@/lib/reports'
import { contractReportService, type ContractReport, type ContractReportCursor, type ReportingContract } from '@/lib/services/contract-report-service'
import { moderationServiceFor } from '@/lib/services/moderation-service'
import { useModeratorHideModal, type ModeratorHideAction } from '@/hooks/use-moderator-hide-modal'
import { CharterReasonPicker, type SeatedReasonsState } from './charter-reason-picker'

export function ContractReportQueue({ contract, seatedReasons }: { contract: ReportingContract; seatedReasons: SeatedReasonsState }) {
  const { user } = useAuth()
  const generation = useRef(0)
  const [reports, setReports] = useState<ContractReport[]>([])
  const [view, setView] = useState('open')
  const [next, setNext] = useState<ContractReportCursor>()
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const load = useCallback(async (cursor?: ContractReportCursor) => {
    const request = ++generation.current
    if (!cursor) { setReports([]); setNext(undefined) }
    setLoading(true)
    setFailed(false)
    try {
      const query: ReportView = view === 'mine' && user ? { kind: 'moderatedBy', moderatorId: user.identityId }
        : view === 'open' ? { kind: 'open' } : { kind: 'status', status: Number(view) as ReportStatus }
      const page = await contractReportService.list(contract, query, cursor)
      if (request !== generation.current) return
      setReports(previous => Array.from(new Map([...(cursor ? previous : []), ...page.reports].map(r => [r.id, r])).values()))
      setNext(page.next)
    } catch (error) { if (request === generation.current) { setFailed(true); toast.error(categorizeError(error)) } }
    finally { if (request === generation.current) setLoading(false) }
  }, [contract, user, view])
  useEffect(() => {
    const pending = load()
    const request = generation.current
    pending.catch(error => toast.error(categorizeError(error)))
    return () => { generation.current = request + 1 }
  }, [load])
  const hides = moderationServiceFor(contract).hidesInsteadOfDeleting()
  return <section className="rounded-lg border border-gray-200 dark:border-gray-700 p-4 space-y-3">
    <h3 className="font-semibold">Reports</h3>
    <label className="text-sm">Show <select value={view} onChange={e => setView(e.target.value)} className="bg-transparent border rounded p-1">
      <option value="open">Waiting for review</option>
      {reportStatuses(hides).map(s => <option key={s.code} value={s.code}>{s.label}</option>)}
      <option value="mine">Resolved by me</option>
    </select></label>
    <Button variant="outline" disabled={loading} onClick={() => load()}>Refresh</Button>
    {failed && <p role="alert">Could not load reports. Try refreshing.</p>}
    {!loading && !failed && reports.length === 0 && <p className="text-sm text-gray-500">No reports to show.</p>}
    {reports.map(report => <ReportRow key={report.id} contract={contract} report={report} seatedReasons={seatedReasons} changed={() => load()} />)}
    {loading && <p role="status">Loading reports…</p>}
    {next && <Button disabled={loading} variant="outline" onClick={() => load(next)}>Load more</Button>}
  </section>
}
function ReportRow({ contract, report, seatedReasons, changed }: { contract: ReportingContract; report: ContractReport; seatedReasons: SeatedReasonsState; changed: () => Promise<void> }) {
  const { user } = useAuth()
  const [status, setStatus] = useState<ReportStatus>(report.status ?? 1)
  const [note, setNote] = useState(report.resolution ?? '')
  const [charter, setCharter] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { setStatus(report.status ?? 1); setNote(report.resolution ?? '') }, [report.status, report.resolution])
  const problem = resolutionInputProblem(status, note)
  const unchanged = status === report.status && (note.trim() || null) === report.resolution
  const service = moderationServiceFor(contract)
  /** Blog v10 / storefront v11: the report is resolved after hiding its target or restricting its author. */
  const hides = service.hidesInsteadOfDeleting()
  const { open: openHide } = useModeratorHideModal()
  const act = (action: ModeratorHideAction) => {
    openHide({
      action,
      contract,
      docType: report.docType,
      documentId: report.targetId,
      authorId: report.targetOwnerId,
      noun: documentNoun(report.docType),
      preview: destination?.preview,
    }, () => setStatus(action === 'hide' ? 2 : 3))
  }
  const resolve = async () => {
    if (!user || busy || problem) return
    setBusy(true)
    try {
      const result = await moderationServiceFor(contract).resolveReports(user.identityId, [report], { status, note }, {
        text: note.trim() || reportStatusLabel(status, hides),
        documents: [{ documentTypeName: report.docType, documentId: report.targetId }],
        ...(charter ? { reasonDocumentId: charter } : {}),
      })
      // The moderator closed the key sheet: nothing was signed.
      if (result.errorCode === 'CANCELLED') return
      if (!result.success) { toast.error(result.error || 'Could not resolve this report'); return }
      if (result.gone.includes(report.id)) toast('This report has expired or was withdrawn')
      else if (result.alreadyResolved.includes(report.id)) toast('Another moderator already resolved this report')
      else toast.success('Report resolved')
      await changed()
    } catch (error) { toast.error(categorizeError(error)) }
    finally { setBusy(false) }
  }
  const citation = `/settings?section=moderation&contract=${contract}&author=${report.targetOwnerId}&cite=${report.docType}:${report.targetId}`
  const [destination, setDestination] = useState<{ href: string; preview: string } | null>(null)
  useEffect(() => {
    let cancelled = false
    contractReportService.destination(contract, report).then(value => { if (!cancelled) setDestination(value) })
      .catch(() => { if (!cancelled) setDestination(null) })
    return () => { cancelled = true }
  }, [contract, report])
  return <article className="border-t border-gray-200 dark:border-gray-700 pt-3 space-y-2 text-sm">
    <p className={isUrgentReason(report.reason) ? 'font-semibold text-red-500' : 'font-medium'}>{documentNoun(report.docType)} · {reportReasonLabel(report.reason)}</p>
    <p className="text-xs text-gray-500">Reported {new Date(report.createdAt).toLocaleDateString()} by <Link className="underline" href={`/user?id=${report.reporterId}`}>{report.reporterId.slice(0, 8)}…</Link></p>
    {report.note && <p className="whitespace-pre-wrap break-words">{report.note}</p>}
    <p>{report.status === null ? 'Waiting for review' : reportStatusLabel(report.status, hides)}</p>
    {destination?.preview && <p className="whitespace-pre-wrap break-words">{destination.preview}</p>}
    {destination && <Link href={destination.href} className="underline mr-3">View {documentNoun(report.docType)}</Link>}
    <Link href={citation} className="underline">{hides ? 'Warn the author' : 'Moderate author'}</Link>
    {hides && (
      <div className="flex flex-wrap gap-2">
        {service.canHide(report.docType) && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => act('hide')}>Hide {documentNoun(report.docType)}</Button>
        )}
        {service.canRestrict() && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => act('restrict')}>Restrict the author</Button>
        )}
      </div>
    )}
    <label className="block">Outcome <select value={status} onChange={e => setStatus(Number(e.target.value) as ReportStatus)} className="bg-transparent border rounded p-1">
      {reportStatuses(hides).map(s => <option key={s.code} value={s.code}>{s.label}</option>)}
    </select></label>
    <label className="block">Resolution (optional, public)<LimitedTextarea contract={contract} document="report" field="resolution" value={note} onChange={e => setNote(e.target.value)} disabled={busy} /></label>
    <CharterReasonPicker id={`report-charter-${report.id}`} state={seatedReasons} value={charter} onChange={setCharter} />
    <Button disabled={busy || seatedReasons.loading || seatedReasons.failed || (seatedReasons.required && !charter) || problem !== null || unchanged} onClick={resolve}>{busy ? 'Resolving…' : 'Resolve report'}</Button>
  </article>
}
