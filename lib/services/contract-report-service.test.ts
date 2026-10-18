import { beforeEach, describe, expect, it, vi } from 'vitest'
import bs58 from 'bs58'
const mocks = vi.hoisted(() => ({ query: vi.fn(), create: vi.fn(), remove: vi.fn(), enabled: true }))
vi.mock('./document-service', () => ({ queryRawDocuments: mocks.query }))
vi.mock('./state-transition-service', () => ({ stateTransitionService: { createDocument: mocks.create, deleteDocument: mocks.remove } }))
vi.mock('@/lib/moderated-contracts', async importOriginal => {
  const real = await importOriginal<typeof import('@/lib/moderated-contracts')>()
  return { ...real, moderatedContract: (key: 'blog' | 'storefront') => ({
    contractId: key, reportsResolved: () => mocks.enabled,
    reportTargets: () => mocks.enabled ? (key === 'blog' ? [{ field: 'blogId', docType: 'blog' }, { field: 'blogPostId', docType: 'blogPost' }, { field: 'blogCommentId', docType: 'blogComment' }] : [{ field: 'storeId', docType: 'store' }, { field: 'itemId', docType: 'storeItem' }, { field: 'storeReviewId', docType: 'storeReview' }, { field: 'itemReviewId', docType: 'itemReview' }]) : [],
  }) }
})
import { contractReportService as service, contractReportProblem, type ContractReportTarget } from './contract-report-service'
const id = (n: number) => bs58.encode(new Uint8Array(32).fill(n))
const [reporter, owner, targetId] = [id(1), id(2), id(3)]
beforeEach(() => { mocks.enabled = true; mocks.query.mockReset().mockResolvedValue([]); mocks.create.mockReset().mockResolvedValue({ success: true }); mocks.remove.mockReset() })
describe('per-contract reports', () => {
  it.each([
    ['storefront', 'store', 'storeId'], ['storefront', 'storeItem', 'itemId'],
    ['storefront', 'storeReview', 'storeReviewId'], ['storefront', 'itemReview', 'itemReviewId'],
    ['blog', 'blog', 'blogId'], ['blog', 'blogPost', 'blogPostId'], ['blog', 'blogComment', 'blogCommentId'],
  ] as const)('uses %s %s target and unique index', async (contract, docType, field) => {
    const target: ContractReportTarget = { contract, docType, targetId, ownerId: owner }
    await service.own(reporter, target)
    expect(mocks.query.mock.calls[0][0]).toMatchObject({ dataContractId: contract, where: [[field, '==', targetId], ['$ownerId', '==', reporter]] })
    await service.file(reporter, target, 8, ' details ')
    expect(mocks.create).toHaveBeenCalledWith(contract, 'report', reporter, { [field]: new Uint8Array(32).fill(3), targetOwnerId: new Uint8Array(32).fill(2), reason: 8, note: 'details' })
  })
  it.each([
    ['storefront', 'store', { name: 'Shop' }, `/store/view?id=${targetId}`],
    ['storefront', 'storeItem', { title: 'Item' }, `/item?id=${targetId}`],
    ['storefront', 'storeReview', { storeId: owner, content: 'Review' }, `/store/view?id=${owner}`],
    ['storefront', 'itemReview', { itemId: owner, content: 'Review' }, `/item?id=${owner}`],
    ['blog', 'blog', { name: 'Blog' }, `/blog?blog=${targetId}`],
    ['blog', 'blogPost', { blogId: owner, slug: 'my-post', title: 'Post' }, `/blog?blog=${owner}&post=my-post`],
    ['blog', 'blogComment', { blogPostId: reporter, content: 'Comment' }, `/blog?blog=${owner}&post=my-post`],
  ] as const)('links reported %s %s to its public page', async (contract, docType, data, href) => {
    mocks.query.mockResolvedValueOnce([{ data }]).mockResolvedValueOnce([{ data: { blogId: owner, slug: 'my-post' } }])
    const report = { id: 'r', reporterId: reporter, targetId, targetOwnerId: owner, reason: 0, note: null, createdAt: 1, status: null, resolution: null, moderatedBy: null, moderatedAt: null, box: null, docType }
    expect(await service.destination(contract, report)).toMatchObject({ href })
    if (docType === 'blogComment') expect(mocks.query.mock.calls[1][0]).toMatchObject({ documentTypeName: 'blogPost', where: [['$id', '==', reporter]] })
  })
  it('refuses own reports, byte overflow and unavailable report types before signing', async () => {
    const target: ContractReportTarget = { contract: 'blog', docType: 'blog', targetId, ownerId: owner }
    expect((await service.file(owner, target, 0, '')).success).toBe(false)
    expect(contractReportProblem('blog', 8, '')).toBeTruthy()
    expect((await service.file(reporter, target, 0, '😀'.repeat(376))).success).toBe(false)
    mocks.enabled = false
    expect((await service.file(reporter, target, 0, '')).success).toBe(false)
    expect(await service.list('blog', { kind: 'open' })).toEqual({ reports: [] })
    expect(mocks.create).not.toHaveBeenCalled()
  })
  it('keeps resolved reports instead of issuing a paid refused delete', async () => {
    mocks.query.mockResolvedValue([{ $id: 'report', $ownerId: reporter, blogId: targetId, targetOwnerId: owner, reason: 0, status: 1 }])
    expect((await service.withdraw(reporter, 'blog', 'report')).success).toBe(false)
    expect(mocks.remove).not.toHaveBeenCalled()
  })
  it('reads open reports and moderator history through the matching indexes', async () => {
    await service.list('blog', { kind: 'open' })
    expect(mocks.query.mock.calls[0][0]).toMatchObject({ where: [['status', '==', null], ['$createdAt', '>', 0]], orderBy: [['status', 'asc'], ['$createdAt', 'desc']] })
    await service.list('storefront', { kind: 'moderatedBy', moderatorId: reporter })
    expect(mocks.query.mock.calls[1][0]).toMatchObject({ dataContractId: 'storefront', where: [['$moderatedBy', '==', reporter], ['$moderatedAt', '>', 0]] })
  })
})
