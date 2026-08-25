import { logger } from '@/lib/logger';
import { BaseDocumentService } from './document-service';
import { stateTransitionService } from './state-transition-service';
import { dpnsService } from './dpns-service';
import { ENCRYPTED_KEY_BACKUP_CONTRACT_ID, DOCUMENT_TYPES } from '../constants';
import {
  encryptKeyForOnchain,
  decryptKeyFromOnchain,
  validateBackupPassword,
  benchmarkPbkdf2,
  decryptBackupPayload,
  OnchainEncryptedData,
  BenchmarkResult,
  StorachaBackupCredentials,
} from '../onchain-key-encryption';

export interface EncryptedKeyBackupDocument {
  $id: string;
  $ownerId: string;
  $createdAt: number;
  $revision: number;
  encryptedKey: string;
  iv: string;
  version: number;
  kdfIterations: number;
}

export interface CreateBackupResult {
  success: boolean;
  error?: string;
  documentId?: string;
}

export interface LoginWithPasswordResult {
  identityId: string;
  privateKey: string;
  storachaCredentials?: StorachaBackupCredentials;
}

class EncryptedKeyService extends BaseDocumentService<EncryptedKeyBackupDocument> {
  constructor() {
    super(DOCUMENT_TYPES.ENCRYPTED_KEY_BACKUP, ENCRYPTED_KEY_BACKUP_CONTRACT_ID);
  }

  /**
   * Check if the contract is configured
   */
  isConfigured(): boolean {
    return Boolean(ENCRYPTED_KEY_BACKUP_CONTRACT_ID && ENCRYPTED_KEY_BACKUP_CONTRACT_ID.length > 0);
  }

  /**
   * Transform raw document to typed object
   * SDK v3: System fields use $ prefix
   */
  protected transformDocument(doc: Record<string, unknown>): EncryptedKeyBackupDocument {
    const data = (doc.data || doc) as Record<string, unknown>;
    return {
      $id: doc.$id as string,
      $ownerId: doc.$ownerId as string,
      $createdAt: doc.$createdAt as number,
      $revision: (doc.$revision as number) ?? 1,
      encryptedKey: data.encryptedKey as string,
      iv: data.iv as string,
      version: data.version as number,
      kdfIterations: data.kdfIterations as number
    };
  }

  /**
   * Check if backup exists for an identity
   */
  async hasBackup(identityId: string): Promise<boolean> {
    if (!this.isConfigured()) {
      return false;
    }

    try {
      const backup = await this.getBackupByIdentityId(identityId);
      return backup !== null;
    } catch (error) {
      logger.error('Error checking backup existence:', error);
      return false;
    }
  }

  /**
   * Check if backup exists for a username
   */
  async hasBackupByUsername(username: string): Promise<boolean> {
    if (!this.isConfigured()) {
      return false;
    }

    try {
      const identityId = await dpnsService.resolveIdentity(username);
      if (!identityId) {
        return false;
      }
      return this.hasBackup(identityId);
    } catch (error) {
      logger.error('Error checking backup by username:', error);
      return false;
    }
  }

  /**
   * Get backup document by identity ID
   */
  async getBackupByIdentityId(identityId: string): Promise<EncryptedKeyBackupDocument | null> {
    if (!this.isConfigured()) {
      return null;
    }

    try {
      const result = await this.query({
        where: [['$ownerId', '==', identityId]],
        limit: 1
      });

      return result.documents.length > 0 ? result.documents[0] : null;
    } catch (error) {
      logger.error('Error getting backup by identity:', error);
      return null;
    }
  }

  /**
   * Get backup document by username (resolves username first)
   */
  async getBackupByUsername(username: string): Promise<EncryptedKeyBackupDocument | null> {
    if (!this.isConfigured()) {
      return null;
    }

    try {
      const identityId = await dpnsService.resolveIdentity(username);
      if (!identityId) {
        return null;
      }
      return this.getBackupByIdentityId(identityId);
    } catch (error) {
      logger.error('Error getting backup by username:', error);
      return null;
    }
  }

