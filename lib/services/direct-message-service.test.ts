import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import bs58 from 'bs58';

// Exercise document decoding and page selection at an in-memory SDK boundary.
// No browser secrets, SDK initialization, decryption, or network access.
const mocks = vi.hoisted(() => ({ query: vi.fn(), composite: vi.fn(), identity: vi.fn() }));
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => ({ documents: mocks }) }));
vi.mock('./state-transition-service', () => ({ stateTransitionService: {} }));
vi.mock('./identity-service', () => ({ identityService: {} }));
vi.mock('./identity-batch', () => ({ loadIdentityBatch: mocks.identity }));
vi.mock('../secure-storage', () => ({ getPrivateKey: () => null }));
vi.mock('../auth-utils', () => ({ promptForAuthKey: () => {} }));

const viewer = bs58.encode(new Uint8Array(32).fill(1));
const participants = [2, 3].map(value => bs58.encode(new Uint8Array(32).fill(value)));
const conversationBytes = [4, 5].map(value => new Uint8Array(10).fill(value));
const conversationIds = conversationBytes.map(bytes => bs58.encode(bytes));
const messages = (index: number, count: number) => Array.from({ length: count }, (_, i) => ({
  $id: `message-${index}-${i}`, $ownerId: i % 2 ? viewer : participants[index],
  $createdAt: 1000 + i, conversationId: conversationBytes[index], encryptedContent: new Uint8Array(40),
}));

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', 'v6');
  mocks.query.mockResolvedValueOnce(new Map(participants.map((id, index) => [String(index), {
    $id: `invite-${index}`, $ownerId: id, conversationId: conversationBytes[index], recipientId: viewer,
  }]))).mockResolvedValueOnce(new Map());
  mocks.composite.mockResolvedValue({
    pageDocuments: messages(0, 100),
    subResults: [
      { kind: 'documents', documents: messages(1, 3) },
      { kind: 'documents', documents: [{
        $id: 'receipt', $ownerId: viewer, $updatedAt: 1095,
        data: { conversationId: Array.from(conversationBytes[0]) },
      }] },
    ],
  });
});
afterEach(() => vi.unstubAllEnvs());

describe('conversation query bundles', () => {
  it('preserves busy and quiet previews, viewer receipt decoding, and unread counts', async () => {
    const { directMessageService } = await import('./direct-message-service');
    const result = await directMessageService.getConversations(viewer, { includeParticipantInfo: false });
    expect(result.map(conversation => ({
      id: conversation.id, unread: conversation.unreadCount,
      latest: conversation.lastMessage?.id, preview: conversation.lastMessage?.content,
    }))).toEqual([
      { id: conversationIds[0], unread: 2, latest: 'message-0-99', preview: '[Encrypted message]' },
      { id: conversationIds[1], unread: 2, latest: 'message-1-2', preview: '[Encrypted message]' },
    ]);
    expect(mocks.query).toHaveBeenCalledTimes(2);
    expect(mocks.composite).toHaveBeenCalledTimes(1);
    const query = mocks.composite.mock.calls[0][0];
    const pages = [query, ...query.subQueries];
    expect(pages.map(page => page.limit)).toEqual([100, 100, 2]);
    expect(pages.slice(0, 2).map(page => page.where[0][2]))
      .toEqual(conversationBytes.map(bytes => Buffer.from(bytes).toString('base64')));
    expect(pages[2].where).toEqual([
      ['$ownerId', '==', viewer],
      ['conversationId', 'in', conversationBytes.map(bytes => Buffer.from(bytes).toString('base64'))],
    ]);
    expect(mocks.identity).not.toHaveBeenCalled();
  });

  it('keeps independently available conversations when one ordinary fallback fails', async () => {
    mocks.composite.mockRejectedValue(new Error('unavailable composite'));
    mocks.query.mockRejectedValueOnce(new Error('unavailable conversation'))
      .mockResolvedValueOnce(new Map(messages(1, 3).map(doc => [doc.$id, doc])))
      .mockResolvedValueOnce(new Map());
    const { directMessageService } = await import('./direct-message-service');
    const result = await directMessageService.getConversations(viewer, { includeParticipantInfo: false });
    expect(result.find(conversation => conversation.id === conversationIds[0])?.lastMessage).toBeNull();
    expect(result.find(conversation => conversation.id === conversationIds[1])?.unreadCount).toBe(2);
    expect(mocks.query).toHaveBeenCalledTimes(5);
  });
});


describe('message polling cursor', () => {
  it('continues through messages sharing a timestamp without consulting the device clock', async () => {
    mocks.query.mockReset()
    const records = messages(0, 102).map(record => ({ ...record, $createdAt: 1000 }))
    mocks.query.mockImplementation(async (query) => {
      const start = query.startAfter ? records.findIndex(record => record.$id === query.startAfter) + 1 : 0
      const page = records.slice(start, start + query.limit)
      return new Map(page.map(record => [record.$id, record]))
    })
    const { directMessageService } = await import('./direct-message-service')
    // Decryption is outside this query-boundary test; retain document IDs/times.
    const decrypt = vi.spyOn(directMessageService as unknown as {
      decryptMessage: (doc: Record<string, unknown>) => Promise<unknown>
    }, 'decryptMessage').mockImplementation(async doc => ({
      id: doc.$id, content: 'decrypted QA message', createdAt: new Date(Number(doc.$createdAt)),
    }))
    try {
      const first = await directMessageService.pollNewMessages(conversationIds[0], undefined, viewer, participants[0])
      expect(first.messages).toHaveLength(100)
      const second = await directMessageService.pollNewMessages(conversationIds[0], first.cursor, viewer, participants[0])
      expect(second.messages.map(message => message.id)).toEqual(['message-0-100', 'message-0-101'])
      expect(mocks.query.mock.calls[1][0].where).toEqual([
        ['conversationId', '==', Buffer.from(conversationBytes[0]).toString('base64')],
      ])
      expect(mocks.query.mock.calls[1][0].startAfter).toBe('message-0-99')
      const empty = await directMessageService.pollNewMessages(conversationIds[0], second.cursor, viewer, participants[0])
      expect(empty).toEqual({ messages: [], cursor: 'message-0-101' })
    } finally { decrypt.mockRestore() }
  })

  it('retains its last confirmed cursor when the network fails', async () => {
    mocks.query.mockReset().mockRejectedValue(new Error('offline'))
    const { directMessageService } = await import('./direct-message-service')
    expect(await directMessageService.pollNewMessages(conversationIds[0], 'confirmed-message', viewer, participants[0]))
      .toEqual({ messages: [], cursor: 'confirmed-message' })
  })
})
