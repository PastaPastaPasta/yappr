import { getEvoSdk } from './evo-sdk-service'
import { stateTransitionService } from './state-transition-service'
import { queryDocuments, identifierToBase58 } from './sdk-helpers'
import {
  YAPPR_CONTRACT_ID,
  YAPPR_PROFILE_CONTRACT_ID,
  YAPPR_DM_CONTRACT_ID,
  YAPPR_BLOCK_CONTRACT_ID,
  ENCRYPTED_KEY_BACKUP_CONTRACT_ID,
  HASHTAG_CONTRACT_ID
} from '../constants'

/**
 * Registry entry for a contract and its deletable document types
 */
interface DeletionRegistry {
  contractId: string
  documentTypes: string[]
  serviceName: string
}

/**
 * Information about a document to be deleted
 */
interface DocumentInfo {
  $id: string
  $ownerId: string
  documentType: string
  contractId: string
}

/**
 * Progress update during deletion
 */
export interface DeletionProgress {
  phase: 'counting' | 'deleting' | 'cleanup' | 'complete' | 'failed'
  currentContract: string
  currentDocumentType: string
  totalDocuments: number
  processedDocuments: number
  deletedDocuments: number
  failedDocuments: number
  errors: Array<{
    contractId: string
    documentType: string
    documentId: string
    error: string
  }>
}

/**
 * Result of account deletion
 */
export interface DeletionResult {
  success: boolean
  totalDeleted: number
  totalFailed: number
  errors: DeletionProgress['errors']
  partialFailure: boolean
}

/**
 * Document counts by type for display
 */
export interface DocumentCounts {
  [documentType: string]: number
}

/**
 * Account Deletion Service
 *
 * Handles comprehensive deletion of all user documents across all Yappr contracts.
 * Uses a registry-based architecture for easy extensibility when new document types are added.
 */
class AccountDeletionService {
  /**
   * Registry of all contracts and document types that should be deleted.
   *
   * IMPORTANT: When adding new document types to Yappr, add them here to ensure
   * they are deleted during account deletion.
   */
  private readonly registry: DeletionRegistry[] = [
    // Main Yappr contract - social features
    {
      contractId: YAPPR_CONTRACT_ID,
      documentTypes: [
        'post',           // User's posts
        'like',           // User's likes
        'repost',         // User's reposts
        'follow',         // Users this user follows
        'bookmark',       // User's bookmarks
        'list',           // User's custom lists
        'listMember',     // Members in user's lists
        'notification',   // User's notifications
        'profile',        // User's profile (old contract)
        'avatar',         // User's avatar
      ],
      serviceName: 'Main Social'
    },
    // Unified profile contract
    {
      contractId: YAPPR_PROFILE_CONTRACT_ID,
      documentTypes: ['profile'],
      serviceName: 'Profile'
    },
    // Direct messages contract
    {
      contractId: YAPPR_DM_CONTRACT_ID,
      documentTypes: ['directMessage'],
      serviceName: 'Direct Messages'
    },
    // Block/mute contract
    {
      contractId: YAPPR_BLOCK_CONTRACT_ID,
      documentTypes: [
        'block',          // Blocked users
        'blockFilter',    // Bloom filter for blocks
        'blockFollow',    // Block follows
        'mute',           // Muted users
      ],
      serviceName: 'Block System'
    },
    // Encrypted key backup contract
    {
      contractId: ENCRYPTED_KEY_BACKUP_CONTRACT_ID,
      documentTypes: ['encryptedKeyBackup'],
      serviceName: 'Key Backup'
    },
    // Hashtag tracking contract
    {
      contractId: HASHTAG_CONTRACT_ID,
      documentTypes: ['postHashtag'],
      serviceName: 'Hashtags'
    }
  ]

  /**
   * Batch size for concurrent deletions within a document type
   */
  private readonly BATCH_SIZE = 3

  /**
   * Delay between batches to avoid rate limiting (ms)
   */
  private readonly BATCH_DELAY_MS = 500

  /**
   * Maximum documents to query per request (Platform limit)
   */
  private readonly QUERY_LIMIT = 100

