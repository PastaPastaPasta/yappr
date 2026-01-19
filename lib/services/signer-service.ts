/**
 * Signer Service - Manages IdentitySigner creation for dev.11+ SDK
 *
 * This service provides utilities for creating signers and identity public keys
 * for use with the new typed state transition APIs in @dashevo/evo-sdk@^3.0.0-dev.11
 */
import initWasm, * as wasmSdk from '@dashevo/wasm-sdk/compressed';
import type { IdentityPublicKey as IdentityPublicKeyType } from './identity-service';

// Track WASM initialization
let wasmInitialized = false;

/**
 * Ensure WASM module is initialized
 */
async function ensureWasmInitialized(): Promise<typeof wasmSdk> {
  if (!wasmInitialized) {
    await initWasm();
    wasmInitialized = true;
  }
  return wasmSdk;
}

/**
 * Purpose enum values
 */
export const KeyPurpose = {
  AUTHENTICATION: 0,
  ENCRYPTION: 1,
  DECRYPTION: 2,
  TRANSFER: 3,
  SYSTEM: 4,
  VOTING: 5,
  OWNER: 6,
} as const;

/**
 * Security level enum values
 */
export const SecurityLevel = {
  MASTER: 0,
  CRITICAL: 1,
  HIGH: 2,
  MEDIUM: 3,
} as const;

/**
 * Key type enum values
 */
export const KeyType = {
  ECDSA_SECP256K1: 0,
  BLS12_381: 1,
  ECDSA_HASH160: 2,
  BIP13_SCRIPT_HASH: 3,
} as const;

class SignerService {
  /**
   * Create an IdentitySigner from a private key WIF
   *
   * The signer is used for signing state transitions in the new typed API.
   *
   * @param privateKeyWif - The private key in WIF format
   * @param network - The network ('testnet' or 'mainnet')
   * @returns A configured IdentitySigner instance
   */
  async createSigner(
    privateKeyWif: string,
    _network: 'testnet' | 'mainnet' = 'testnet'
  ): Promise<wasmSdk.IdentitySigner> {
    const wasm = await ensureWasmInitialized();

    // Create a new signer instance
    const signer = new wasm.IdentitySigner();

    // Add key directly from WIF (the signer has a convenience method for this)
    signer.addKeyFromWif(privateKeyWif);

    return signer;
  }

  /**
   * Create an IdentitySigner from a hex-encoded private key
   *
   * @param privateKeyHex - The private key as a hex string (64 characters)
   * @param network - The network ('testnet' or 'mainnet')
   * @returns A configured IdentitySigner instance
   */
  async createSignerFromHex(
    privateKeyHex: string,
    network: 'testnet' | 'mainnet' = 'testnet'
  ): Promise<wasmSdk.IdentitySigner> {
    const wasm = await ensureWasmInitialized();

    // Create a new signer instance
    const signer = new wasm.IdentitySigner();

    // Create PrivateKey from hex and add to signer
    // Note: fromHex requires network parameter
    const privateKey = wasm.PrivateKey.fromHex(privateKeyHex, network);
    signer.addKey(privateKey);

    return signer;
  }

  /**
   * Create an IdentityPublicKey WASM object from identity key data
   *
   * This creates the WASM IdentityPublicKey object needed for signing
   * state transitions.
   *
   * @param keyData - Key data from identity.publicKeys
   * @returns A WASM IdentityPublicKey object
   */
  async createIdentityPublicKey(
    keyData: IdentityPublicKeyType
  ): Promise<wasmSdk.IdentityPublicKey> {
    const wasm = await ensureWasmInitialized();

    // Normalize the key data to match the expected JSON format
    // The fromJSON method expects camelCase fields
    const normalizedKeyData = {
      id: keyData.id,
      type: keyData.type,
      purpose: keyData.purpose,
      securityLevel: keyData.securityLevel ?? keyData.security_level ?? SecurityLevel.HIGH,
      readOnly: keyData.readOnly ?? keyData.read_only ?? (keyData.purpose === KeyPurpose.TRANSFER),
      data: keyData.data, // Should be base64 encoded string
      disabledAt: keyData.disabledAt ?? keyData.disabled_at,
      contractBounds: keyData.contractBounds ?? keyData.contract_bounds,
    };

    // Use the fromJSON method which handles proper deserialization
    const identityKey = wasm.IdentityPublicKey.fromJSON(normalizedKeyData);

    return identityKey;
  }

  /**
   * Get a signing key from an identity's public keys
   *
   * Finds an appropriate key for signing state transitions.
   * Document operations typically require at least HIGH security level.
   * Identity operations require CRITICAL or MASTER level.
   *
   * @param publicKeys - Array of public keys from the identity
   * @param requiredSecurityLevel - Minimum security level required (default: HIGH = 2)
   * @param keyId - Specific key ID to use (optional)
   * @returns The matching key data, or null if none found
   */
  getSigningKeyData(
    publicKeys: IdentityPublicKeyType[],
    requiredSecurityLevel: number = SecurityLevel.HIGH,
    keyId?: number
  ): IdentityPublicKeyType | null {
    // Filter out disabled keys
    const activeKeys = publicKeys.filter(k => !k.disabledAt);

    if (keyId !== undefined) {
      // Find specific key by ID
      const key = activeKeys.find(k => k.id === keyId);
      if (key) {
        const level = key.securityLevel ?? key.security_level ?? SecurityLevel.MEDIUM;
        if (level <= requiredSecurityLevel) {
          return key;
        }
      }
      return null;
    }

    // Find key with appropriate security level
    // Look for AUTHENTICATION purpose keys first
    const authKeys = activeKeys.filter(k => k.purpose === KeyPurpose.AUTHENTICATION);

    // Sort by security level (lower = more secure) and find first that meets requirement
    const sortedKeys = authKeys.sort((a, b) => {
      const levelA = a.securityLevel ?? a.security_level ?? SecurityLevel.MEDIUM;
      const levelB = b.securityLevel ?? b.security_level ?? SecurityLevel.MEDIUM;
      return levelA - levelB;
    });

    for (const key of sortedKeys) {
      const level = key.securityLevel ?? key.security_level ?? SecurityLevel.MEDIUM;
      if (level <= requiredSecurityLevel) {
        return key;
      }
    }

    return null;
  }

  /**
   * Create both signer and identity key for a state transition
   *
   * This is a convenience method that creates both objects needed
   * for the new typed state transition API.
   *
   * @param privateKeyWif - The private key in WIF format
   * @param keyData - The public key data from the identity
   * @param network - The network ('testnet' or 'mainnet')
   * @returns Object containing signer and identityKey
   */
  async createSignerAndKey(
    privateKeyWif: string,
    keyData: IdentityPublicKeyType,
    network: 'testnet' | 'mainnet' = 'testnet'
  ): Promise<{
    signer: wasmSdk.IdentitySigner;
    identityKey: wasmSdk.IdentityPublicKey;
  }> {
    const [signer, identityKey] = await Promise.all([
      this.createSigner(privateKeyWif, network),
      this.createIdentityPublicKey(keyData),
    ]);

    return { signer, identityKey };
  }
}

// Singleton instance
export const signerService = new SignerService();
