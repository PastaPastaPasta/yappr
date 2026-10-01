import * as SecureStore from 'expo-secure-store';

import { syncStorage } from '~/state/storage';

import { createEngineStorage } from './engine-storage';
import { chunkKey, decodeSecureKey, encodeSecureKey, identityOfKey, SECURE_CHUNK_CHARS } from './secure-keys';

const keychain = (SecureStore as unknown as { __items: Map<string, string> }).__items;
const ALICE = '5DbLwAxGBzUzo81VewMUwn4b5P4bpv9FNFybi25XB5Bk';
const BOB = 'GWRSAVFMjXx8HpQFaNJMqBV7MBgMK4br5UESsB4S31Ec';
const SERVICE = 'pr.yap.app.secrets.testnet';

beforeEach(() => {
  keychain.clear();
  syncStorage.removeItem('mobile.secure-index.testnet');
});

describe('secure key names', () => {
  it.each([
    'yappr_secure_pk_' + ALICE,
    'yappr:pf:path_keys:3',
    'a-b',
    'émoji 🔑 key',
    "x!~*'()y",
    '',
  ])('round-trips %j through SecureStore-safe characters', (key) => {
    const encoded = encodeSecureKey(key);
    expect(encoded).toMatch(/^[A-Za-z0-9._-]*$/);
    expect(decodeSecureKey(encoded)).toBe(key);
  });

  it('never collides: distinct keys encode differently, and chunk keys are not encodings', () => {
    expect(encodeSecureKey('a:b')).not.toBe(encodeSecureKey('a-b'));
    expect(encodeSecureKey('a-3ab')).toBe('a-2d3ab');
    expect(() => decodeSecureKey(chunkKey(encodeSecureKey('k'), 1))).toThrow();
  });

  it('files keys by identity', () => {
    expect(identityOfKey(`yappr_secure_pk_${ALICE}`)).toBe(ALICE);
    expect(identityOfKey(`yappr_secure_ek_type_${BOB}`)).toBe(BOB);
    expect(identityOfKey('yappr:pf:feed_seed')).toBe('');
  });
});

describe('engine storage', () => {
  async function opened() {
    const storage = createEngineStorage('testnet');
    await storage.open();
    return storage;
  }

  it('keeps the MMKV key in the secure store, device only', async () => {
    await opened();
    const key = keychain.get('pr.yap.app.engine-keys:yappr.mmkv-key.testnet');
    expect(key).toMatch(/^[A-Za-z0-9_-]{32}$/);
    // The same key is reused on the next launch.
    await opened();
    expect(keychain.get('pr.yap.app.engine-keys:yappr.mmkv-key.testnet')).toBe(key);
  });

  it('applies plain batches synchronously and returns them in the snapshot', async () => {
    const storage = await opened();
    expect(storage.apply({ area: 'local', seq: 1, ops: [['set', 'a', '1'], ['set', 'b', '2'], ['del', 'a']] })).toBeUndefined();
    expect((await storage.snapshot(null)).local).toEqual({ b: '2' });
    storage.apply({ area: 'local', seq: 2, ops: [['clear']] });
    expect((await storage.snapshot(null)).local).toEqual({});
  });

  it('writes secrets to the keychain, chunked, and hydrates only the session identity', async () => {
    const storage = await opened();
    const long = 'x'.repeat(SECURE_CHUNK_CHARS * 2 + 5);
    await storage.apply({
      area: 'secure',
      seq: 3,
      ops: [
        ['set', `yappr_secure_pk_${ALICE}`, '"alice-wif"'],
        ['set', `yappr_secure_pk_${BOB}`, '"bob-wif"'],
        ['set', 'yappr:pf:path_keys:1', long],
      ],
    });
    const encoded = encodeSecureKey('yappr:pf:path_keys:1');
    expect(keychain.get(`${SERVICE}:${encoded}`)).toHaveLength(SECURE_CHUNK_CHARS);
    expect(keychain.get(`${SERVICE}:${chunkKey(encoded, 2)}`)).toBe('xxxxx');

    storage.apply({ area: 'local', seq: 4, ops: [['set', 'yappr_session', JSON.stringify({ user: { identityId: ALICE } })]] });
    const { secure } = await storage.snapshot();
    expect(secure).toEqual({ [`yappr_secure_pk_${ALICE}`]: '"alice-wif"', 'yappr:pf:path_keys:1': long });
    expect(storage.stats()).toMatchObject({ secureKeys: 3, identities: 2 });
  });

  it('shrinks and deletes chunked values without leaving items behind', async () => {
    const storage = await opened();
    await storage.apply({ area: 'secure', seq: 1, ops: [['set', 'yappr:pf:k', 'y'.repeat(SECURE_CHUNK_CHARS * 3)]] });
    expect(keychain.size).toBe(1 + 3); // the MMKV key + 3 chunks
    await storage.apply({ area: 'secure', seq: 2, ops: [['set', 'yappr:pf:k', 'short']] });
    expect(keychain.size).toBe(1 + 1);
    expect((await storage.snapshot(null)).secure).toEqual({ 'yappr:pf:k': 'short' });
    await storage.apply({ area: 'secure', seq: 3, ops: [['del', 'yappr:pf:k']] });
    expect(keychain.size).toBe(1);
    expect(storage.stats().secureKeys).toBe(0);
  });

  it('deletes a secure key it never indexed (signing out a non-hydrated account)', async () => {
    const storage = await opened();
    keychain.set(`${SERVICE}:${encodeSecureKey(`yappr_secure_pk_${BOB}`)}`, 'stale');
    await storage.apply({ area: 'secure', seq: 1, ops: [['del', `yappr_secure_pk_${BOB}`]] });
    expect([...keychain.keys()].some((key) => key.startsWith(SERVICE))).toBe(false);
  });

  it('serializes secure batches and reports a failed write without acknowledging it', async () => {
    const storage = await opened();
    const spy = jest.spyOn(SecureStore, 'setItemAsync').mockRejectedValueOnce(new Error('keychain locked'));
    const failed = storage.apply({ area: 'secure', seq: 1, ops: [['set', 'yappr:pf:a', '1']] });
    const next = storage.apply({ area: 'secure', seq: 2, ops: [['set', 'yappr:pf:b', '2']] });
    await expect(failed).rejects.toThrow('keychain locked');
    await expect(next).resolves.toBeUndefined();
    await storage.idle();
    expect((await storage.snapshot(null)).secure).toEqual({ 'yappr:pf:b': '2' });
    spy.mockRestore();
  });

  it('reset deletes the instance, its key and every secret', async () => {
    const storage = await opened();
    storage.apply({ area: 'local', seq: 1, ops: [['set', 'a', '1']] });
    await storage.apply({ area: 'secure', seq: 2, ops: [['set', `yappr_secure_pk_${ALICE}`, 'k']] });
    await storage.reset();
    expect(keychain.size).toBe(0);
    await storage.open();
    expect(await storage.snapshot(ALICE)).toEqual({ local: {}, secure: {} });
  });
});
