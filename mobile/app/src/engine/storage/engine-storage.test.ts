import * as SecureStore from 'expo-secure-store';
import { deleteMMKV } from 'react-native-mmkv';

import { createEngineStorage } from './engine-storage';
import { decodeSecureKey, encodeSecureKey, identityInKey, SECURE_CHUNK_CHARS, secureItemName } from './secure-keys';

const keychain = (SecureStore as unknown as { __items: Map<string, string> }).__items;
const ALICE = '5DbLwAxGBzUzo81VewMUwn4b5P4bpv9FNFybi25XB5Bk';
const BOB = 'GWRSAVFMjXx8HpQFaNJMqBV7MBgMK4br5UESsB4S31Ec';
const SERVICE = 'pr.yap.app.secrets.testnet';
const session = (identityId: string) => JSON.stringify({ user: { identityId } });
/** Keychain items holding secrets (not the MMKV key). */
const secretItems = () => [...keychain.keys()].filter((key) => key.startsWith(`${SERVICE}:`));

let storage: ReturnType<typeof createEngineStorage>;

beforeEach(async () => {
  keychain.clear();
  storage = createEngineStorage('testnet');
  await storage.open();
  await storage.reset();
  await storage.open();
});

describe('secure key names', () => {
  it.each([`yappr_secure_pk_${ALICE}`, 'yappr:pf:path_keys:3', 'a-b', 'émoji 🔑 key', "x!~*'()y", ''])(
    'round-trips %j through SecureStore-safe characters',
    (key) => {
      const encoded = encodeSecureKey(key);
      expect(encoded).toMatch(/^[A-Za-z0-9._-]*$/);
      expect(decodeSecureKey(encoded)).toBe(key);
    },
  );

  it('never collides: distinct keys and buckets get distinct items', () => {
    expect(encodeSecureKey('a:b')).not.toBe(encodeSecureKey('a-b'));
    expect(encodeSecureKey('a-3ab')).toBe('a-2d3ab');
    expect(secureItemName(ALICE, 'yappr:pf:feed_seed', 'a', 0)).not.toBe(secureItemName(BOB, 'yappr:pf:feed_seed', 'a', 0));
    expect(secureItemName('', 'k', 'a', 1)).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it('reads the identity only from lib secret-store keys', () => {
    expect(identityInKey(`yappr_secure_pk_${ALICE}`)).toBe(ALICE);
    expect(identityInKey(`yappr_secure_ek_type_${BOB}`)).toBe(BOB);
    expect(identityInKey(`yappr:pf:path_keys:${BOB}`)).toBeNull();
    expect(identityInKey('yappr:pf:feed_seed')).toBeNull();
  });
});

describe('engine storage', () => {
  it('keeps the MMKV key in the secure store and reuses it', async () => {
    const key = keychain.get('pr.yap.app.engine-keys:yappr.mmkv-key.testnet');
    expect(key).toMatch(/^[A-Za-z0-9_-]{32}$/);
    await createEngineStorage('testnet').open();
    expect(keychain.get('pr.yap.app.engine-keys:yappr.mmkv-key.testnet')).toBe(key);
  });

  it('applies plain batches synchronously and returns them in the snapshot', async () => {
    expect(storage.apply({ area: 'local', seq: 1, ops: [['set', 'a', '1'], ['set', 'b', '2'], ['del', 'a']] })).toBeUndefined();
    expect((await storage.snapshot(null)).local).toEqual({ b: '2' });
    storage.apply({ area: 'local', seq: 2, ops: [['clear']] });
    expect((await storage.snapshot(null)).local).toEqual({});
  });

  it('files private-feed keys under the account signed in when they were written', async () => {
    storage.apply({ area: 'local', seq: 1, ops: [['set', 'yappr_session', session(ALICE)]] });
    await storage.apply({
      area: 'secure',
      seq: 2,
      ops: [
        ['set', `yappr_secure_pk_${ALICE}`, '"alice-wif"'],
        ['set', 'yappr:pf:feed_seed', 'alice-seed'],
        ['set', `yappr:pf:path_keys:${BOB}`, 'alice-follows-bob'],
      ],
    });
    storage.apply({ area: 'local', seq: 3, ops: [['set', 'yappr_session', session(BOB)]] });
    await storage.apply({ area: 'secure', seq: 4, ops: [['set', 'yappr:pf:feed_seed', 'bob-seed']] });

    expect((await storage.snapshot(ALICE)).secure).toEqual({
      [`yappr_secure_pk_${ALICE}`]: '"alice-wif"',
      'yappr:pf:feed_seed': 'alice-seed',
      [`yappr:pf:path_keys:${BOB}`]: 'alice-follows-bob',
    });
    expect((await storage.snapshot()).secure).toEqual({ 'yappr:pf:feed_seed': 'bob-seed' });
    expect(storage.stats()).toMatchObject({ secureKeys: 4, identities: 2 });
  });

  it('chunks long values and replaces them without leaving items behind', async () => {
    const long = 'x'.repeat(SECURE_CHUNK_CHARS * 2 + 5);
    await storage.apply({ area: 'secure', seq: 1, ops: [['set', 'yappr:pf:k', long]] });
    expect(secretItems()).toHaveLength(3);
    expect((await storage.snapshot(null)).secure).toEqual({ 'yappr:pf:k': long });
    await storage.apply({ area: 'secure', seq: 2, ops: [['set', 'yappr:pf:k', 'short']] });
    expect(secretItems()).toHaveLength(1);
    expect((await storage.snapshot(null)).secure).toEqual({ 'yappr:pf:k': 'short' });
    await storage.apply({ area: 'secure', seq: 3, ops: [['del', 'yappr:pf:k']] });
    expect(secretItems()).toHaveLength(0);
  });

  it('keeps the old value whole if a replacement is interrupted', async () => {
    await storage.apply({ area: 'secure', seq: 1, ops: [['set', 'yappr:pf:k', 'old']] });
    const spy = jest
      .spyOn(SecureStore, 'setItemAsync')
      .mockImplementationOnce(async () => undefined) // first chunk lands
      .mockRejectedValueOnce(new Error('killed')); // then the app dies
    await expect(
      storage.apply({ area: 'secure', seq: 2, ops: [['set', 'yappr:pf:k', 'n'.repeat(SECURE_CHUNK_CHARS + 1)]] }),
    ).rejects.toThrow('killed');
    spy.mockRestore();
    expect((await storage.snapshot(null)).secure).toEqual({ 'yappr:pf:k': 'old' });
  });

  it('files a new sign-in’s secrets under it after the boot account signs out (same engine)', async () => {
    storage.apply({ area: 'local', seq: 1, ops: [['set', 'yappr_session', session(ALICE)]] });
    await storage.apply({ area: 'secure', seq: 2, ops: [['set', `yappr_secure_pk_${ALICE}`, 'a']] });
    await storage.snapshot(); // the engine boots as ALICE
    // ALICE signs out, then BOB signs in, without a restart.
    storage.apply({ area: 'local', seq: 3, ops: [['del', 'yappr_session']] });
    await storage.apply({ area: 'secure', seq: 4, ops: [['del', `yappr_secure_pk_${ALICE}`]] });
    storage.apply({ area: 'local', seq: 5, ops: [['set', 'yappr_session', session(BOB)]] });
    await storage.apply({
      area: 'secure',
      seq: 6,
      ops: [['set', `yappr_secure_pk_${BOB}`, 'b'], ['set', 'yappr:pf:feed_seed', 'bob-seed']],
    });

    expect((await storage.snapshot(BOB)).secure).toEqual({ [`yappr_secure_pk_${BOB}`]: 'b', 'yappr:pf:feed_seed': 'bob-seed' });
    expect((await storage.snapshot(ALICE)).secure).toEqual({});
  });

  it('keeps an in-engine account switch’s late writes with the boot account', async () => {
    storage.apply({ area: 'local', seq: 1, ops: [['set', 'yappr_session', session(ALICE)]] });
    await storage.snapshot(); // booted as ALICE
    // switchAccount puts BOB's session in place before the restart; ALICE's engine still writes.
    storage.apply({ area: 'local', seq: 2, ops: [['set', 'yappr_session', session(BOB)]] });
    await storage.apply({ area: 'secure', seq: 3, ops: [['set', 'yappr:pf:cached_cek:x', 'alice-cek']] });
    expect((await storage.snapshot(ALICE)).secure).toEqual({ 'yappr:pf:cached_cek:x': 'alice-cek' });
    expect((await storage.snapshot(BOB)).secure).toEqual({});
  });

  it('wipes what an uninstalled copy left in the Keychain on the first launch of a new install', async () => {
    await storage.apply({ area: 'secure', seq: 1, ops: [['set', `yappr_secure_pk_${ALICE}`, 'old-key']] });
    const oldMmkvKey = keychain.get('pr.yap.app.engine-keys:yappr.mmkv-key.testnet');
    // Relaunch: nothing is wiped.
    const wipe = jest.fn();
    await createEngineStorage('testnet', { wipeServices: wipe }).open();
    expect(wipe).not.toHaveBeenCalled();
    expect(secretItems()).toHaveLength(1);

    // Uninstall deletes app data (the MMKV files) but not Keychain items; then reinstall.
    deleteMMKV('yappr.engine.testnet');
    deleteMMKV('yappr.engine-index.testnet');
    const wipeServices = jest.fn((services: string[]) => {
      for (const key of [...keychain.keys()]) if (services.some((s) => key.startsWith(`${s}:`))) keychain.delete(key);
    });
    const fresh = createEngineStorage('testnet', { wipeServices });
    await fresh.open();
    expect(wipeServices).toHaveBeenCalledWith([SERVICE]);
    expect(secretItems()).toHaveLength(0);
    expect(keychain.get('pr.yap.app.engine-keys:yappr.mmkv-key.testnet')).not.toBe(oldMmkvKey);
    expect(await fresh.snapshot(ALICE)).toEqual({ local: {}, secure: {} });
  });

  it('purges every secret of an account signed out while not active', async () => {
    storage.apply({ area: 'local', seq: 1, ops: [['set', 'yappr_session', session(BOB)]] });
    await storage.apply({
      area: 'secure',
      seq: 2,
      ops: [['set', `yappr_secure_pk_${BOB}`, 'k'], ['set', 'yappr:pf:feed_seed', 'bob-seed']],
    });
    storage.apply({ area: 'local', seq: 3, ops: [['set', 'yappr_session', session(ALICE)]] });
    await storage.apply({ area: 'secure', seq: 4, ops: [['del', `yappr_secure_pk_${BOB}`]] });
    expect(secretItems()).toHaveLength(0);
    expect(storage.stats().identities).toBe(0);
  });

  it('deletes the signed-out active account’s private-feed keys even after its session is gone', async () => {
    storage.apply({ area: 'local', seq: 1, ops: [['set', 'yappr_session', session(ALICE)]] });
    await storage.apply({ area: 'secure', seq: 2, ops: [['set', 'yappr:pf:feed_seed', 'alice-seed']] });
    storage.apply({ area: 'local', seq: 3, ops: [['del', 'yappr_session']] });
    await storage.apply({ area: 'secure', seq: 4, ops: [['del', 'yappr:pf:feed_seed']] });
    expect(secretItems()).toHaveLength(0);
  });

  it('serializes secure batches and reports a failed write', async () => {
    const spy = jest.spyOn(SecureStore, 'setItemAsync').mockRejectedValueOnce(new Error('keychain locked'));
    const failed = storage.apply({ area: 'secure', seq: 1, ops: [['set', 'yappr:pf:a', '1']] });
    const next = storage.apply({ area: 'secure', seq: 2, ops: [['set', 'yappr:pf:b', '2']] });
    await expect(failed).rejects.toThrow('keychain locked');
    await expect(next).resolves.toBeUndefined();
    spy.mockRestore();
    expect((await storage.snapshot(null)).secure).toEqual({ 'yappr:pf:b': '2' });
  });

  it('reset deletes the instances, their key and every secret', async () => {
    storage.apply({ area: 'local', seq: 1, ops: [['set', 'a', '1']] });
    await storage.apply({ area: 'secure', seq: 2, ops: [['set', `yappr_secure_pk_${ALICE}`, 'k']] });
    await storage.reset();
    expect(keychain.size).toBe(0);
    await storage.open();
    expect(await storage.snapshot(ALICE)).toEqual({ local: {}, secure: {} });
  });
});