  /**
   * Benchmark the device to determine optimal PBKDF2 iterations
   */
  async benchmarkDevice(targetMs: number = 2000): Promise<BenchmarkResult> {
    return benchmarkPbkdf2(targetMs);
  }

  /**
   * Create encrypted backup on chain
   */
  async createBackup(
    identityId: string,
    privateKeyWif: string,
    password: string,
    iterations: number
  ): Promise<CreateBackupResult> {
    if (!this.isConfigured()) {
      return {
        success: false,
        error: 'Encrypted key backup contract is not configured'
      };
    }

    // Validate password
    const validation = validateBackupPassword(password);
    if (!validation.valid) {
      return {
        success: false,
        error: validation.error
      };
    }

    try {
      // Check if backup already exists
      const existing = await this.getBackupByIdentityId(identityId);
      if (existing) {
        return {
          success: false,
          error: 'A backup already exists for this identity. Delete it first to create a new one.'
        };
      }

      // Encrypt the private key
      const encryptedData = await encryptKeyForOnchain(
        privateKeyWif,
        identityId,
        password,
        iterations
      );

      // Create document on chain
      const result = await stateTransitionService.createDocument(
        this.contractId,
        this.documentType,
        identityId,
        {
          encryptedKey: encryptedData.encryptedKey,
          iv: encryptedData.iv,
          version: encryptedData.version,
          kdfIterations: encryptedData.kdfIterations
        }
      );

      if (!result.success) {
        return {
          success: false,
          error: result.error || 'Failed to create backup document'
        };
      }

      return {
        success: true,
        documentId: result.document?.$id as string | undefined
      };
    } catch (error) {
      logger.error('Error creating backup:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to create backup'
      };
    }
  }

  /**
   * Delete existing backup
   */
  async deleteBackup(identityId: string): Promise<boolean> {
    if (!this.isConfigured()) {
      return false;
    }

    try {
      const backup = await this.getBackupByIdentityId(identityId);
      if (!backup) {
        return true; // Nothing to delete
      }

      return await this.delete(backup.$id, identityId);
    } catch (error) {
      logger.error('Error deleting backup:', error);
      return false;
    }
  }

  /**
   * Login with username + password
   * Resolves username to identity, fetches encrypted backup, decrypts and returns credentials.
   * Supports both v1 (login key only) and v2 (extended with Storacha) formats.
   */
  async loginWithPassword(
    username: string,
    password: string
  ): Promise<LoginWithPasswordResult> {
    if (!this.isConfigured()) {
      throw new Error('Encrypted key backup feature is not configured');
    }

    // Resolve username to identity ID (skip if already an identity ID)
    const normalizedUsername = username.trim();
    const isIdentityId = /^[1-9A-HJ-NP-Za-km-z]{42,46}$/.test(normalizedUsername);
    const identityId = isIdentityId ? normalizedUsername : await dpnsService.resolveIdentity(normalizedUsername);
    if (!identityId) {
      throw new Error('Username not found');
    }

    // Get encrypted backup
    const backup = await this.getBackupByIdentityId(identityId);
    if (!backup) {
      throw new Error('No key backup found for this account');
    }

    // Decrypt the backup (handles both v1 and v2 formats)
    const encryptedData: OnchainEncryptedData = {
      encryptedKey: backup.encryptedKey,
      iv: backup.iv,
      version: backup.version,
      kdfIterations: backup.kdfIterations
    };

    const decrypted = await decryptBackupPayload(encryptedData, identityId, password);

    return {
      identityId,
      privateKey: decrypted.loginKey,
      storachaCredentials: decrypted.storachaCredentials
    };
  }

  /**
   * Verify a password is correct for an existing backup
   */
  async verifyPassword(identityId: string, password: string): Promise<boolean> {
    try {
      const backup = await this.getBackupByIdentityId(identityId);
      if (!backup) {
        return false;
      }

      const encryptedData: OnchainEncryptedData = {
        encryptedKey: backup.encryptedKey,
        iv: backup.iv,
        version: backup.version,
        kdfIterations: backup.kdfIterations
      };

      await decryptKeyFromOnchain(encryptedData, identityId, password);
      return true;
    } catch {
      return false;
    }
  }
}

export const encryptedKeyService = new EncryptedKeyService();
