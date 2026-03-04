'use client';

import { logger } from '@/lib/logger';
import { BaseDocumentService } from './document-service';
import { dpnsService } from './dpns-service';
import { YAPPR_VAULT_CONTRACT_ID, DOCUMENT_TYPES } from '../constants';
import {
  validateBackupPassword,
  benchmarkPbkdf2,
  MIN_KDF_ITERATIONS,
  MAX_KDF_ITERATIONS,
  type BenchmarkResult,
} from '../onchain-key-encryption';

// ---------- Types ----------

export interface VaultDocument {
  $id: string;
  $ownerId: string;
  $createdAt: number;
  $revision: number;
  encryptedData?: Uint8Array;
  passwordEncryptedData?: Uint8Array;
  pbkdf2Salt?: Uint8Array;
  pbkdf2Iterations?: number;
}

export interface VaultPayload {
  version: 1;
  keys: Array<{ wif: string; keyId: number; label: string }>;
}

export interface LoginWithPasswordResult {
  identityId: string;
  privateKey: string;
}

// ---------- Helpers ----------

function toUint8Array(data: unknown): Uint8Array | undefined {
  if (data instanceof Uint8Array) return data;
  if (Array.isArray(data)) return new Uint8Array(data);
  if (typeof data === 'string') {
    // base64
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  return undefined;
}

/**
 * Derive an AES-256 key from password + explicit salt via PBKDF2.
 */
async function deriveKeyFromPasswordAndSalt(
  password: string,
  salt: Uint8Array,
  iterations: number
): Promise<CryptoKey> {
  if (iterations < MIN_KDF_ITERATIONS || iterations > MAX_KDF_ITERATIONS) {
    throw new Error(`Iterations must be between ${MIN_KDF_ITERATIONS} and ${MAX_KDF_ITERATIONS}`);
  }
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits', 'deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt.buffer as ArrayBuffer, iterations, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * AES-GCM encrypt: returns IV (12 bytes) prepended to ciphertext.
 */
async function aesGcmEncrypt(key: CryptoKey, plaintext: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer },
    key,
    plaintext.buffer as ArrayBuffer
  );
  const result = new Uint8Array(12 + ciphertext.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(ciphertext), 12);
  return result;
}

/**
 * AES-GCM decrypt: expects IV (12 bytes) prepended to ciphertext.
 */
async function aesGcmDecrypt(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  const iv = data.slice(0, 12);
  const ciphertext = data.slice(12);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer },
    key,
    ciphertext.buffer as ArrayBuffer
  );
  return new Uint8Array(plaintext);
}

// ---------- Service ----------

class VaultService extends BaseDocumentService<VaultDocument> {
  constructor() {
    super(DOCUMENT_TYPES.VAULT, YAPPR_VAULT_CONTRACT_ID);
  }

  isConfigured(): boolean {
    return Boolean(YAPPR_VAULT_CONTRACT_ID && !YAPPR_VAULT_CONTRACT_ID.includes('PLACEHOLDER'));
  }

  protected transformDocument(doc: Record<string, unknown>): VaultDocument {
    const data = (doc.data || doc) as Record<string, unknown>;
    return {
      $id: doc.$id as string,
      $ownerId: doc.$ownerId as string,
      $createdAt: doc.$createdAt as number,
      $revision: (doc.$revision as number) ?? 1,
      encryptedData: toUint8Array(data.encryptedData),
      passwordEncryptedData: toUint8Array(data.passwordEncryptedData),
      pbkdf2Salt: toUint8Array(data.pbkdf2Salt),
      pbkdf2Iterations: data.pbkdf2Iterations as number | undefined,
    };
  }

  // ---- CRUD ----

  async getVault(identityId: string): Promise<VaultDocument | null> {
    if (!this.isConfigured()) return null;
    try {
      const result = await this.query({
        where: [['$ownerId', '==', identityId]],
        limit: 1,
      });
      return result.documents.length > 0 ? result.documents[0] : null;
    } catch (error) {
      logger.error('VaultService: Error getting vault:', error);
      return null;
    }
  }

  async createOrUpdateVault(
    identityId: string,
    fields: Partial<Pick<VaultDocument, 'encryptedData' | 'passwordEncryptedData' | 'pbkdf2Salt' | 'pbkdf2Iterations'>>
  ): Promise<VaultDocument> {
    if (!this.isConfigured()) {
      throw new Error('Vault contract is not configured');
    }

    const existing = await this.getVault(identityId);

    // Build the document data — convert Uint8Array to number[] for platform serialization
    const docData: Record<string, unknown> = {};
    if (fields.encryptedData) docData.encryptedData = Array.from(fields.encryptedData);
    if (fields.passwordEncryptedData) docData.passwordEncryptedData = Array.from(fields.passwordEncryptedData);
    if (fields.pbkdf2Salt) docData.pbkdf2Salt = Array.from(fields.pbkdf2Salt);
    if (fields.pbkdf2Iterations !== undefined) docData.pbkdf2Iterations = fields.pbkdf2Iterations;

    if (existing) {
      return await this.update(existing.$id, identityId, docData);
    }
    return await this.create(identityId, docData);
  }

