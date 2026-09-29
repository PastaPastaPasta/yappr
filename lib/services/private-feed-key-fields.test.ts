import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * v10 renamed the private-feed key generation from `epoch`/`maxEpoch` to
 * `keyGeneration`/`maxKeyGeneration`. The client model always says
 * `keyGeneration`; only the chain-facing reads, writes and queries switch on
 * the topology, and v2/v9 must keep naming `epoch`.
 */

const mocks = vi.hoisted(() => ({ query: vi.fn(), createDocument: vi.fn() }));
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => ({ documents: { query: mocks.query } }) }));
vi.mock('./state-transition-service', () => ({ stateTransitionService: { createDocument: mocks.createDocument } }));
vi.mock('./identity-service', () => ({ identityService: {} }));
vi.mock('./dpns-service', () => ({ dpnsService: {} }));
vi.mock('./unified-profile-service', () => ({ unifiedProfileService: {} }));

const ownerId = '9NFhqxW8upkFMVTE5h5VmYWLdSEJ26B2iMKdhCFgsWkd';
const recipientId = 'FZSnZdKsLAuWxE7iZJq12eEz6xfGTgKPxK7uZJapTQxe';

const FIELDS = {
  v2: { generation: 'epoch', latest: 'maxEpoch' },
  v9: { generation: 'epoch', latest: 'maxEpoch' },
  v10: { generation: 'keyGeneration', latest: 'maxKeyGeneration' },
} as const;

/** Fresh modules under `topology`; every query answers `docs` for its doctype. */
async function load(topology: keyof typeof FIELDS, docs: Record<string, Record<string, unknown>[]>) {
  vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', topology);
  vi.resetModules();
  mocks.query.mockReset();
  mocks.query.mockImplementation(async ({ documentTypeName }: { documentTypeName: string }) =>
    new Map((docs[documentTypeName] ?? []).map((doc, index) => [`${documentTypeName}-${index}`, doc])));
  return {
    feed: (await import('./private-feed-service')).privateFeedService,
    follower: (await import('./private-feed-follower-service')).privateFeedFollowerService,
    transformRawPost: (await import('@/lib/feed/transform-raw-post')).transformRawPost,
    replyService: (await import('./reply-service')).replyService,
  };
}

/** The query sent for `docType`, or undefined when none was. */
function queryFor(docType: string): Record<string, unknown> | undefined {
  return mocks.query.mock.calls.map(([q]) => q).find((q) => q.documentTypeName === docType);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe.each(Object.entries(FIELDS) as [keyof typeof FIELDS, (typeof FIELDS)[keyof typeof FIELDS]][])(
  'private feed key fields on %s',
  (topology, { generation, latest }) => {
    it('reads the latest key generation off the rekey documents, ordered by the topology\'s field', async () => {
      const { feed } = await load(topology, { privateFeedRekey: [{ $id: 'r', $ownerId: ownerId, [generation]: 7 }] });
      await expect(feed.getLatestKeyGeneration(ownerId, { throwOnError: true })).resolves.toBe(7);
      expect(queryFor('privateFeedRekey')?.orderBy).toEqual([[generation, 'desc']]);
    });

    it('maps rekey and state documents into the keyGeneration model', async () => {
      const rekey = { $id: 'r', $ownerId: ownerId, $createdAt: 1, [generation]: 2, revokedLeaf: 3, packets: new Uint8Array(1), encryptedCEK: new Uint8Array(48) };
      const state = { $id: 's', $ownerId: ownerId, $createdAt: 1, treeCapacity: 1024, [latest]: 2000, encryptedSeed: new Uint8Array(1) };
      const { feed } = await load(topology, { privateFeedRekey: [rekey], privateFeedState: [state] });
      const [mapped] = await feed.getRekeyDocuments(ownerId, { throwOnError: true });
      expect(mapped.keyGeneration).toBe(2);
      expect(queryFor('privateFeedRekey')?.orderBy).toEqual([[generation, 'asc']]);
      expect((await feed.getPrivateFeedState(ownerId))?.maxKeyGeneration).toBe(2000);
    });

    it('queries a follower\'s missed rekeys and reads their grant by the topology\'s field', async () => {
      const grant = { $id: 'g', $ownerId: ownerId, $createdAt: 1, recipientId, leafIndex: 0, [generation]: 4, encryptedPayload: new Uint8Array(1) };
      const { follower } = await load(topology, { privateFeedGrant: [grant], privateFeedRekey: [] });
      expect((await follower.getGrant(ownerId, recipientId))?.keyGeneration).toBe(4);

      const reader = follower as unknown as { getRekeyDocumentsAfter: (owner: string, after: number) => Promise<unknown[]> };
      await reader.getRekeyDocumentsAfter(ownerId, 4);
      const rekeyQuery = queryFor('privateFeedRekey');
      expect(rekeyQuery?.where).toEqual([['$ownerId', '==', ownerId], [generation, '>', 4]]);
      expect(rekeyQuery?.orderBy).toEqual([[generation, 'asc']]);
    });

    it('reads a private post\'s and reply\'s key generation off the topology\'s field only', async () => {
      const encrypted = { encryptedContent: new Uint8Array([1, 2]), nonce: new Uint8Array(24) };
      const { transformRawPost, replyService } = await load(topology, {
        reply: [{ $id: 'reply1', $ownerId: ownerId, $createdAt: 2, content: '🔒', parentId: recipientId, parentOwnerId: ownerId, rootPostId: recipientId, [generation]: 5, ...encrypted }],
      });
      expect(transformRawPost({ $id: 'post1', $ownerId: ownerId, $createdAt: 1, content: '🔒', [generation]: 3, ...encrypted }).keyGeneration).toBe(3);
      // The other topology's name is not this contract's property and is ignored.
      const foreign = generation === 'epoch' ? 'keyGeneration' : 'epoch';
      expect(transformRawPost({ $id: 'post2', $ownerId: ownerId, $createdAt: 1, content: '🔒', [foreign]: 3, ...encrypted }).keyGeneration).toBeUndefined();

      const { documents } = await replyService.getUserReplies(ownerId, { limit: 1, skipEnrichment: true });
      expect(documents[0]?.keyGeneration).toBe(5);
    });
  },
);
