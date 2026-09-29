import bs58 from 'bs58'
import { describe, expect, it } from 'vitest'
import socialContractV9 from '@/contracts/yappr-social-contract-v9.json'
import socialContractV10 from '@/contracts/yappr-social-contract-v10.json'
import {
  OPEN_REPORTS,
  OTHER_REASON_CODE,
  REPORT_NOTE_MAX_LENGTH,
  REPORT_REASONS,
  REPORT_RESOLUTION_MAX_LENGTH,
  REPORT_STATUSES,
  groupReports,
  isAlreadyReportedError,
  isReportGoneError,
  reportFailureMessage,
  reportInputProblem,
  reportMatchesView,
  reportReasonLabel,
  reportStatusLabel,
  reportsNeedingResolution,
  resolutionInputProblem,
  toReportRecord,
  withdrawFailureMessage,
  type ReportRecord,
} from './reports'

const schema = (socialContractV9.documentSchemas as unknown as Record<string, {
  properties: Record<string, { minimum?: number; maximum?: number; maxLength?: number }>
  propertyConstraints: Record<string, unknown>
}>).report

// v10 keeps the reporter's fields byte for byte; only the moderators' status/resolution are new.
const reporterFields = ['postId', 'replyId', 'targetOwnerId', 'reason', 'note'] as const
const v10Schema = (socialContractV10.documentSchemas as unknown as Record<string, { properties: Record<string, unknown> }>).report

describe('the report fields the client writes are the same on v9 and v10', () => {
  it('pins every reporter field of v10 to v9 (the refersTo differs only by the beta.7 grammar)', () => {
    const valueShape = (definition: unknown) => {
      const copy = { ...(definition as Record<string, unknown>) }
      delete copy.refersTo
      return copy
    }
    for (const field of reporterFields) expect(valueShape(v10Schema.properties[field]), field).toEqual(valueShape(schema.properties[field]))
  })
})

const idOf = (fill: number) => bs58.encode(new Uint8Array(32).fill(fill))

const record = (overrides: Partial<ReportRecord>): ReportRecord => ({
  id: idOf(1),
  reporterId: idOf(2),
  kind: 'post',
  targetId: idOf(3),
  targetOwnerId: idOf(4),
  reason: 0,
  note: null,
  createdAt: 1_000,
  status: null,
  resolution: null,
  moderatedBy: null,
  moderatedAt: null,
  ...overrides,
})

describe('report lifetime', () => {
  it('matches the 90 days the dialog and the queue promise', () => {
    const report = (socialContractV9.documentSchemas as unknown as Record<string, { ttl?: number; required: string[] }>).report
    expect(report.ttl).toBe(90 * 24 * 60 * 60)
    expect(report.required).toContain('$createdAt')
  })
})

describe('report reasons', () => {
  it('should cover exactly the codes the v9 contract accepts', () => {
    expect(REPORT_REASONS.map((reason) => reason.code)).toEqual(REPORT_REASONS.map((_, index) => index))
    expect(schema.properties.reason.minimum).toBe(0)
    expect(schema.properties.reason.maximum).toBe(REPORT_REASONS.length - 1)
  })

  it('should treat as "something else" the code the contract demands a note for', () => {
    expect(schema.propertyConstraints.otherHasNote).toEqual({
      anyOf: [{ notEqual: ['reason', OTHER_REASON_CODE] }, { present: 'note' }],
    })
    expect(reportReasonLabel(OTHER_REASON_CODE)).toBe('Something else')
    expect(schema.properties.note.maxLength).toBe(REPORT_NOTE_MAX_LENGTH)
  })

  it('should label an unknown code rather than fail', () => {
    expect(reportReasonLabel(0)).toBe('Spam or scam')
    expect(reportReasonLabel(42)).toBe('Reason 42')
  })
})

describe('reportInputProblem', () => {
  it('should accept a listed reason with or without details', () => {
    expect(reportInputProblem(0, '')).toBeNull()
    expect(reportInputProblem(3, 'threatens a named person')).toBeNull()
    expect(reportInputProblem(OTHER_REASON_CODE, 'copies my artwork')).toBeNull()
  })

  it('should refuse what the contract would refuse', () => {
    expect(reportInputProblem(null, '')).toMatch(/choose/i)
    expect(reportInputProblem(99, '')).toMatch(/choose/i)
    expect(reportInputProblem(OTHER_REASON_CODE, '   ')).toMatch(/say what/i)
    expect(reportInputProblem(0, 'x'.repeat(REPORT_NOTE_MAX_LENGTH + 1))).toMatch(/500/)
  })
})