  async deleteVault(identityId: string): Promise<boolean> {
    if (!this.isConfigured()) return false;
    try {
      const vault = await this.getVault(identityId);
      if (!vault) return true;
      return await this.delete(vault.$id, identityId);
    } catch (error) {
      logger.error('VaultService: Error deleting vault:', error);
      return false;
    }
  }

  // ---- Password backup ----

  async hasPasswordBackup(identityId: string): Promise<boolean> {
    if (!this.isConfigured()) return false;
    try {
      const vault = await this.getVault(identityId);
      return Boolean(vault?.passwordEncryptedData && vault.pbkdf2Salt && vault.pbkdf2Iterations);
    } catch (error) {
      logger.error('VaultService: Error checking password backup:', error);
      return false;
    }
  }

  async hasPasswordBackupByUsername(username: string): Promise<boolean> {
    if (!this.isConfigured()) return false;
    try {
      const identityId = await dpnsService.resolveIdentity(username);
      if (!identityId) return false;
      return this.hasPasswordBackup(identityId);
    } catch (error) {
      logger.error('VaultService: Error checking backup by username:', error);
      return false;
    }
  }

  async benchmarkDevice(targetMs = 2000): Promise<BenchmarkResult> {
    return benchmarkPbkdf2(targetMs);
  }

  /**
   * Save a password-encrypted backup of the private key to the vault contract.
   */
  async savePasswordBackup(
    identityId: string,
    privateKeyWif: string,
    password: string,
    iterations: number
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.isConfigured()) {
      return { success: false, error: 'Vault contract is not configured' };
    }

    const validation = validateBackupPassword(password);
    if (!validation.valid) {
      return { success: false, error: validation.error };
    }

    try {
      // Generate random salt (32 bytes as required by contract)
      const salt = crypto.getRandomValues(new Uint8Array(32));

      // Derive key and encrypt
      const key = await deriveKeyFromPasswordAndSalt(password, salt, iterations);
      const encoder = new TextEncoder();
      const encrypted = await aesGcmEncrypt(key, encoder.encode(privateKeyWif));

      await this.createOrUpdateVault(identityId, {
        passwordEncryptedData: encrypted,
        pbkdf2Salt: salt,
        pbkdf2Iterations: iterations,
      });

      return { success: true };
    } catch (error) {
      logger.error('VaultService: Error saving password backup:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to save backup' };
    }
  }

  /**
   * Login with username + password by decrypting the vault's password backup.
   */
  async loginWithPassword(username: string, password: string): Promise<LoginWithPasswordResult> {
    if (!this.isConfigured()) {
      throw new Error('Vault contract is not configured');
    }

    const normalizedUsername = username.trim();
    const isIdentityId = /^[1-9A-HJ-NP-Za-km-z]{42,46}$/.test(normalizedUsername);
    const identityId = isIdentityId ? normalizedUsername : await dpnsService.resolveIdentity(normalizedUsername);
    if (!identityId) {
      throw new Error('Username not found');
    }

    const vault = await this.getVault(identityId);
    if (!vault?.passwordEncryptedData || !vault.pbkdf2Salt || !vault.pbkdf2Iterations) {
      throw new Error('No password backup found in vault');
    }

    try {
      const key = await deriveKeyFromPasswordAndSalt(password, vault.pbkdf2Salt, vault.pbkdf2Iterations);
      const decrypted = await aesGcmDecrypt(key, vault.passwordEncryptedData);
      const decoder = new TextDecoder();
      const privateKey = decoder.decode(decrypted);
      return { identityId, privateKey };
    } catch {
      throw new Error('Invalid password');
    }
  }

  // ---- Vault data (encryption-key-encrypted) ----

  /**
   * Save encrypted vault data (e.g., old keys) using the identity's encryption private key.
   */
  async saveVaultData(
    identityId: string,
    payload: VaultPayload,
    encryptionPrivateKey: Uint8Array
  ): Promise<void> {
    if (!this.isConfigured()) {
      throw new Error('Vault contract is not configured');
    }

    // Use the encryption private key as AES key material via SHA-256
    const keyMaterial = await crypto.subtle.digest('SHA-256', encryptionPrivateKey.buffer as ArrayBuffer);
    const aesKey = await crypto.subtle.importKey(
      'raw',
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );

    const encoder = new TextEncoder();
    const encrypted = await aesGcmEncrypt(aesKey, encoder.encode(JSON.stringify(payload)));

    await this.createOrUpdateVault(identityId, { encryptedData: encrypted });
  }

  /**
   * Decrypt and return vault data using the identity's encryption private key.
   */
  async getVaultData(
    identityId: string,
    encryptionPrivateKey: Uint8Array
  ): Promise<VaultPayload | null> {
    if (!this.isConfigured()) return null;

    const vault = await this.getVault(identityId);
    if (!vault?.encryptedData) return null;

    try {
      const keyMaterial = await crypto.subtle.digest('SHA-256', encryptionPrivateKey.buffer as ArrayBuffer);
      const aesKey = await crypto.subtle.importKey(
        'raw',
        keyMaterial,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
      );

      const decrypted = await aesGcmDecrypt(aesKey, vault.encryptedData);
      const decoder = new TextDecoder();
      return JSON.parse(decoder.decode(decrypted)) as VaultPayload;
    } catch (error) {
      logger.error('VaultService: Error decrypting vault data:', error);
      return null;
    }
  }
}

export const vaultService = new VaultService();
