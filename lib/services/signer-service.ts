/**
 * Signer Service - Manages IdentitySigner creation for the typed state transition API
 *
 * This service provides utilities for creating signers and identity public keys
 * for use with the new typed state transition APIs in @dashevo/evo-sdk
 *
 * IMPORTANT: We import WASM types from @dashevo/evo-sdk which re-exports them from
 * @dashevo/wasm-sdk. By calling getEvoSdk() first, we ensure the shared WASM module
 * is initialized before creating any WASM objects.
 */
import { getEvoSdk } from './evo-sdk-service';
import { IdentitySigner } from '@dashevo/evo-sdk';
import type { IdentityPublicKey as WasmIdentityPublicKey } from '@dashevo/wasm-sdk/compressed';

/**
 * Ensure WASM module is initialized by connecting SDK
 * This guarantees the shared WASM module is ready before creating objects
 */
async function ensureWasmReady(): Promise<void> {
  await getEvoSdk();
}

/**
 * Purpose enum values
 * Matches KeyPurpose from @dashevo/wasm-sdk
 * Note: SYSTEM and VOTING are official SDK values.
 * OWNER is included for forward compatibility.
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

class SignerService {
  /**
   * Create an IdentitySigner from a private key WIF
   *
   * The signer is used for signing state transitions in the new typed API.
   *
   * @param privateKeyWif - The private key in WIF format
   * @returns A configured IdentitySigner instance
   */
  async createSigner(
    privateKeyWif: string
  ): Promise<InstanceType<typeof IdentitySigner>> {
    // Ensure WASM is initialized before creating objects
    await ensureWasmReady();

    // Create a new signer instance using imported class
    const signer = new IdentitySigner();

    // Add key directly from WIF (the signer has a convenience method for this)
    signer.addKeyFromWif(privateKeyWif);

    return signer;
  }

  /**
   * Create signer and identity key from a WASM public key
   *
   * This is the preferred method for creating signing credentials from
   * identity keys obtained via identity.publicKeys.
   *
   * The WASM key is used directly since it's already the correct type
   * for SDK state transition operations.
   *
   * @param privateKeyWif - The private key in WIF format
   * @param wasmKey - The WASM IdentityPublicKey from identity.publicKeys
   * @returns Object containing signer and identityKey
   */
  async createSignerFromWasmKey(
    privateKeyWif: string,
    wasmKey: WasmIdentityPublicKey
  ): Promise<{
    signer: InstanceType<typeof IdentitySigner>;
    identityKey: WasmIdentityPublicKey;
  }> {
    const signer = await this.createSigner(privateKeyWif);
    // Use the WASM key directly - it's already the correct type for SDK operations
    return { signer, identityKey: wasmKey };
  }
}

// Singleton instance
export const signerService = new SignerService();