  /**
   * Count all user documents across all contracts
   */
  async countUserDocuments(userId: string): Promise<DocumentCounts> {
    const counts: DocumentCounts = {}

    for (const entry of this.registry) {
      for (const documentType of entry.documentTypes) {
        try {
          const documents = await this.queryUserDocuments(
            entry.contractId,
            documentType,
            userId
          )
          if (documents.length > 0) {
            counts[documentType] = documents.length
          }
        } catch (error) {
          // Log but continue - some document types may not exist for this user
          console.warn(`Failed to count ${documentType}:`, error)
        }
      }
    }

    return counts
  }

  /**
   * Query all documents owned by a user for a specific type
   * Handles pagination for users with many documents
   * Uses queryDocuments from sdk-helpers for proper error handling
   */
  private async queryUserDocuments(
    contractId: string,
    documentType: string,
    userId: string
  ): Promise<DocumentInfo[]> {
    const sdk = await getEvoSdk()
    const allDocuments: DocumentInfo[] = []
    let startAfter: string | undefined = undefined

    // Paginate through all documents
    while (true) {
      try {
        const documents = await queryDocuments(sdk, {
          dataContractId: contractId,
          documentTypeName: documentType,
          where: [['$ownerId', '==', userId]],
          orderBy: [['$createdAt', 'asc']],
          limit: this.QUERY_LIMIT,
          startAfter
        })

        if (documents.length === 0) {
          break
        }

        // Add documents with metadata
        for (const doc of documents) {
          const docId = identifierToBase58(doc.$id) || (doc.$id as string) || (doc.id as string)
          const ownerId = identifierToBase58(doc.$ownerId) || (doc.$ownerId as string) || (doc.ownerId as string) || userId

          allDocuments.push({
            $id: docId,
            $ownerId: ownerId,
            documentType,
            contractId
          })
        }

        // Check if we need to paginate
        if (documents.length < this.QUERY_LIMIT) {
          break
        }

        // Use last document ID for pagination
        const lastDoc = documents[documents.length - 1]
        startAfter = identifierToBase58(lastDoc.$id) || (lastDoc.$id as string) || (lastDoc.id as string)
      } catch (error) {
        // Some document types may fail to query (e.g., not registered)
        console.warn(`Query failed for ${documentType} in contract ${contractId}:`, error)
        break
      }
    }

    return allDocuments
  }

  /**
   * Delete all user documents with progress callback
   */
  async deleteAllUserDocuments(
    userId: string,
    onProgress: (progress: DeletionProgress) => void
  ): Promise<DeletionResult> {
    const progress: DeletionProgress = {
      phase: 'counting',
      currentContract: '',
      currentDocumentType: '',
      totalDocuments: 0,
      processedDocuments: 0,
      deletedDocuments: 0,
      failedDocuments: 0,
      errors: []
    }

    // First, collect all documents to delete
    const allDocuments: DocumentInfo[] = []

    for (const entry of this.registry) {
      progress.currentContract = entry.serviceName

      for (const documentType of entry.documentTypes) {
        progress.currentDocumentType = documentType
        onProgress({ ...progress })

        try {
          const documents = await this.queryUserDocuments(
            entry.contractId,
            documentType,
            userId
          )
          allDocuments.push(...documents)
          progress.totalDocuments = allDocuments.length
          onProgress({ ...progress })
        } catch (error) {
          console.warn(`Failed to query ${documentType}:`, error)
        }
      }
    }

    // Now delete all documents
    progress.phase = 'deleting'
    onProgress({ ...progress })

    // Process deletions in batches
    for (let i = 0; i < allDocuments.length; i += this.BATCH_SIZE) {
      const batch = allDocuments.slice(i, i + this.BATCH_SIZE)

      // Update progress with current document type being processed
      if (batch.length > 0) {
        progress.currentDocumentType = batch[0].documentType
        progress.currentContract = this.getServiceName(batch[0].contractId)
      }
      onProgress({ ...progress })

      // Process batch concurrently
      const results = await Promise.allSettled(
        batch.map(doc => this.deleteDocument(doc))
      )

      // Update progress based on results
      for (let j = 0; j < results.length; j++) {
        progress.processedDocuments++
        const result = results[j]

        if (result.status === 'fulfilled' && result.value.success) {
          progress.deletedDocuments++
        } else {
          progress.failedDocuments++
          progress.errors.push({
            contractId: batch[j].contractId,
            documentType: batch[j].documentType,
            documentId: batch[j].$id,
            error: result.status === 'rejected'
              ? result.reason?.message || 'Unknown error'
              : (result.value as { error?: string }).error || 'Delete failed'
          })
        }

        onProgress({ ...progress })
      }

      // Add delay between batches to avoid rate limiting
      if (i + this.BATCH_SIZE < allDocuments.length) {
        await this.delay(this.BATCH_DELAY_MS)
      }
    }

    // Determine final status
    const totalFailed = progress.failedDocuments
    const totalDeleted = progress.deletedDocuments

    progress.phase = totalFailed === 0 ? 'complete' : 'failed'
    onProgress({ ...progress })

    return {
      success: totalFailed === 0,
      totalDeleted,
      totalFailed,
      errors: progress.errors,
      partialFailure: totalFailed > 0 && totalDeleted > 0
    }
  }

