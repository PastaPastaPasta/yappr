import bs58 from 'bs58';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes } from '@noble/hashes/utils.js';
import { utils } from '@noble/secp256k1';

/** The pool test wallet's encryption key, matching mobile/tools/src/app-connect/derive.ts (purpose 1, rotation 0). */
export function deriveSeedAppConnectEncryptionKey(baseKey, identityId, appId) {
  const identity = bs58.decode(identityId), app = bs58.decode(appId);
  if (baseKey.length !== 32 || identity.length !== 32 || app.length !== 32) throw new Error('App Connect key derivation requires 32-byte inputs');
  const info = concatBytes(new TextEncoder().encode('yappr-test-wallet/app-connect/enc'), app, Uint8Array.of(1, 0, 0, 0, 0));
  for (let counter = 0; counter <= 255; counter++) {
    const key = hkdf(sha256, baseKey, identity, counter === 0 ? info : concatBytes(info, Uint8Array.of(counter)), 32);
    if (utils.isValidSecretKey(key)) return key;
  }
  throw new Error('App Connect key derivation exhausted');
}
