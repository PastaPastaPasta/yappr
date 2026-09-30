/**
 * The queries the moderators' report queue sends (v10 `byStatus` /
 * `byModerator`, v9 `byTime`). Drive is mocked; verify-v10 r1m/r1n is the
 * live check of the indexes themselves.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const queryRawDocuments = vi.hoisted(() => vi.fn())
const topology = vi.hoisted(() => ({ resolved: true }))

vi.mock('./document-service', () => ({ queryRawDocuments }))
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => ({}) }))
vi.mock('./state-transition-service', () => ({ stateTransitionService: {} }))
vi.mock('../contract-topology', () => ({
  contractTakesReports: () => true,
  reportsAreResolved: () => topology.resolved,
}))

import { reportService } from './report-service'

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