  /**
   * Delete a single document
   */
  private async deleteDocument(doc: DocumentInfo): Promise<{ success: boolean; error?: string }> {
    try {
      const result = await stateTransitionService.deleteDocument(
        doc.contractId,
        doc.documentType,
        doc.$id,
        doc.$ownerId
      )
      return { success: result.success, error: result.error }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  }

  /**
   * Clear all local storage related to the user session
   */
  async clearLocalStorage(userId: string): Promise<void> {
    // Clear session storage items
    if (typeof window !== 'undefined') {
      localStorage.removeItem('yappr_session')
      sessionStorage.removeItem('yappr_dpns_username')
      sessionStorage.removeItem('yappr_skip_dpns')
      sessionStorage.removeItem('yappr_backup_prompt_shown')

      // Clear private key from secure storage
      const { clearPrivateKey } = await import('../secure-storage')
      clearPrivateKey(userId)

      // Clear password-encrypted credentials for this user
      const { removeStoredCredential } = await import('../password-encrypted-storage')
      removeStoredCredential(userId)

      // Clear block cache
      const { invalidateBlockCache } = await import('../caches/block-cache')
      invalidateBlockCache(userId)

      // Clear DashPlatformClient identity
      const { getDashPlatformClient } = await import('../dash-platform-client')
      const dashClient = getDashPlatformClient()
      dashClient.setIdentity('')
    }
  }

  /**
   * Full account deletion orchestration
   */
  async deleteAccount(
    userId: string,
    onProgress: (progress: DeletionProgress) => void
  ): Promise<DeletionResult> {
    // Delete all documents
    const result = await this.deleteAllUserDocuments(userId, onProgress)

    // If deletion was successful or partially successful, clear local storage
    if (result.totalDeleted > 0 || result.totalFailed === 0) {
      const progress: DeletionProgress = {
        phase: 'cleanup',
        currentContract: '',
        currentDocumentType: 'Local Storage',
        totalDocuments: result.totalDeleted + result.totalFailed,
        processedDocuments: result.totalDeleted + result.totalFailed,
        deletedDocuments: result.totalDeleted,
        failedDocuments: result.totalFailed,
        errors: result.errors
      }
      onProgress(progress)

      await this.clearLocalStorage(userId)
    }

    return result
  }

  /**
   * Get service name for a contract ID
   */
  private getServiceName(contractId: string): string {
    const entry = this.registry.find(e => e.contractId === contractId)
    return entry?.serviceName || 'Unknown'
  }

  /**
   * Helper to delay execution
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  /**
   * Get all document types that will be deleted
   * Useful for displaying to the user what will be affected
   */
  getAffectedDocumentTypes(): string[] {
    const types: string[] = []
    for (const entry of this.registry) {
      types.push(...entry.documentTypes)
    }
    return Array.from(new Set(types)) // Remove duplicates
  }

  /**
   * Get human-readable descriptions of what will be deleted
   */
  getDeletionSummary(): Array<{ category: string; items: string[] }> {
    return [
      {
        category: 'Social Content',
        items: ['All your posts', 'All your replies', 'All your reposts/quotes']
      },
      {
        category: 'Interactions',
        items: ['All your likes', 'All your bookmarks', 'All users you follow']
      },
      {
        category: 'Profile Data',
        items: ['Your profile information', 'Your avatar', 'Your display name and bio']
      },
      {
        category: 'Private Data',
        items: ['All your direct messages', 'Your block and mute lists']
      },
      {
        category: 'Other Data',
        items: ['Your custom lists', 'Notification history', 'Encrypted key backups']
      }
    ]
  }
}

// Export singleton instance
export const accountDeletionService = new AccountDeletionService()
