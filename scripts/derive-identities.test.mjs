import { describe, expect, it } from 'vitest';
import { deriveIdentityKeys } from './derive-identities.mjs';

// BIP-39's public all-zero-entropy phrase, never a real one.
const TEST_PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('deriveIdentityKeys', () => {
  it('keeps the legacy layout by default (the registered e2e pool depends on it)', () => {
    const keys = deriveIdentityKeys(3, TEST_PHRASE);
    expect(keys.map((key) => key.path)).toEqual([0, 1, 2, 3, 4].map((keyIndex) => `m/9'/1'/5'/0'/3'/${keyIndex}'`));
  });

  it('derives DIP-13 identity keys, without an unbound encryption key, in the dip13 layout', () => {
    const keys = deriveIdentityKeys(0, TEST_PHRASE, { layout: 'dip13' });
    expect(keys.map((key) => [key.path, key.purpose, key.securityLevel])).toEqual([
      ["m/9'/1'/5'/0'/0'/0'/0'", 'AUTHENTICATION', 'MASTER'],
      ["m/9'/1'/5'/0'/0'/0'/1'", 'AUTHENTICATION', 'CRITICAL'],
      ["m/9'/1'/5'/0'/0'/0'/2'", 'AUTHENTICATION', 'HIGH'],
      ["m/9'/1'/5'/0'/0'/0'/3'", 'TRANSFER', 'CRITICAL'],
    ]);
    // The same key lib/crypto/dip13.test.ts pins through wasm-sdk: what discovery looks the identity up by.
    expect(keys[0].publicKeyHex).toBe('03a00f4853081aeb8c9debe37267303fa133bd7f6678bfb3299dfa001bfd0341db');
  });

  it('refuses an unknown layout', () => {
    expect(() => deriveIdentityKeys(0, TEST_PHRASE, { layout: 'bip44' })).toThrow('Unknown key layout');
  });
});
