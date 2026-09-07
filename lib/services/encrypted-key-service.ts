import { logger } from '@/lib/logger';
import { BaseDocumentService } from './document-service';
import { dpnsService } from './dpns-service';
import { ENCRYPTED_KEY_BACKUP_CONTRACT_ID, DOCUMENT_TYPES } from '../constants';
import {
  decryptBackupPayload,
  OnchainEncryptedData,
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

}

export const encryptedKeyService = new EncryptedKeyService();
