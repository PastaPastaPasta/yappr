/**
 * ECIES (SPEC §11.5) shared by every feature that seals bytes to an identity's
 * ENCRYPTION key: private-feed seeds and grants (lib/private-feed/crypto.ts),
 * storefront orders and addresses, and digital delivery. The wire format is
 * ephemeralPub (33) ‖ XChaCha20-Poly1305 ciphertext; it lives on chain, so it
 * never changes (lib/crypto/compat.test.ts).
 */

import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { concatBytes as concat } from '@/lib/bytes';
import { getPublicKey } from '@/lib/crypto/keys';
import { ecdhSharedX } from '@/lib/crypto/ecdh';

const KEY_SIZE = 32;
const NONCE_SIZE = 24;
const INFO_ECIES = 'yappr/ecies/v1';

const utf8Encode = (str: string) => new TextEncoder().encode(str);

class PrivateFeedCryptoService {
  // ============================================================
  // ECIES Encryption (SPEC §11.5)
  // ============================================================

  /**
   * Symmetric key and nonce for one ECIES message (SPEC §11.5.1 steps 2-3):
   * HKDF(SHA256(ECDH x-coordinate), salt = ephemeral public key).
   */
  private eciesKeyAndNonce(sharedX: Uint8Array, ephemeralPubKey: Uint8Array): { encKey: Uint8Array; nonce: Uint8Array } {
    const derived = hkdf(sha256, sha256(sharedX), ephemeralPubKey, utf8Encode(INFO_ECIES), KEY_SIZE + NONCE_SIZE);
    return { encKey: derived.slice(0, KEY_SIZE), nonce: derived.slice(KEY_SIZE, KEY_SIZE + NONCE_SIZE) };
  }

  /**
   * ECIES Encrypt (SPEC §11.5.1) with a fresh ephemeral keypair.
   * Returns ephemeralPubKey || XChaCha20-Poly1305 ciphertext.
   */
  async eciesEncrypt(
    recipientPubKey: Uint8Array,
    plaintext: Uint8Array,
    aad: Uint8Array
  ): Promise<Uint8Array> {
    return this.eciesEncryptWithEphemeralKey(randomBytes(KEY_SIZE), recipientPubKey, plaintext, aad);
  }

  /**
   * ECIES Decrypt (SPEC §11.5.2) as the recipient.
   */
  async eciesDecrypt(
    recipientPrivKey: Uint8Array,
    eciesCiphertext: Uint8Array,
    aad: Uint8Array
  ): Promise<Uint8Array> {
    const ephemeralPubKey = eciesCiphertext.slice(0, 33);
    const { encKey, nonce } = this.eciesKeyAndNonce(ecdhSharedX(recipientPrivKey, ephemeralPubKey), ephemeralPubKey);
    return xchacha20poly1305(encKey, nonce, aad).decrypt(eciesCiphertext.slice(33));
  }

  // ============================================================
  // Order Encryption (Deterministic Ephemeral ECIES)
  // ============================================================

  /**
   * Derive deterministic ephemeral key for order encryption.
   * Allows buyer to re-derive the same key for decryption.
   *
   * @param buyerPrivateKey - Buyer's encryption private key (32 bytes)
   * @param nonce - Order nonce (24 bytes)
   * @param storeId - Store identifier string
   * @returns Deterministic ephemeral private key (32 bytes)
   */
  deriveOrderEphemeralKey(
    buyerPrivateKey: Uint8Array,
    nonce: Uint8Array,
    storeId: string
  ): Uint8Array {
    const salt = concat(nonce, utf8Encode(storeId));
    return hkdf(sha256, buyerPrivateKey, salt, utf8Encode('yappr/order-eph/v1'), KEY_SIZE);
  }

  /**
   * ECIES Encrypt with a caller-supplied ephemeral key. Used for orders, where
   * the buyer re-derives the ephemeral key deterministically to decrypt later.
   * Same wire format as `eciesEncrypt`: ephemeralPubKey || ciphertext.
   */
  async eciesEncryptWithEphemeralKey(
    ephemeralPrivKey: Uint8Array,
    recipientPubKey: Uint8Array,
    plaintext: Uint8Array,
    aad: Uint8Array
  ): Promise<Uint8Array> {
    const ephemeralPubKey = getPublicKey(ephemeralPrivKey);
    const { encKey, nonce } = this.eciesKeyAndNonce(ecdhSharedX(ephemeralPrivKey, recipientPubKey), ephemeralPubKey);
    return concat(ephemeralPubKey, xchacha20poly1305(encKey, nonce, aad).encrypt(plaintext));
  }

  /**
   * ECIES Decrypt with a known ephemeral private key (the buyer's re-derived
   * one). ECDH(ephemeralPriv, recipientPub) equals ECDH(recipientPriv,
   * ephemeralPub), so this reaches the same key the seller would.
   */
  async eciesDecryptWithEphemeralKey(
    ephemeralPrivKey: Uint8Array,
    recipientPubKey: Uint8Array,
    eciesCiphertext: Uint8Array,
    aad: Uint8Array
  ): Promise<Uint8Array> {
    const ephemeralPubKey = eciesCiphertext.slice(0, 33);
    const { encKey, nonce } = this.eciesKeyAndNonce(ecdhSharedX(ephemeralPrivKey, recipientPubKey), ephemeralPubKey);
    return xchacha20poly1305(encKey, nonce, aad).decrypt(eciesCiphertext.slice(33));
  }

}

export const privateFeedCryptoService = new PrivateFeedCryptoService();
