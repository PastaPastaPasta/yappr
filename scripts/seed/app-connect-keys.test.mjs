import { describe, expect, it } from 'vitest';
import bs58 from 'bs58';
import { getPublicKey } from '@noble/secp256k1';
import { deriveAppConnectEncryptionKey } from '../../mobile/tools/src/app-connect/derive.ts';
import { deriveSeedAppConnectEncryptionKey } from './app-connect-keys.mjs';
import { orderKeys, sealOrder, sealStatus, loadActorMap, verifySeedEncryptionKeys, verifyStorefrontCheckpoint } from './non-social/storefront.mjs';
import { storeOrderService } from '../../lib/services/store-order-service.ts';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buyerOrderDeliveryKey, sellerOrderDeliveryKey, decryptOrderStatusNote, decodeOrderStatusNote } from '../../lib/crypto/digital-delivery.ts';

const bytes = n => new Uint8Array(32).fill(n);
const hex = value => Buffer.from(value).toString('hex');
const appId = bs58.encode(bytes(3));
const persona = (idx, n) => ({ personaIdx: idx, identityId: bs58.encode(bytes(n + 20)), identityKeys: [
  { keyId: 1, purpose: 'authentication', privateKeyHex: hex(bytes(n)), publicKeyHex: hex(getPublicKey(bytes(n))) },
  { keyId: 3, purpose: 'encryption', privateKeyHex: hex(bytes(n + 10)), publicKeyHex: hex(getPublicKey(bytes(n + 10))) },
] });

describe('App Connect storefront seed keys', () => {
  it('matches the independent test-wallet derivation and separates anchors', () => {
    const id = bs58.encode(bytes(21));
    const expected = deriveAppConnectEncryptionKey(bytes(1), bs58.decode(id), bs58.decode(appId), 1, 0);
    expect(deriveSeedAppConnectEncryptionKey(bytes(1), id, appId)).toEqual(expected);
    expect(deriveSeedAppConnectEncryptionKey(bytes(1), id, bs58.encode(bytes(4)))).not.toEqual(expected);
    expect(() => deriveSeedAppConnectEncryptionKey(bytes(1), id, '1')).toThrow('32-byte');
  });

  it('uses remapped actors and opens a seeded status with both app roles', async () => {
    const buyer = persona(310, 7), seller = persona(220, 11);
    const ledger = { identities: [buyer, seller] };
    const keys = orderKeys(ledger, { buyer: 'bo', store: 'coffee' }, false, { appId, actorMap: { 200: 220, 201: 310 } });
    const walletKey = entry => deriveAppConnectEncryptionKey(Buffer.from(entry.identityKeys[0].privateKeyHex, 'hex'), bs58.decode(entry.identityId), bs58.decode(appId), 1, 0);
    expect(keys.buyerPriv).toEqual(walletKey(buyer));
    expect(keys.sellerPriv).toEqual(walletKey(seller));
    expect(hex(keys.sellerPub)).not.toBe(seller.identityKeys[1].publicKeyHex);
    const name = 'anchor-interop';
    const storeId = bs58.encode(bytes(5)), id = bs58.encode(bytes(6));
    const payload = { items: [{ title: 'Demo' }], total: 100, currency: 'USD' };
    const { nonce, encryptedPayload } = sealOrder({ key: name }, payload, keys, storeId);
    for (const [privateKey, publicKey, isBuyer] of [[walletKey(buyer), keys.sellerPub, true], [walletKey(seller), null, false]]) {
      expect(await storeOrderService.decryptOrderPayload(encryptedPayload, nonce, storeId, privateKey, publicKey, isBuyer)).toEqual(payload);
    }
    const order = { id, storeId, nonce, encryptedPayload };
    const note = { message: 'Ready to ship', trackingNumber: 'demo-123' };
    const sealed = sealStatus({ key: name }, 'shipped', note, keys, storeId, id);
    for (const deliveryKey of [sellerOrderDeliveryKey(order, walletKey(seller)), buyerOrderDeliveryKey(order, walletKey(buyer), keys.sellerPub)]) {
      expect(decodeOrderStatusNote(decryptOrderStatusNote(sealed.encryptedPayload, sealed.nonce, deliveryKey, id))).toEqual(note);
    }
  });

  it('rejects ambiguous actor maps before any write', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yappr-actor-map-'));
    const file = join(dir, 'map.json');
    try {
      for (const map of [{ 200: null }, { 200: 201 }, { 200: -1 }, { 200: 1.5 }, { 999: 500 }]) {
        writeFileSync(file, JSON.stringify(map));
        expect(() => loadActorMap(file)).toThrow('--actor-map');
      }
      writeFileSync(file, JSON.stringify({ 200: 220 }));
      expect(loadActorMap(file)[200]).toBe(220);
    } finally { rmSync(dir, { recursive: true }); }
  });

  it('rejects unverified confirmed and pending checkpoint entries', () => {
    for (const field of ['docs', 'pendingCreates']) {
      expect(() => verifyStorefrontCheckpoint({ [field]: { order: 'id' } }, appId, '{}')).toThrow('unverified');
      expect(() => verifyStorefrontCheckpoint({ [field]: { order: 'id' }, encryptionAppId: appId, actorMap: '{}' }, appId, '{}')).not.toThrow();
    }
    expect(() => verifyStorefrontCheckpoint({}, appId, '{}')).not.toThrow();
  });

  it('requires the exact single advertised anchor key, matched by identity', async () => {
    const actor = persona(220, 11), ledger = { identities: [actor] };
    const privateKey = deriveAppConnectEncryptionKey(bytes(11), bs58.decode(actor.identityId), bs58.decode(appId), 1, 0);
    const key = { data: hex(getPublicKey(privateKey, true)) };
    let rows = [{ identityId: bs58.encode(bytes(30)), keys: [] }, { identityId: actor.identityId, keys: [key] }];
    const battery = { readback: f => f(), sdk: { identities: { contractKeys: async () => rows } } };
    await expect(verifySeedEncryptionKeys(battery, ledger, { 200: 220 }, appId)).resolves.toBeUndefined();
    for (const keys of [[], [key, key], [{ data: getPublicKey(bytes(12), true) }]]) {
      rows = [{ identityId: actor.identityId, keys }];
      await expect(verifySeedEncryptionKeys(battery, ledger, { 200: 220 }, appId)).rejects.toThrow('advertised');
    }
  });
});
