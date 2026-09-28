import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const follower = vi.hoisted(() => ({ catchUp: vi.fn(), recoverFollowerKeys: vi.fn() }));
const secrets = vi.hoisted(() => ({ getEncryptionKeyBytes: vi.fn() }));
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: vi.fn() }));
vi.mock('./state-transition-service', () => ({ stateTransitionService: {} }));
vi.mock('./identity-service', () => ({ identityService: {} }));
vi.mock('./private-feed-follower-service', () => ({ privateFeedFollowerService: follower }));
vi.mock('@/lib/secure-storage', () => secrets);
import { prepareInheritedEncryption, privateFeedService } from './private-feed-service';
import { getEvoSdk } from './evo-sdk-service';
import { privateFeedKeyStore } from './private-feed-key-store';
import { privateFeedCryptoService, PROTOCOL_VERSION } from './private-feed-crypto-service';
import { identifierToBytes } from './sdk-helpers';

const ownerId = '9NFhqxW8upkFMVTE5h5VmYWLdSEJ26B2iMKdhCFgsWkd';
const replierId = 'FZSnZdKsLAuWxE7iZJq12eEz6xfGTgKPxK7uZJapTQxe';
const ownerBytes = identifierToBytes(ownerId);
// A short chain is enough: CEK[n-1] = SHA256(CEK[n]) holds at any length.
const chain = privateFeedCryptoService.generateEpochChain(new Uint8Array(32).fill(9), 8);
const pathKeys = [{ nodeId: 1, version: 1, key: new Uint8Array(32) }];

let storage: Map<string, string>;

beforeEach(() => {
  storage = new Map();
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
    key: (index: number) => [...storage.keys()][index] ?? null,
    get length() { return storage.size; },
  });
  follower.catchUp.mockReset();
  follower.recoverFollowerKeys.mockReset();
  secrets.getEncryptionKeyBytes.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** What a reader holding `cek` at `cachedEpoch` gets back, as private-post-content derives it. */
function readAs(cachedEpoch: number, cek: Uint8Array, reply: { encryptedContent: Uint8Array; epoch: number; nonce: Uint8Array }): string {
  if (reply.epoch > cachedEpoch) throw new Error('reply epoch is newer than the reader\'s keys');
  const key = privateFeedCryptoService.deriveCEK(cek, cachedEpoch, reply.epoch);
  return privateFeedCryptoService.decryptPostContent(key, { ciphertext: reply.encryptedContent, nonce: reply.nonce, epoch: reply.epoch }, ownerBytes);
}

