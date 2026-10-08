/**
 * The queries the moderators' report queue sends (v10 `byStatus` /
 * `byModerator`, v9 `byTime`). Drive is mocked; verify-v10 r1m/r1n is the
 * live check of the indexes themselves.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const queryRawDocuments = vi.hoisted(() => vi.fn())
const createDocument = vi.hoisted(() => vi.fn())
const deleteDocument = vi.hoisted(() => vi.fn())
const V12_SHAPE = { maxReason: 8, profiles: false, boxMaxBytes: null, targetFirst: false }
const V13_SHAPE = { maxReason: 9, profiles: true, boxMaxBytes: 5_120, targetFirst: true }
const topology = vi.hoisted(() => ({ resolved: true, pendingOnly: false, shape: {} as Record<string, unknown> }))

vi.mock('./document-service', () => ({ queryRawDocuments }))
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => ({}) }))
vi.mock('./state-transition-service', () => ({ stateTransitionService: { createDocument, deleteDocument } }))
vi.mock('../contract-topology', () => ({
  contractTakesReports: () => true,
  reportsAreResolved: () => topology.resolved,
  reportShape: () => topology.shape,
  reportsWithdrawOnlyWhilePending: () => topology.pendingOnly,
}))

import bs58 from 'bs58'
import { reportInputShapeProblem, reportService } from './report-service'
import { REPORT_RESOLVED_MESSAGE } from '../reports'

const report = (id: string, extra: Record<string, unknown> = {}) => ({
  $id: id, $ownerId: 'reporter', $createdAt: 1000, postId: 'post', targetOwnerId: 'author', reason: 0, ...extra,
})

describe('listView', () => {
  beforeEach(() => {
    queryRawDocuments.mockReset()
    topology.resolved = true
  })

  it('reads the open queue from byStatus with a null status', async () => {
    queryRawDocuments.mockResolvedValueOnce([report('r1')])
    const { reports, next } = await reportService.listView({ kind: 'open' })
    expect(reports.map((r) => r.id)).toEqual(['r1'])
    expect(next).toBeUndefined()
    expect(queryRawDocuments).toHaveBeenCalledWith(expect.objectContaining({
      where: [['status', '==', null], ['$createdAt', '>', 0]],
      orderBy: [['status', 'asc'], ['$createdAt', 'desc']],
    }))
  })

  it("pages a moderator's history by \$moderatedAt and resumes a gone cursor at that time", async () => {
    queryRawDocuments
      .mockResolvedValueOnce([report('r1', { status: 1, $moderatedBy: 'mod', $moderatedAt: 5000 })])
      .mockRejectedValueOnce(new Error('startAfter document not found'))
      .mockResolvedValueOnce([])
    const view = { kind: 'moderatedBy', moderatorId: 'mod' } as const
    const first = await reportService.listView(view, undefined, 1)
    expect(first.next).toEqual({ id: 'r1', createdAt: 5000 })
    await reportService.listView(view, first.next, 1)
    expect(queryRawDocuments.mock.calls[0][0]).toMatchObject({
      where: [['$moderatedBy', '==', 'mod'], ['$moderatedAt', '>', 0]],
      orderBy: [['$moderatedBy', 'asc'], ['$moderatedAt', 'desc']],
    })
    expect(queryRawDocuments.mock.calls[1][0]).toMatchObject({ startAfter: 'r1' })
    expect(queryRawDocuments.mock.calls[2][0]).toMatchObject({ where: [['$moderatedBy', '==', 'mod'], ['$moderatedAt', '<=', 5000]] })
    expect(queryRawDocuments.mock.calls[2][0]).not.toHaveProperty('startAfter')
  })

  it('lists every report as open, and nothing as resolved, where reports are not resolved (v9)', async () => {
    topology.resolved = false
    queryRawDocuments.mockResolvedValueOnce([report('r1')])
    expect((await reportService.listView({ kind: 'status', status: 2 })).reports).toEqual([])
    expect((await reportService.listView({ kind: 'open' })).reports.map((r) => r.id)).toEqual(['r1'])
    expect(queryRawDocuments).toHaveBeenCalledTimes(1)
    expect(queryRawDocuments.mock.calls[0][0]).toMatchObject({ where: [['$createdAt', '>', 0]], orderBy: [['$createdAt', 'desc']] })
  })
})

describe('a reporter\'s own report and a new one', () => {
  const id = (fill: number) => bs58.encode(new Uint8Array(32).fill(fill))
  const [REPORTER, POST, AUTHOR] = [id(1), id(2), id(3)]

  beforeEach(() => {
    queryRawDocuments.mockReset().mockResolvedValue([])
    createDocument.mockReset().mockResolvedValue({ success: true })
  })

  it('reads "did I report this" in the unique index\'s order: target first on v13, the reporter first before', async () => {
    topology.shape = V13_SHAPE
    await reportService.getOwnReport(REPORTER, 'post', POST)
    expect(queryRawDocuments.mock.calls[0][0].where).toEqual([['postId', '==', POST], ['$ownerId', '==', REPORTER]])
    await reportService.getOwnReport(REPORTER, 'profile', AUTHOR)
    expect(queryRawDocuments.mock.calls[1][0].where).toEqual([['targetOwnerId', '==', AUTHOR], ['about', '==', 1], ['$ownerId', '==', REPORTER]])

    topology.shape = V12_SHAPE
    await reportService.getOwnReport(REPORTER, 'reply', POST)
    expect(queryRawDocuments.mock.calls[2][0].where).toEqual([['$ownerId', '==', REPORTER], ['replyId', '==', POST]])
    // No profile reports before v13: nothing to read.
    await expect(reportService.getOwnReport(REPORTER, 'profile', AUTHOR)).resolves.toBeNull()
    expect(queryRawDocuments).toHaveBeenCalledTimes(3)
  })

  it('files a profile report as about: 1 with no post or reply, and a private post report with its box', async () => {
    topology.shape = V13_SHAPE
    await reportService.fileReport(REPORTER, { kind: 'profile', targetId: AUTHOR, targetOwnerId: AUTHOR, reason: 7 })
    const profile = createDocument.mock.calls[0][3]
    expect(Object.keys(profile).sort()).toEqual(['about', 'reason', 'targetOwnerId'])
    expect(profile.about).toBe(1)

    const box = new Uint8Array(200)
    await reportService.fileReport(REPORTER, { kind: 'post', targetId: POST, targetOwnerId: AUTHOR, reason: 9, box })
    const post = createDocument.mock.calls[1][3]
    expect(Object.keys(post).sort()).toEqual(['box', 'postId', 'reason', 'targetOwnerId'])
    expect(post.box).toBe(box)
  })

  it('refuses before signing what oneTarget, boxOnContent or the box size would', () => {
    topology.shape = V13_SHAPE
    expect(reportInputShapeProblem({ kind: 'profile', targetId: POST, targetOwnerId: AUTHOR })).toMatch(/reported identity/)
    expect(reportInputShapeProblem({ kind: 'profile', targetId: AUTHOR, targetOwnerId: AUTHOR, box: new Uint8Array(10) })).toMatch(/no box/)
    expect(reportInputShapeProblem({ kind: 'post', targetId: POST, targetOwnerId: AUTHOR, box: new Uint8Array(5_121) })).toMatch(/1 to 5120/)
    expect(reportInputShapeProblem({ kind: 'post', targetId: POST, targetOwnerId: AUTHOR, box: new Uint8Array(5_120) })).toBeNull()
    topology.shape = V12_SHAPE
    expect(reportInputShapeProblem({ kind: 'profile', targetId: AUTHOR, targetOwnerId: AUTHOR })).toMatch(/cannot be reported/)
    expect(reportInputShapeProblem({ kind: 'post', targetId: POST, targetOwnerId: AUTHOR, box: new Uint8Array(10) })).toMatch(/no box/)
  })
})

describe('withdrawing a report', () => {
  beforeEach(() => {
    queryRawDocuments.mockReset()
    deleteDocument.mockReset().mockResolvedValue({ success: true })
  })

  it('v14: re-reads the report, and refuses a resolved one before signing (40147 would be paid)', async () => {
    topology.pendingOnly = true
    queryRawDocuments.mockResolvedValueOnce([report('r1', { status: 2 })])
    expect(await reportService.withdrawReport('reporter', 'r1')).toEqual({ success: false, error: REPORT_RESOLVED_MESSAGE })
    expect(queryRawDocuments.mock.calls[0][0]).toMatchObject({ documentTypeName: 'report', where: [['$id', '==', 'r1']], limit: 1 })
    expect(deleteDocument).not.toHaveBeenCalled()

    queryRawDocuments.mockResolvedValueOnce([report('r2')])
    expect(await reportService.withdrawReport('reporter', 'r2')).toEqual({ success: true })
    // Gone already: the delete itself says so (40101).
    queryRawDocuments.mockResolvedValueOnce([])
    await reportService.withdrawReport('reporter', 'r3')
    expect(deleteDocument.mock.calls.map((call) => call[2])).toEqual(['r2', 'r3'])
  })

  it('v14: does not delete when the re-read fails', async () => {
    topology.pendingOnly = true
    queryRawDocuments.mockRejectedValueOnce(new Error('offline'))
    expect(await reportService.withdrawReport('reporter', 'r1')).toEqual({ success: false, error: 'offline' })
    expect(deleteDocument).not.toHaveBeenCalled()
  })

  it('before v14: deletes at once, resolved or not', async () => {
    topology.pendingOnly = false
    await reportService.withdrawReport('reporter', 'r1')
    expect(queryRawDocuments).not.toHaveBeenCalled()
    expect(deleteDocument).toHaveBeenCalledTimes(1)
  })
})
