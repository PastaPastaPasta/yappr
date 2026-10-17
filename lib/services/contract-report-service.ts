import { moderatedContract, type ModeratedContractKey } from '@/lib/moderated-contracts'
import { fieldLimits } from '@/lib/field-limits'
import { fitsText } from '@/lib/text-limits'
import { OTHER_REASON_CODE, REPORT_REASONS, toReportRecord, type ReportRecord, type ReportView } from '@/lib/reports'
import { extractErrorMessage } from '@/lib/error-utils'
import { queryRawDocuments } from './document-service'
import { identifierStringToDocumentBytes, identifierToBase58, type DocumentWhereClause, type DocumentOrderByClause } from './sdk-helpers'
import { stateTransitionService, type StateTransitionResult } from './state-transition-service'

export type ReportingContract = Exclude<ModeratedContractKey, 'social'>
export interface ContractReportTarget { contract: ReportingContract; docType: string; targetId: string; ownerId: string }
export interface ContractReportCursor { id: string; time: number }
export interface ContractReport extends Omit<ReportRecord, 'kind'> { docType: string }
const fieldFor = (target: ContractReportTarget) => moderatedContract(target.contract).reportTargets().find(t => t.docType === target.docType)?.field
export function contractReportProblem(contract: ReportingContract, reason: number | null, note: string): string | null {
  if (!REPORT_REASONS.some(r => r.code === reason)) return 'Choose why you are reporting this'
  if (reason === OTHER_REASON_CODE && !note.trim()) return 'Say what is wrong with it'
  return fitsText(note.trim(), fieldLimits(contract, 'report', 'note')) ? null : 'Shorten the details before sending your report'
}
function records(contract: ReportingContract, docs: Record<string, unknown>[]): ContractReport[] {
  const targets = moderatedContract(contract).reportTargets()
  return docs.flatMap(doc => {
    const data = (doc.data ?? doc) as Record<string, unknown>
    const target = targets.find(t => data[t.field] != null)
    if (!target) return []
    const record = toReportRecord({ ...doc, data: { ...data, postId: data[target.field] } })
    if (!record) return []
    const { kind, ...rest } = record
    return kind === 'post' ? [{ ...rest, docType: target.docType }] : []
  })
}
export const contractReportService = {
  async destination(contract: ReportingContract, report: ContractReport): Promise<{ href: string; preview: string } | null> {
    const read = async (type: string, id: string) => {
      const docs = await queryRawDocuments({ dataContractId: moderatedContract(contract).contractId, documentTypeName: type, where: [['$id', '==', id]], limit: 1 })
      return docs[0] ? (docs[0].data ?? docs[0]) as Record<string, unknown> : null
    }
    const target = await read(report.docType, report.targetId)
    if (!target) return null
    const preview = String(target.title ?? target.name ?? target.content ?? '').slice(0, 500)
    if (contract === 'storefront') {
      const item = report.docType === 'storeItem' || report.docType === 'itemReview'
      const id = report.docType === 'store' || report.docType === 'storeItem' ? report.targetId : identifierToBase58(item ? target.itemId : target.storeId)
      return id ? { href: `${item ? '/item' : '/store/view'}?id=${id}`, preview } : null
    }
    if (report.docType === 'blog') return { href: `/blog?blog=${report.targetId}`, preview }
    const postId = identifierToBase58(target.blogPostId)
    const post = report.docType === 'blogPost' ? target : postId ? await read('blogPost', postId) : null
    const blogId = post && identifierToBase58(post.blogId)
    return blogId && post ? { href: `/blog?blog=${blogId}&post=${encodeURIComponent(String(post.slug))}`, preview } : null
  },
  async own(reporterId: string, target: ContractReportTarget): Promise<ContractReport | null> {
    const field = fieldFor(target)
    if (!field) throw new Error('Reporting is not available here yet')
    return records(target.contract, await queryRawDocuments({
      dataContractId: moderatedContract(target.contract).contractId, documentTypeName: 'report',
      where: [[field, '==', target.targetId], ['$ownerId', '==', reporterId]], limit: 1,
    }))[0] ?? null
  },
  async file(reporterId: string, target: ContractReportTarget, reason: number, note: string): Promise<StateTransitionResult> {
    const field = fieldFor(target)
    const problem = contractReportProblem(target.contract, reason, note)
    if (!field || problem || reporterId === target.ownerId) return { success: false, error: problem ?? 'You cannot report your own content' }
    return stateTransitionService.createDocument(moderatedContract(target.contract).contractId, 'report', reporterId, {
      [field]: identifierStringToDocumentBytes(target.targetId), targetOwnerId: identifierStringToDocumentBytes(target.ownerId),
      reason, ...(note.trim() ? { note: note.trim() } : {}),
    })
  },
  async withdraw(reporterId: string, contract: ReportingContract, id: string): Promise<StateTransitionResult> {
    try {
      const stored = records(contract, await queryRawDocuments({ dataContractId: moderatedContract(contract).contractId,
        documentTypeName: 'report', where: [['$id', '==', id]], limit: 1 }))[0]
      if (stored?.status != null) return { success: false, error: 'This report has already been resolved and cannot be withdrawn' }
      return stateTransitionService.deleteDocument(moderatedContract(contract).contractId, 'report', id, reporterId)
    } catch (error) { return { success: false, error: extractErrorMessage(error) } }
  },
  async list(contract: ReportingContract, view: ReportView, cursor?: ContractReportCursor): Promise<{ reports: ContractReport[]; next?: ContractReportCursor }> {
    if (!moderatedContract(contract).reportsResolved()) return { reports: [] }
    const history = view.kind === 'moderatedBy'
    const order = history ? '$moderatedAt' : '$createdAt'
    const equal: DocumentWhereClause = history ? ['$moderatedBy', '==', view.moderatorId]
      : ['status', '==', view.kind === 'status' ? view.status : null]
    const orderBy: DocumentOrderByClause[] = [[equal[0], 'asc'], [order, 'desc']]
    const page = (resumeAtTime = false) => queryRawDocuments({ dataContractId: moderatedContract(contract).contractId, documentTypeName: 'report',
      where: [equal, [order, resumeAtTime ? '<=' : '>', resumeAtTime ? cursor?.time ?? 0 : 0]], orderBy, limit: 50,
      ...(cursor && !resumeAtTime ? { startAfter: cursor.id } : {}) })
    let docs: Record<string, unknown>[]
    try { docs = await page() }
    catch (error) {
      if (!cursor || !/startafter document not found|startdocumentnotfound/i.test(extractErrorMessage(error))) throw error
      docs = await page(true)
    }
    const reports = records(contract, docs)
    const last = reports[reports.length - 1]
    return { reports, ...(docs.length === 50 && last ? { next: { id: last.id, time: history ? last.moderatedAt ?? 0 : last.createdAt } } : {}) }
  },
}
