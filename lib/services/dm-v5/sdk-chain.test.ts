import bs58 from 'bs58'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PENDING_WRITE_ERROR } from '@/lib/error-utils'

const { createDocument, updateDocument, deleteDocument, settlePendingWrites } = vi.hoisted(() => ({
  createDocument: vi.fn(),
  updateDocument: vi.fn(),
  deleteDocument: vi.fn(),
  settlePendingWrites: vi.fn(),
}))
vi.mock('../state-transition-service', () => ({ stateTransitionService: { createDocument, updateDocument, deleteDocument } }))
vi.mock('../identity-nonce', () => ({ settlePendingWrites }))
vi.mock('../evo-sdk-service', () => ({ getEvoSdk: vi.fn() }))
vi.mock('../identity-service', () => ({ identityService: {} }))
vi.mock('../follow-service', () => ({ followService: {} }))
vi.mock('@/lib/secure-storage', () => ({ hasPrivateKey: () => true }))
vi.mock('@/lib/auth/signing-keys', () => ({ hasAppConnectSession: () => false }))
import { SdkDmChain } from './sdk-chain'

const ME = Uint8Array.from({ length: 32 }, (_, i) => i + 1)
const CONTRACT = bs58.encode(Uint8Array.from({ length: 32 }, () => 7))
const bytes = (n: number) => new Uint8Array(n).fill(9)
const doc = { id: 'doc', revision: 5 }

/**
 * The browser's nonce reservations as lib keeps them: an SDK-signed replace whose answer was lost
 * (the page moved on while it waited) holds every later write back with PENDING_WRITE_ERROR until
 * `settlePendingWrites` sees its nonce consumed.
 */
function lostReplaceAnswer() {
  let pending = true
  settlePendingWrites.mockImplementation(async () => {
    const released = pending ? 1 : 0
    pending = false
    return released
  })
  const write = async () => (pending ? { success: false, error: PENDING_WRITE_ERROR } : { success: true, document: { $id: 'new' } })
  createDocument.mockImplementation(write)
  updateDocument.mockImplementation(write)
  deleteDocument.mockImplementation(write)
}

beforeEach(() => {
  vi.clearAllMocks()
  lostReplaceAnswer()
})

describe('SdkDmChain writes after a lost replace answer', () => {
  const chain = () => new SdkDmChain(ME, CONTRACT)
  const writes: Array<[string, (c: SdkDmChain) => Promise<{ ok: boolean }>]> = [
    ['a message (a grant from "Resend keys")', (c) => c.createMessage(bytes(32), bytes(156))],
    ['an invite', (c) => c.createInvite({ bucket: 1, epk: bytes(33), check: bytes(16) })],
    ['a keyring', (c) => c.createGroupDoc(bytes(32), bytes(64))],
    ['a roster replace', (c) => c.replaceGroupDoc(doc, bytes(32), bytes(64))],
    ['a self-state save', (c) => c.replaceSelfState(doc, { blob: bytes(64), blob2: null, blob3: null })],
    ['a sweep delete', (c) => c.deleteMessage('msg')],
  ]

  it.each(writes)('settles it first, so %s goes out instead of failing PENDING_WRITE', async (_, write) => {
    const outcome = await write(chain())
    expect(outcome.ok).toBe(true)
    expect(settlePendingWrites).toHaveBeenCalledWith(bs58.encode(ME), CONTRACT)
  })

  it('still writes when the settle itself fails, and reports what the write returned', async () => {
    settlePendingWrites.mockRejectedValue(new Error('transport'))
    const outcome = await chain().createMessage(bytes(32), bytes(156))
    expect(settlePendingWrites).toHaveBeenCalledTimes(1)
    expect(createDocument).toHaveBeenCalledTimes(1)
    expect(outcome).toMatchObject({ ok: false, failure: 'other', error: PENDING_WRITE_ERROR })
  })
})

describe('SdkDmChain.invitesSince', () => {
  const BUCKETS = [0, 1, 2]
  const owner = bs58.encode(Uint8Array.from({ length: 32 }, () => 3))
  const invite = (id: string, bucket: number, createdAt: number) => ({
    $id: id, $ownerId: owner, $createdAt: createdAt, bucket, epk: bytes(33), check: bytes(16),
  })
  type Page = Array<ReturnType<typeof invite>> | Error

  /** Answers the reads with `pages` in call order (then empty pages), each with a block time; records the queries. */
  async function chainServing(pages: Page[]) {
    const queries: Array<Record<string, unknown>> = []
    const queryWithProof = vi.fn(async (query: Record<string, unknown>) => {
      queries.push(query)
      const page = pages[queries.length - 1] ?? []
      if (page instanceof Error) throw page
      return { data: new Map(page.map((doc) => [doc.$id, doc])), metadata: { timeMs: 9_000 } }
    })
    const { getEvoSdk } = await import('../evo-sdk-service')
    vi.mocked(getEvoSdk).mockResolvedValue({ documents: { queryWithProof } } as unknown as Awaited<ReturnType<typeof getEvoSdk>>)
    return { chain: new SdkDmChain(ME, CONTRACT), queries }
  }

  const busyBucket = Array.from({ length: 100 }, (_, i) => invite(`a${i}`, 0, 5_000 + i))

  it('reads past a short `in` continuation page to a third page with data, and stops only at an empty page', async () => {
    // Bucket 0 is busy with recent invites. The 99-row second page is not the
    // end: the third holds an OLDER invite in bucket 2, which a scan cursor
    // moved to the newest time read so far would have skipped for good.
    const second = Array.from({ length: 99 }, (_, i) => invite(`b${i}`, i < 50 ? 0 : 1, 6_000 + i))
    const { chain, queries } = await chainServing([busyBucket, second, [invite('late-bucket', 2, 1_500)]])

    const invites = await chain.invitesSince(BUCKETS, 1_000)

    expect(invites).toHaveLength(200)
    expect(invites.at(-1)).toMatchObject({ id: 'late-bucket', bucket: 2, createdAt: 1_500 })
    expect(queries.map((q) => q.startAfter)).toEqual([undefined, 'a99', 'b98', 'late-bucket'])
    for (const q of queries) {
      expect(q).toMatchObject({
        documentTypeName: 'dmInvite',
        where: [['bucket', 'in', BUCKETS], ['$createdAt', '>=', 1_000]],
        orderBy: [['bucket', 'asc'], ['$createdAt', 'asc']],
        limit: 100,
      })
    }
    expect(chain.now()).toBe(9_000)
  })

  it('takes a short first page as the whole answer: one read for a quiet scan', async () => {
    const { chain, queries } = await chainServing([[invite('only', 1, 2_000)]])
    expect(await chain.invitesSince(BUCKETS, 1_000)).toEqual([expect.objectContaining({ id: 'only' })])
    expect(queries).toHaveLength(1)
  })

  it('rejects when a later page fails, so no scan moves its cursor on part of the answer', async () => {
    const { chain } = await chainServing([busyBucket, new Error('DAPI unavailable')])
    await expect(chain.invitesSince(BUCKETS, 1_000)).rejects.toThrow('DAPI unavailable')
  })
})
