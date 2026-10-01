/**
 * Naming rules for the engine's secure area in expo-secure-store
 * (ENGINE.md §9.2). Pure, so it is unit-tested without native modules.
 */

/**
 * SecureStore keys may contain only `[A-Za-z0-9._-]`. Each `-`, and each
 * UTF-8 byte of any other character, is written as `-` plus two lowercase hex
 * digits, which is reversible and collision-free: an encoded key never
 * contains `-` followed by anything but two hex digits.
 */
export function encodeSecureKey(key: string): string {
  let out = '';
  for (const char of key) {
    if (/^[A-Za-z0-9._]$/.test(char)) out += char;
    else {
      // encodeURIComponent yields the UTF-8 bytes as %XX, except for `-!~*'()`.
      const escaped = encodeURIComponent(char);
      out += escaped.startsWith('%')
        ? escaped.replace(/%/g, '-').toLowerCase()
        : `-${char.charCodeAt(0).toString(16).padStart(2, '0')}`;
    }
  }
  return out;
}

export function decodeSecureKey(encoded: string): string {
  if (!/^(?:[A-Za-z0-9._]|-[0-9a-f]{2})*$/.test(encoded)) {
    throw new Error(`Not an encoded secure key: ${encoded}`);
  }
  return decodeURIComponent(encoded.replace(/-([0-9a-f]{2})/g, '%$1'));
}

/** Two alternating item sets per key, so a value is replaced without ever being half written. */
export type Slot = 'a' | 'b';

/**
 * The SecureStore item holding chunk `chunk` of `key` in `bucket`'s `slot`.
 * The bucket is part of the name, so two accounts' values of the same key
 * (lib's private-feed keys carry no identity) never share an item. `-z` never
 * occurs in an encoded name (`z` is not a hex digit), so the suffix cannot
 * collide with another key's name.
 */
export function secureItemName(bucket: string, key: string, slot: Slot, chunk: number): string {
  return `${encodeSecureKey(`${bucket}|${key}`)}-z${slot}${chunk}`;
}

/**
 * Values are split into chunks of this many UTF-16 units. The secrets are
 * JSON over base64/WIF/hex (ASCII), so a chunk stays within the 2048-byte
 * value size SecureStore historically documented for the iOS Keychain. Only
 * `yappr:pf:path_keys:*` is expected to need more than one.
 */
export const SECURE_CHUNK_CHARS = 2000;

/** Bucket for secure keys written while nobody is signed in (a pending key exchange). */
export const SHARED_BUCKET = '';

/** lib's secret store: `yappr_secure_<name>_<identityId>`, a Platform identity id (base58, 43–44 characters). */
const IDENTITY_KEY = /^yappr_secure_.*_([1-9A-HJ-NP-Za-km-z]{42,44})$/;

/**
 * The identity a secure key names, if any. lib's secret store keys do; the
 * private-feed (`yappr:pf:*`) and upload keys do not, and belong to whichever
 * account was signed in when they were written (mobile/engine/README.md,
 * `session.signOut`).
 */
export function identityInKey(key: string): string | null {
  return IDENTITY_KEY.exec(key)?.[1] ?? null;
}

/** Signing an identity out deletes its auth key; for a non-active identity that is the cue to purge its bucket. */
export function isAuthKeyOf(key: string, identityId: string): boolean {
  return key === `yappr_secure_pk_${identityId}`;
}
