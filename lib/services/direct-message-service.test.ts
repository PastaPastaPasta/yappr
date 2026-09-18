import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import bs58 from 'bs58';

// Exercise document decoding and page selection at an in-memory SDK boundary.
// No browser secrets, SDK initialization, decryption, or network access.
const mocks = vi.hoisted(() => ({ query: vi.fn(), composite: vi.fn(), count: vi.fn(), identity: vi.fn() }));
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
  vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', 'v7');
  mocks.query.mockResolvedValueOnce(new Map(participants.map((id, index) => [String(index), {
    $id: `invite-${index}`, $ownerId: id, conversationId: conversationBytes[index], recipientId: viewer,
  }]))).mockResolvedValueOnce(new Map());
  mocks.composite.mockResolvedValue({
    pageDocuments: messages(0, 100).reverse(),
    subResults: [
      { kind: 'documents', documents: messages(1, 3).reverse() },
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

  it('selects the latest preview when a conversation exceeds one message page', async () => {
    mocks.composite.mockImplementation(async query => {
      const records = Array.from({ length: 130 }, (_, i) => ({ ...messages(0, 1)[0], $id: `preview-message-${i}`, $createdAt: 1000 + i }))
      if (query.orderBy[0][1] === 'desc') records.reverse()
      return { pageDocuments: records.slice(0, query.limit), subResults: [
        { kind: 'documents', documents: messages(1, 3).reverse() },
        { kind: 'documents', documents: [] },
      ] }
    })
    const { directMessageService } = await import('./direct-message-service')
    const result = await directMessageService.getConversations(viewer, { includeParticipantInfo: false })
    expect(result[0].lastMessage?.id).toBe('preview-message-129')
    expect(result[0].updatedAt.getTime()).toBe(1129)
    expect(result[1].lastMessage?.id).toBe('message-1-2')
    expect(mocks.composite.mock.calls[0][0].orderBy).toEqual([['$createdAt', 'desc']])
  })

  it('keeps independently available conversations when one ordinary fallback fails', async () => {
    mocks.composite.mockRejectedValue(new Error('unavailable composite'));
    mocks.query.mockRejectedValueOnce(new Error('unavailable conversation'))
      .mockResolvedValueOnce(new Map(messages(1, 3).reverse().map(doc => [doc.$id, doc])))
      .mockResolvedValueOnce(new Map());
    const { directMessageService } = await import('./direct-message-service');
    const result = await directMessageService.getConversations(viewer, { includeParticipantInfo: false });
    expect(result.find(conversation => conversation.id === conversationIds[0])?.lastMessage).toBeNull();
    expect(result.find(conversation => conversation.id === conversationIds[1])?.unreadCount).toBe(2);
    expect(result.find(conversation => conversation.id === conversationIds[1])?.lastMessage?.id).toBe('message-1-2');
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


/**
 * v4 reads unread from the contract's count tree instead of downloading and
 * filtering a 100-message page. The fixture exercises both branches at once:
 * conversation 0's newest message belongs to the viewer (last speaker → 0
 * unread, no query at all), conversation 1's belongs to the participant.
 */
describe('v4 unread counts', () => {
  const useV4 = async () => {
    vi.stubEnv('NEXT_PUBLIC_DM_TOPOLOGY', 'v4');
    return (await import('./direct-message-service')).directMessageService;
  };

  beforeEach(() => {
    // v4 fetches only the newest message per conversation for the preview.
    mocks.composite.mockResolvedValue({
      pageDocuments: [messages(0, 100).reverse()[0]],
      subResults: [
        { kind: 'documents', documents: [messages(1, 3).reverse()[0]] },
        { kind: 'documents', documents: [{
          $id: 'receipt', $ownerId: viewer, $updatedAt: 1095,
          data: { conversationId: Array.from(conversationBytes[0]) },
        }] },
      ],
    });
    mocks.count.mockResolvedValue(new Map([['', 4n]]));
  });

  it('fetches one message per conversation and counts unread against the read receipt', async () => {
    const service = await useV4();
    const result = await service.getConversations(viewer, { includeParticipantInfo: false });

    expect(result.map(conversation => ({ id: conversation.id, unread: conversation.unreadCount })))
      .toEqual([
        // Newest message is the viewer's own: nothing newer to read, no query.
        { id: conversationIds[0], unread: 0 },
        { id: conversationIds[1], unread: 4 },
      ]);

    // The whole v3/v4 read difference: a 1-message preview, not a 100-message page.
    const query = mocks.composite.mock.calls[0][0];
    expect([query, ...query.subQueries].map(page => page.limit)).toEqual([1, 1, 2]);

    // Exactly one count: conversation 0 short-circuited.
    expect(mocks.count).toHaveBeenCalledTimes(1);
    expect(mocks.count.mock.calls[0][0]).toMatchObject({
      documentTypeName: 'directMessage',
      where: [
        ['conversationId', '==', Buffer.from(conversationBytes[1]).toString('base64')],
        // No receipt for this conversation, so everything counts.
        ['$createdAt', '>', 0],
      ],
    });
  });

  it('counts only messages newer than the receipt when the participant spoke last', async () => {
    // Give conversation 0 a participant-owned newest message so its receipt
    // ($updatedAt 1095) becomes the range bound.
    const theirs = { ...messages(0, 100).reverse()[0], $ownerId: participants[0] };
    mocks.composite.mockResolvedValue({
      pageDocuments: [theirs],
      subResults: [
        { kind: 'documents', documents: [] },
        { kind: 'documents', documents: [{
          $id: 'receipt', $ownerId: viewer, $updatedAt: 1095,
          data: { conversationId: Array.from(conversationBytes[0]) },
        }] },
      ],
    });
    const service = await useV4();
    const result = await service.getConversations(viewer, { includeParticipantInfo: false });

    expect(result.find(conversation => conversation.id === conversationIds[0])?.unreadCount).toBe(4);
    // A conversation with no messages at all is 0 unread and costs no query.
    expect(result.find(conversation => conversation.id === conversationIds[1])?.unreadCount).toBe(0);
    expect(mocks.count).toHaveBeenCalledTimes(1);
    expect(mocks.count.mock.calls[0][0].where[1]).toEqual(['$createdAt', '>', 1095]);
  });

  it('reports 0 rather than failing the list when a count query fails', async () => {
    mocks.count.mockRejectedValue(new Error('count tree unavailable'));
    const service = await useV4();
    const result = await service.getConversations(viewer, { includeParticipantInfo: false });
    expect(result.map(conversation => conversation.unreadCount)).toEqual([0, 0]);
    expect(result).toHaveLength(2);
  });
});

describe('global unread total', () => {
  it('sums the per-conversation unread on v4 without decrypting or resolving identities', async () => {
    vi.stubEnv('NEXT_PUBLIC_DM_TOPOLOGY', 'v4');
    mocks.composite.mockResolvedValue({
      pageDocuments: [{ ...messages(0, 100).reverse()[0], $ownerId: participants[0] }],
      subResults: [
        { kind: 'documents', documents: [messages(1, 3).reverse()[0]] },
        { kind: 'documents', documents: [] },
      ],
    });
    mocks.count.mockResolvedValue(new Map([['', 3n]]));
    const { directMessageService } = await import('./direct-message-service');
    expect(await directMessageService.getUnreadTotal(viewer)).toBe(6); // 3 + 3
    expect(mocks.identity).not.toHaveBeenCalled();
  });

  it('reports 0 on v3, where a total would cost a message page per conversation per poll', async () => {
    const { directMessageService } = await import('./direct-message-service');
    expect(await directMessageService.getUnreadTotal(viewer)).toBe(0);
    // The v3 branch short-circuits before any DAPI request.
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.count).not.toHaveBeenCalled();
  });

  it('reports null, not 0, when it cannot tell — the badge must not read "all caught up"', async () => {
    vi.stubEnv('NEXT_PUBLIC_DM_TOPOLOGY', 'v4');
    mocks.query.mockReset().mockRejectedValue(new Error('offline'));
    const { directMessageService } = await import('./direct-message-service');
    expect(await directMessageService.getUnreadTotal(viewer)).toBeNull();
  });

  it('reports null when a conversation\'s message page cannot be read, rather than counting it as 0 unread', async () => {
    vi.stubEnv('NEXT_PUBLIC_DM_TOPOLOGY', 'v4');
    // The list tolerates a failed page (empty preview); the badge must not,
    // because an empty page is indistinguishable from "no messages".
    mocks.composite.mockRejectedValue(new Error('unavailable composite'));
    mocks.query.mockRejectedValueOnce(new Error('unavailable conversation'))
      .mockResolvedValueOnce(new Map(messages(1, 1).map(doc => [doc.$id, doc])))
      .mockResolvedValueOnce(new Map());
    mocks.count.mockResolvedValue(new Map([['', 3n]]));
    const { directMessageService } = await import('./direct-message-service');
    expect(await directMessageService.getUnreadTotal(viewer)).toBeNull();
  });

  it('reports null when any single conversation count fails, since a partial total is not a total', async () => {
    vi.stubEnv('NEXT_PUBLIC_DM_TOPOLOGY', 'v4');
    mocks.composite.mockResolvedValue({
      pageDocuments: [{ ...messages(0, 100).reverse()[0], $ownerId: participants[0] }],
      subResults: [
        { kind: 'documents', documents: [messages(1, 3).reverse()[0]] },
        { kind: 'documents', documents: [] },
      ],
    });
    mocks.count.mockResolvedValueOnce(new Map([['', 3n]])).mockRejectedValueOnce(new Error('count tree unavailable'));
    const { directMessageService } = await import('./direct-message-service');
    expect(await directMessageService.getUnreadTotal(viewer)).toBeNull();
  });

  it('reports 0 when read receipts are disabled, where every message would count as unread forever', async () => {
    vi.stubEnv('NEXT_PUBLIC_DM_TOPOLOGY', 'v4');
    const { useSettingsStore } = await import('../store');
    useSettingsStore.setState({ sendReadReceipts: false });
    try {
      const { directMessageService } = await import('./direct-message-service');
      expect(await directMessageService.getUnreadTotal(viewer)).toBe(0);
      // No receipt means no lastReadAt basis, so nothing is even queried.
      expect(mocks.query).not.toHaveBeenCalled();
      expect(mocks.count).not.toHaveBeenCalled();
    } finally {
      useSettingsStore.setState({ sendReadReceipts: true });
    }
  });
});
