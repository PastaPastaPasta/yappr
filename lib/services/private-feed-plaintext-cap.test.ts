import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A private post's plaintext must fit `encryptedContent` once encrypted: v2/v9
 * keep SPEC §7.5.1's 999 B cap, v10 raises it to 2031 B (2048 B less the
 * version byte and the 16-byte Poly1305 tag).
 */

const follower = vi.hoisted(() => ({ catchUp: vi.fn() }));
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: vi.fn() }));
vi.mock('./state-transition-service', () => ({ stateTransitionService: {} }));
vi.mock('./identity-service', () => ({ identityService: {} }));
vi.mock('./private-feed-follower-service', () => ({ privateFeedFollowerService: follower }));

const ownerId = '9NFhqxW8upkFMVTE5h5VmYWLdSEJ26B2iMKdhCFgsWkd';
const replierId = 'FZSnZdKsLAuWxE7iZJq12eEz6xfGTgKPxK7uZJapTQxe';

/** Fresh modules under `topology`, with the replier holding the feed's generation-1 CEK. */
async function load(topology: 'v2' | 'v9' | 'v10') {
  vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', topology);
  vi.resetModules();
  const { privateFeedKeyStore } = await import('./private-feed-key-store');
  privateFeedKeyStore.storePathKeys(ownerId, [{ nodeId: 1, version: 1, key: new Uint8Array(32) }]);
  privateFeedKeyStore.storeCachedCEK(ownerId, 1, new Uint8Array(32).fill(7));
  const { prepareInheritedEncryption } = await import('./private-feed-service');
  return (content: string) => prepareInheritedEncryption(content, { ownerId, keyGeneration: 1 }, replierId);
}

beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
    key: (index: number) => [...storage.keys()][index] ?? null,
    get length() { return storage.size; },
  });
  follower.catchUp.mockReset();
  follower.catchUp.mockResolvedValue({ success: true });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('private plaintext cap', () => {
  it.each([
    ['v2', 999, 1024],
    ['v9', 999, 1024],
    ['v10', 2031, 2048],
  ] as const)('%s encrypts %i bytes and refuses one more', async (topology, max, encryptedMaxBytes) => {
    const encrypt = await load(topology);

    const atCap = await encrypt('a'.repeat(max));
    if (!atCap.success) throw new Error(atCap.error);
    expect(atCap.data.encryptedContent.length).toBeLessThanOrEqual(encryptedMaxBytes);

    expect(await encrypt('a'.repeat(max + 1))).toEqual({
      success: false,
      error: `Content too long: ${max + 1} bytes (max ${max})`,
    });
  });

  it('counts UTF-8 bytes, not characters', async () => {
    const encrypt = await load('v10');
    // 508 four-byte emoji = 2032 bytes, one over the v10 cap.
    expect(await encrypt('😀'.repeat(508))).toEqual({ success: false, error: 'Content too long: 2032 bytes (max 2031)' });
  });
});