describe('toReportRecord', () => {
  it('should read a post report with byte-array identifiers', () => {
    const doc = {
      $id: idOf(9), $ownerId: idOf(8), $createdAt: 5_000,
      postId: new Uint8Array(32).fill(7), targetOwnerId: new Uint8Array(32).fill(6), reason: 2,
    }
    expect(toReportRecord(doc)).toEqual({
      id: idOf(9), reporterId: idOf(8), kind: 'post', targetId: idOf(7), targetOwnerId: idOf(6), reason: 2, note: null, createdAt: 5_000,
      status: null, resolution: null, moderatedBy: null, moderatedAt: null,
    })
  })

  it('should read a v10 resolution and the moderator stamp', () => {
    const doc = {
      $id: idOf(9), $ownerId: idOf(8), $createdAt: 5_000, postId: idOf(7), targetOwnerId: idOf(6), reason: 0,
      status: 2, resolution: 'Taken down', $moderatedBy: new Uint8Array(32).fill(5), $moderatedAt: 9_000,
    }
    expect(toReportRecord(doc)).toMatchObject({ status: 2, resolution: 'Taken down', moderatedBy: idOf(5), moderatedAt: 9_000 })
  })

  it('should treat a status outside 1..3 as open rather than invent a label', () => {
    const doc = { $id: idOf(9), $ownerId: idOf(8), postId: idOf(7), targetOwnerId: idOf(6), reason: 0, status: 7, resolution: '' }
    expect(toReportRecord(doc)).toMatchObject({ status: null, resolution: null, moderatedBy: null, moderatedAt: null })
  })

  it('should read a reply report and its note', () => {
    const doc = { $id: idOf(9), $ownerId: idOf(8), $createdAt: 5_000, replyId: idOf(7), targetOwnerId: idOf(6), reason: 8, note: 'why' }
    expect(toReportRecord(doc)).toMatchObject({ kind: 'reply', targetId: idOf(7), reason: 8, note: 'why' })
  })

  it('should drop a document naming no target', () => {
    expect(toReportRecord({ $id: idOf(9), $ownerId: idOf(8), targetOwnerId: idOf(6), reason: 0 })).toBeNull()
  })

  it('should drop a document with no target owner or no integer reason', () => {
    const base = { $id: idOf(9), $ownerId: idOf(8), postId: idOf(7) }
    expect(toReportRecord({ ...base, reason: 0 })).toBeNull()
    expect(toReportRecord({ ...base, targetOwnerId: idOf(6) })).toBeNull()
    expect(toReportRecord({ ...base, targetOwnerId: idOf(6), reason: 'spam' })).toBeNull()
  })
})

describe('groupReports', () => {
  it('should group by target, newest-reported target first, newest report first', () => {
    const post = idOf(3)
    const reply = idOf(5)
    const groups = groupReports([
      record({ id: idOf(10), targetId: post, reason: 0, createdAt: 1_000 }),
      record({ id: idOf(11), kind: 'reply', targetId: reply, reason: 1, createdAt: 2_000 }),
      record({ id: idOf(12), targetId: post, reason: 1, createdAt: 3_000 }),
      record({ id: idOf(13), targetId: post, reason: 1, createdAt: 1_500 }),
    ])
    expect(groups.map((group) => [group.kind, group.targetId])).toEqual([['post', post], ['reply', reply]])
    expect(groups[0].reports.map((report) => report.id)).toEqual([idOf(12), idOf(13), idOf(10)])
    expect(groups[0].latestAt).toBe(3_000)
    expect(groups[0].reasonCounts).toEqual([{ code: 1, count: 2 }, { code: 0, count: 1 }])
  })

  it('should keep a post and a reply with the same id apart', () => {
    const shared = idOf(3)
    const groups = groupReports([record({ id: idOf(10), targetId: shared }), record({ id: idOf(11), kind: 'reply', targetId: shared })])
    expect(groups).toHaveLength(2)
  })

  it('should count a report read twice once', () => {
    const report = record({ id: idOf(10) })
    const [group] = groupReports([report, { ...report }])
    expect(group.reports).toHaveLength(1)
    expect(group.reasonCounts).toEqual([{ code: 0, count: 1 }])
  })
})

describe('reportFailureMessage', () => {
  it('should say a second report of the same target is a duplicate', () => {
    const duplicate = 'Document Create transition with id X has duplicate unique properties ["$ownerId","postId"] with other documents'
    expect(isAlreadyReportedError(duplicate)).toBe(true)
    expect(isAlreadyReportedError('ConsensusError { code: 40105 }')).toBe(true)
    expect(reportFailureMessage(duplicate, 'post')).toBe('You have already reported this post.')
  })

  it('should say a removed target is gone, not that an account is', () => {
    const missing = 'referenced document 8xY… of type post not found for path postId'
    expect(reportFailureMessage(missing, 'reply')).toBe('This reply has been removed, so there is nothing to report.')
  })

  it('should read the numeric code a beta.6 SDK error carries, and the (code=n) a write result keeps', () => {
    expect(isAlreadyReportedError({ code: 40105, message: 'refused' })).toBe(true)
    expect(isAlreadyReportedError('Failed to create report: refused (code=40105)')).toBe(true)
  })

  it('should not read an id containing 40105 as a duplicate', () => {
    expect(isAlreadyReportedError('state transition 9a401051f failed')).toBe(false)
  })
})