describe('inherited reply encryption epoch (QA D-04)', () => {
  it('encrypts a reply in an epoch-1 thread at the feed\'s current epoch, out of reach of a follower revoked since', async () => {
    // The replier synced up to epoch 1; the owner has since revoked someone (epoch 2).
    privateFeedKeyStore.storePathKeys(ownerId, pathKeys);
    privateFeedKeyStore.storeCachedCEK(ownerId, 1, chain[1]);
    follower.catchUp.mockImplementation(async () => {
      privateFeedKeyStore.storeCachedCEK(ownerId, 2, chain[2]);
      return { success: true };
    });

    const result = await prepareInheritedEncryption('after the revocation', { ownerId, epoch: 1 }, replierId);
    if (!result.success) throw new Error(result.error);

    expect(follower.catchUp).toHaveBeenCalledWith(ownerId, replierId);
    expect(result.data.epoch).toBe(2);
    // The revoked follower still holds CEK[1] and cannot move forward in the chain.
    expect(() => readAs(1, chain[1], result.data)).toThrow();
    // A current follower reads it, and still reads the epoch-1 root (mixed epochs in one thread).
    expect(readAs(2, chain[2], result.data)).toBe('after the revocation');
    const root = privateFeedCryptoService.encryptPostContent(chain[1], 'root', ownerBytes, 1);
    expect(readAs(2, chain[2], { encryptedContent: root.ciphertext, epoch: 1, nonce: root.nonce })).toBe('root');
  });

  it('refuses to reply when the replier cannot catch up, e.g. because they were revoked', async () => {
    privateFeedKeyStore.storePathKeys(ownerId, pathKeys);
    privateFeedKeyStore.storeCachedCEK(ownerId, 1, chain[1]);
    follower.catchUp.mockResolvedValue({ success: false, error: 'Access has been revoked' });

    const result = await prepareInheritedEncryption('should not be written', { ownerId, epoch: 1 }, replierId);
    expect(result).toEqual({ success: false, error: 'Cannot encrypt reply: Access has been revoked' });
  });

  it('recovers from a re-approval grant before encrypting, and asks for the key when it is not stored', async () => {
    privateFeedKeyStore.storePathKeys(ownerId, pathKeys);
    privateFeedKeyStore.storeCachedCEK(ownerId, 1, chain[1]);
    follower.catchUp.mockResolvedValueOnce({ success: false, error: 'RECOVERY_NEEDED:Local keys predate the current grant' });
    secrets.getEncryptionKeyBytes.mockReturnValue(null);
    const blocked = await prepareInheritedEncryption('renewed', { ownerId, epoch: 1 }, replierId);
    expect(blocked.success === false && blocked.error).toMatch(/^SYNC_REQUIRED:/);
    expect(follower.recoverFollowerKeys).not.toHaveBeenCalled();

    const followerKey = new Uint8Array(32).fill(5);
    secrets.getEncryptionKeyBytes.mockReturnValue(followerKey);
    follower.catchUp
      .mockResolvedValueOnce({ success: false, error: 'RECOVERY_NEEDED:Local keys predate the current grant' })
      .mockResolvedValueOnce({ success: true });
    follower.recoverFollowerKeys.mockImplementation(async () => {
      privateFeedKeyStore.storeCachedCEK(ownerId, 3, chain[3]);
      return { success: true };
    });
    const result = await prepareInheritedEncryption('renewed', { ownerId, epoch: 1 }, replierId);
    if (!result.success) throw new Error(result.error);
    expect(follower.recoverFollowerKeys).toHaveBeenCalledWith(ownerId, replierId, followerKey);
    expect(result.data.epoch).toBe(3);
  });

  it('refuses without keys for the feed, before any network sync', async () => {
    const result = await prepareInheritedEncryption('no keys', { ownerId, epoch: 1 }, replierId);
    expect(result.success).toBe(false);
    expect(follower.catchUp).not.toHaveBeenCalled();
  });

  it('encrypts the feed owner\'s own reply at the owner\'s current epoch', async () => {
    privateFeedKeyStore.storeFeedSeed(new Uint8Array(32).fill(9));
    privateFeedKeyStore.storeCurrentEpoch(3);
    privateFeedKeyStore.storeCachedCEK(ownerId, 3, chain[3]);
    vi.spyOn(privateFeedService, 'getLatestEpoch').mockResolvedValue(3);

    const result = await prepareInheritedEncryption('owner reply', { ownerId, epoch: 1 }, ownerId);
    if (!result.success) throw new Error(result.error);

    expect(result.data.epoch).toBe(3);
    expect(follower.catchUp).not.toHaveBeenCalled();
    expect(readAs(3, chain[3], result.data)).toBe('owner reply');
    expect(() => readAs(2, chain[2], result.data)).toThrow();
  });
});

describe('owner reply epoch checks fail closed (QA D-04)', () => {
  const feedSeed = new Uint8Array(32).fill(9);
  const ownerKey = new Uint8Array(32).fill(7);

  beforeEach(() => {
    // This device last synced at epoch 1; another device has since revoked a follower.
    privateFeedKeyStore.storeFeedSeed(feedSeed);
    privateFeedKeyStore.storeCurrentEpoch(1);
    privateFeedKeyStore.storeCachedCEK(ownerId, 1, chain[1]);
    vi.mocked(getEvoSdk).mockRejectedValue(new Error('DAPI unreachable'));
  });

  it('refuses the reply when the latest epoch cannot be read', async () => {
    const result = await prepareInheritedEncryption('owner reply', { ownerId, epoch: 1 }, ownerId, ownerKey);
    expect(result.success).toBe(false);
    expect(result.success === false && result.error).toMatch(/current encryption epoch/);
  });

  it('refuses the reply when recovery cannot read the rekeys that moved the epoch', async () => {
    vi.spyOn(privateFeedService, 'getLatestEpoch').mockResolvedValue(2);
    vi.spyOn(privateFeedService, 'getPrivateFeedState').mockResolvedValue({
      $id: 'state', $ownerId: ownerId, $createdAt: 1, treeCapacity: 1024, maxEpoch: 2000, encryptedSeed: new Uint8Array(),
    });
    vi.spyOn(privateFeedCryptoService, 'eciesDecrypt').mockResolvedValue(new Uint8Array([PROTOCOL_VERSION, ...feedSeed]));

    const result = await prepareInheritedEncryption('owner reply', { ownerId, epoch: 1 }, ownerId, ownerKey);
    expect(result.success).toBe(false);
    expect(privateFeedKeyStore.getCurrentEpoch()).toBe(1);
  });

  it('refuses the reply when recovery reports success short of the chain epoch', async () => {
    vi.spyOn(privateFeedService, 'getLatestEpoch').mockResolvedValue(2);
    vi.spyOn(privateFeedService, 'recoverOwnerState').mockResolvedValue({ success: true });

    const result = await prepareInheritedEncryption('owner reply', { ownerId, epoch: 1 }, ownerId, ownerKey);
    expect(result.success === false && result.error).toMatch(/current encryption epoch/);
  });
});
