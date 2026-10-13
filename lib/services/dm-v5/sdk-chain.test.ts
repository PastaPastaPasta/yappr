import bs58 from 'bs58'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PENDING_WRITE_ERROR } from '@/lib/error-utils'

const { createDocument, updateDocument, deleteDocument, settleSupersededReplaces } = vi.hoisted(() => ({
  createDocument: vi.fn(),
  updateDocument: vi.fn(),
  deleteDocument: vi.fn(),
  settleSupersededReplaces: vi.fn(),
}))
vi.mock('../state-transition-service', () => ({ stateTransitionService: { createDocument, updateDocument, deleteDocument } }))
vi.mock('../identity-nonce', () => ({ settleSupersededReplaces }))
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
 * `settleSupersededReplaces` proves it landed.
 */
function lostReplaceAnswer() {
  let pending = true
  settleSupersededReplaces.mockImplementation(async () => {
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
    expect(settleSupersededReplaces).toHaveBeenCalledWith(bs58.encode(ME), CONTRACT)
  })

  it('still writes when the settle itself fails, and reports what the write returned', async () => {
    settleSupersededReplaces.mockRejectedValue(new Error('transport'))
    const outcome = await chain().createMessage(bytes(32), bytes(156))
    expect(settleSupersededReplaces).toHaveBeenCalledTimes(1)
    expect(createDocument).toHaveBeenCalledTimes(1)
    expect(outcome).toMatchObject({ ok: false, failure: 'other', error: PENDING_WRITE_ERROR })
  })
})