describe('withdrawFailureMessage', () => {
  it('should say a report dismissed meanwhile is already gone', () => {
    const gone = `${idOf(9)} document not found`
    expect(isReportGoneError(gone)).toBe(true)
    expect(isReportGoneError('ConsensusError { code: 40101 }')).toBe(true)
    expect(withdrawFailureMessage(gone)).toMatch(/already gone/)
  })

  it('should read 40101 as a number or a (code=n) suffix, but not bare digits', () => {
    expect(isReportGoneError({ code: 40101, message: 'refused' })).toBe(true)
    expect(isReportGoneError('Failed to delete: refused (code=40101)')).toBe(true)
    expect(isReportGoneError('transition 7f401015 failed')).toBe(false)
  })

  it('should not read a query cursor that went missing as a withdrawn report', () => {
    expect(isReportGoneError('startAfter document not found')).toBe(false)
  })
})

describe('report resolution (v10)', () => {
  const v10Report = (socialContractV10.documentSchemas as unknown as Record<string, {
    properties: Record<string, { minimum?: number; maximum?: number; minLength?: number; maxLength?: number }>
    moderatorAbilities: { changeFields: string[] }
  }>).report

  it('offers exactly the statuses the v10 contract accepts, and its note limit', () => {
    const { minimum, maximum } = v10Report.properties.status
    expect(REPORT_STATUSES.map((status) => status.code)).toEqual(Array.from({ length: (maximum ?? 0) - (minimum ?? 0) + 1 }, (_, i) => (minimum ?? 0) + i))
    expect(REPORT_RESOLUTION_MAX_LENGTH).toBe(v10Report.properties.resolution.maxLength)
    expect(v10Report.properties.resolution.minLength).toBe(1)
    expect(v10Report.moderatorAbilities.changeFields).toEqual(['status', 'resolution'])
  })

  it('labels each status, and an unknown one without failing', () => {
    expect(reportStatusLabel(1)).toBe('No action taken')
    expect(reportStatusLabel(2)).toBe('Content removed')
    expect(reportStatusLabel(3)).toBe('Author actioned')
    expect(reportStatusLabel(9)).toBe('Status 9')
  })

  it('refuses a missing status or an overlong note before anything is signed', () => {
    expect(resolutionInputProblem(null, '')).toMatch(/choose/i)
    expect(resolutionInputProblem(4, '')).toMatch(/choose/i)
    expect(resolutionInputProblem(2, '')).toBeNull()
    expect(resolutionInputProblem(2, `  ${'x'.repeat(REPORT_RESOLUTION_MAX_LENGTH)}  `)).toBeNull()
    expect(resolutionInputProblem(2, 'x'.repeat(REPORT_RESOLUTION_MAX_LENGTH + 1))).toMatch(/200 characters/)
  })

  it('places a report in the view whose query would return it', () => {
    const open = record({ status: null })
    const removed = record({ status: 2, moderatedBy: idOf(5) })
    expect(reportMatchesView(open, OPEN_REPORTS)).toBe(true)
    expect(reportMatchesView(removed, OPEN_REPORTS)).toBe(false)
    expect(reportMatchesView(removed, { kind: 'status', status: 2 })).toBe(true)
    expect(reportMatchesView(removed, { kind: 'status', status: 1 })).toBe(false)
    expect(reportMatchesView(removed, { kind: 'moderatedBy', moderatorId: idOf(5) })).toBe(true)
    expect(reportMatchesView(open, { kind: 'moderatedBy', moderatorId: idOf(5) })).toBe(false)
  })

  it('leaves out reports that already read that way (a no-op change is refused, 10905)', () => {
    const reports = [
      record({ id: idOf(10) }),
      record({ id: idOf(11), status: 2, resolution: null }),
      record({ id: idOf(12), status: 2, resolution: 'gone' }),
      record({ id: idOf(13), status: 1, resolution: null }),
    ]
    expect(reportsNeedingResolution(reports, 2, null).map((report) => report.id)).toEqual([idOf(10), idOf(12), idOf(13)])
    expect(reportsNeedingResolution(reports, 2, 'gone').map((report) => report.id)).toEqual([idOf(10), idOf(11), idOf(13)])
  })
})
