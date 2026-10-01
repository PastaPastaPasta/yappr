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

/**
 * The key of chunk `index` of a long value. `-z` never occurs in an encoded
 * key (`z` is not a hex digit), so chunk keys cannot collide with real ones.
 */
export function chunkKey(encoded: string, index: number): string {
  return `${encoded}-z${index}`;
}

/**
 * Values are split into chunks of this many UTF-16 units. The secrets are
 * JSON over base64/WIF/hex (ASCII), so a chunk stays within the 2048-byte
 * value size SecureStore historically documented for the iOS Keychain. Only
 * `yappr:pf:path_keys:*` is expected to need more than one.
 */
export const SECURE_CHUNK_CHARS = 2000;

/** Bucket for secure keys that belong to no identity. */
export const SHARED_BUCKET = '';

/** A Platform identity id: base58, 32 bytes → 43 or 44 characters. */
const IDENTITY_SUFFIX = /[_:]([1-9A-HJ-NP-Za-km-z]{42,44})$/;

/**
 * The identity a secure key belongs to: lib's secret store writes
 * `yappr_secure_<name>_<identityId>`, and identity-scoped private-feed keys
 * end in `:<identityId>`. Anything else goes to the shared bucket, which is
 * hydrated for every account.
 */
export function identityOfKey(key: string): string {
  return IDENTITY_SUFFIX.exec(key)?.[1] ?? SHARED_BUCKET;
}
