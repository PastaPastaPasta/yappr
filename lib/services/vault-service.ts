'use client';

import { logger } from '@/lib/logger';
import { BaseDocumentService } from './document-service';
import { dpnsService } from './dpns-service';
import { YAPPR_VAULT_CONTRACT_ID, DOCUMENT_TYPES } from '../constants';
import {
  validateBackupPassword,
  benchmarkPbkdf2,
  type BenchmarkResult,
} from '../onchain-key-encryption';
import {
  aesGcmEncrypt,
  aesGcmDecrypt,
  deriveKeyFromPasswordAndSalt,
  deriveAesKeyFromPrivateKey,
} from '../crypto/aes-gcm';

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

  /**
   * Override extractContentFields to convert Uint8Array fields to number[] for platform serialization.
   * Without this, the merge path in BaseDocumentService.update would send raw Uint8Array values.
   */
  protected extractContentFields(doc: VaultDocument): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    if (doc.encryptedData) result.encryptedData = Array.from(doc.encryptedData);
    if (doc.passwordEncryptedData) result.passwordEncryptedData = Array.from(doc.passwordEncryptedData);
    if (doc.pbkdf2Salt) result.pbkdf2Salt = Array.from(doc.pbkdf2Salt);
    if (doc.pbkdf2Iterations !== undefined) result.pbkdf2Iterations = doc.pbkdf2Iterations;
    return result;
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

    const aesKey = await deriveAesKeyFromPrivateKey(encryptionPrivateKey);
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
      const aesKey = await deriveAesKeyFromPrivateKey(encryptionPrivateKey);
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
