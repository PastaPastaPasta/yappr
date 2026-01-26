import { BaseDocumentService, QueryOptions } from './document-service'
import { stateTransitionService } from './state-transition-service'
import { identifierToBase58, normalizeSDKResponse, toUint8Array, stringToIdentifierBytes } from './sdk-helpers'
import { getEvoSdk } from './evo-sdk-service'
import { DOCUMENT_TYPES } from '../constants'
import { BloomFilter, BLOOM_FILTER_VERSION } from '../bloom-filter'
import { BlockDocument, BlockFollowData } from '../types'
import {
  loadBlockCache,
  initializeBlockCache,
  addOwnBlock,
  removeOwnBlock,
  isInOwnBlocks,
  getConfirmedBlock,
  addConfirmedBlock,
  addConfirmedBlocksBatch,
  getMergedBloomFilter,
  setMergedBloomFilter,
  getBlockFollowsFromCache,
  setBlockFollows,
  invalidateBlockCache
} from '../caches/block-cache'
import bs58 from 'bs58'

// Max users whose blocks can be followed (100 * 32 bytes = 3200 bytes)
const MAX_BLOCK_FOLLOWS = 100

/**
 * Block Service - Manages enhanced blocking with bloom filters and block following.
 *
 * Features:
 * - Block users with optional public message/reason
 * - Bloom filter for efficient probabilistic block checking
 * - Follow other users' block lists (hard blocks)
 * - SessionStorage caching for page load optimization
 */
class BlockService extends BaseDocumentService<BlockDocument> {
  constructor() {
    super(DOCUMENT_TYPES.BLOCK)
  }

  /**
   * Transform raw block document to typed object.
   * SDK v3: System fields ($id, $ownerId) are base58, byte array fields are base64.
   */
  protected transformDocument(doc: Record<string, unknown>): BlockDocument {
    const data = (doc.data || doc) as Record<string, unknown>
    const rawBlockedId = data.blockedId

    const blockedId = rawBlockedId ? identifierToBase58(rawBlockedId) : ''
    if (rawBlockedId && !blockedId) {
      console.error('BlockService: Invalid blockedId format:', rawBlockedId)
    }

    return {
      $id: (doc.$id || doc.id) as string,
      $ownerId: (doc.$ownerId || doc.ownerId) as string,
      $createdAt: (doc.$createdAt || doc.createdAt) as number,
      blockedId: blockedId || '',
      message: data.message as string | undefined
    }
  }

  // ============================================================
  // BLOCK MANAGEMENT
  // ============================================================

  /**
   * Block a user with optional message.
   *
   * If the blocked user is a private follower of the blocker, their access
   * to the private feed is automatically revoked (per PRD §8.1).
   */
  async blockUser(
    blockerId: string,
    targetUserId: string,
    message?: string
  ): Promise<{ success: boolean; error?: string; autoRevoked?: boolean }> {
    try {
      if (blockerId === targetUserId) {
        return { success: false, error: 'Cannot block yourself' }
      }

      const existing = await this.getBlock(targetUserId, blockerId)
      if (existing) {
        return { success: true }
      }

      const blockedIdBytes = Array.from(bs58.decode(targetUserId))
      const documentData: Record<string, unknown> = { blockedId: blockedIdBytes }
      if (message?.trim()) {
        documentData.message = message.trim().slice(0, 280)
      }

      const result = await stateTransitionService.createDocument(
        this.contractId,
        this.documentType,
        blockerId,
        documentData
      )

      if (result.success) {
        addOwnBlock(blockerId, targetUserId)
        await this.addToBloomFilter(blockerId, targetUserId)

        // Auto-revoke private feed access if target is a private follower (PRD §8.1)
        const autoRevoked = await this.autoRevokePrivateFeedAccess(blockerId, targetUserId)
        if (autoRevoked) {
          return { success: true, autoRevoked: true }
        }
      }

      return result
    } catch (error) {
      console.error('Error blocking user:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to block user'
      }
    }
  }

  /**
   * Check if the target user is a private follower and revoke their access.
   * This is called automatically when blocking a user (PRD §8.1).
   *
   * @returns true if access was revoked, false if not a private follower or revocation failed
   */
  private async autoRevokePrivateFeedAccess(
    blockerId: string,
    targetUserId: string
  ): Promise<boolean> {
    try {
      // Dynamically import to avoid circular dependencies
      const { privateFeedService, privateFeedKeyStore } = await import('./index')

      // Check if blocker has private feed enabled locally
      if (!privateFeedKeyStore.hasFeedSeed()) {
        return false
      }

      // Check if target is a private follower by looking for their grant
      const followers = await privateFeedService.getPrivateFollowers(blockerId)
      const isPrivateFollower = followers.some(f => f.recipientId === targetUserId)

      if (!isPrivateFollower) {
        return false
      }

      // Revoke their access
      console.log(`Auto-revoking private feed access for blocked user: ${targetUserId}`)
      const revokeResult = await privateFeedService.revokeFollower(blockerId, targetUserId)

      if (revokeResult.success) {
        console.log(`Successfully auto-revoked private feed access for: ${targetUserId}`)
        return true
      } else {
        // Log the error but don't fail the block operation
        console.error(`Failed to auto-revoke private feed access: ${revokeResult.error}`)
        return false
      }
    } catch (error) {
      // Auto-revocation failure should not prevent block from succeeding
      console.error('Error during auto-revoke of private feed access:', error)
      return false
    }
  }

  /**
   * Unblock a user.
   */
  async unblockUser(
    blockerId: string,
    targetUserId: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const block = await this.getBlock(targetUserId, blockerId)
      if (!block) {
        removeOwnBlock(blockerId, targetUserId)
        return { success: true }
      }

      const result = await stateTransitionService.deleteDocument(
        this.contractId,
        this.documentType,
        block.$id,
        blockerId
      )

      if (result.success) {
        removeOwnBlock(blockerId, targetUserId)
        // Note: Bloom filter is add-only. False positives may occur until rebuilt.
      }

      return result
    } catch (error) {
      console.error('Error unblocking user:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to unblock user'
      }
    }
  }

  /**
   * Get a specific block document.
   */
  async getBlock(targetUserId: string, blockerId: string): Promise<BlockDocument | null> {
    try {
      const sdk = await getEvoSdk()

      const response = await sdk.documents.query({
        dataContractId: this.contractId,
        documentTypeName: this.documentType,
        where: [
          ['$ownerId', '==', blockerId],
          ['blockedId', '==', stringToIdentifierBytes(targetUserId)]
        ],
        limit: 1
      })

      const documents = normalizeSDKResponse(response)
      return documents.length > 0 ? this.transformDocument(documents[0]) : null
    } catch (error) {
      console.error('Error getting block:', error)
      return null
    }
  }

  /**
   * Get all blocks by a user.
   */
  async getUserBlocks(userId: string, options: QueryOptions = {}): Promise<BlockDocument[]> {
    try {
      const result = await this.query({
        where: [['$ownerId', '==', userId]],
        limit: 100,
        ...options
      })
      return result.documents
    } catch (error) {
      console.error('Error getting user blocks:', error)
      return []
    }
  }

  // ============================================================
  // BLOOM FILTER MANAGEMENT
  // ============================================================

  /**
   * Get the bloom filter for a user.
   */
  async getBloomFilter(userId: string): Promise<{ filter: BloomFilter; documentId: string; revision: number } | null> {
    try {
      const sdk = await getEvoSdk()
      const response = await sdk.documents.query({
        dataContractId: this.contractId,
        documentTypeName: DOCUMENT_TYPES.BLOCK_FILTER,
        where: [['$ownerId', '==', userId]],
        limit: 1
      })

      const documents = normalizeSDKResponse(response)
      if (documents.length === 0) return null

      const doc = documents[0]
      const data = (doc.data || doc) as Record<string, unknown>
      const bytes = toUint8Array(data.filterData)
      if (!bytes) {
        console.error('Unknown filterData format:', typeof data.filterData)
        return null
      }

      return {
        filter: new BloomFilter(bytes, (data.itemCount as number) || 0),
        documentId: (doc.$id || doc.id) as string,
        revision: ((doc.$revision || doc.revision || 0) as number)
      }
    } catch (error) {
      console.error('Error getting bloom filter:', error)
      return null
    }
  }

  /**
   * Get bloom filters for multiple users in batch.
   *
   * TODO: This query uses 'in' clause which doesn't support reliable pagination.
   * The SDK returns incomplete results when subtrees are empty but still count against the limit.
   * Once SDK provides better 'in' query support (e.g., a flag indicating result completeness),
   * implement pagination here to handle cases where results exceed the limit.
   */
  async getBloomFiltersBatch(userIds: string[]): Promise<Map<string, BloomFilter>> {
    const result = new Map<string, BloomFilter>()
    if (userIds.length === 0) return result

    try {
      const sdk = await getEvoSdk()
      const response = await sdk.documents.query({
        dataContractId: this.contractId,
        documentTypeName: DOCUMENT_TYPES.BLOCK_FILTER,
        where: [['$ownerId', 'in', userIds]],
        orderBy: [['$ownerId', 'asc']],
        limit: Math.min(userIds.length, 100)
      })

      const documents = normalizeSDKResponse(response)

      for (const doc of documents) {
        const data = (doc.data || doc) as Record<string, unknown>
        const ownerId = (doc.$ownerId || doc.ownerId) as string
        const bytes = toUint8Array(data.filterData)
        if (!bytes) continue

        result.set(ownerId, new BloomFilter(bytes, (data.itemCount as number) || 0))
      }
    } catch (error) {
      console.error('Error getting bloom filters batch:', error)
    }

    return result
  }

  /**
   * Add a blocked user ID to the bloom filter.
   * Creates the filter document if it doesn't exist.
   */
  async addToBloomFilter(userId: string, blockedId: string): Promise<void> {
    try {
      const existing = await this.getBloomFilter(userId)

      if (existing) {
        // Add to existing filter
        existing.filter.add(blockedId)

        await stateTransitionService.updateDocument(
          this.contractId,
          DOCUMENT_TYPES.BLOCK_FILTER,
          existing.documentId,
          userId,
          {
            filterData: Array.from(existing.filter.serialize()),
            itemCount: existing.filter.itemCount,
            version: BLOOM_FILTER_VERSION
          },
          existing.revision
        )
      } else {
        // Create new filter
        const filter = new BloomFilter()
        filter.add(blockedId)

        await stateTransitionService.createDocument(
          this.contractId,
          DOCUMENT_TYPES.BLOCK_FILTER,
          userId,
          {
            filterData: Array.from(filter.serialize()),
            itemCount: filter.itemCount,
            version: BLOOM_FILTER_VERSION
          }
        )
      }
    } catch (error) {
      console.error('Error adding to bloom filter:', error)
      // Non-fatal - block still succeeded
    }
  }

  // ============================================================
  // BLOCK FOLLOW MANAGEMENT
  // ============================================================

  /**
   * Get the block follow document for a user.
   */
  async getBlockFollow(userId: string): Promise<BlockFollowData | null> {
    try {
      const sdk = await getEvoSdk()
      const response = await sdk.documents.query({
        dataContractId: this.contractId,
        documentTypeName: DOCUMENT_TYPES.BLOCK_FOLLOW,
        where: [['$ownerId', '==', userId]],
        limit: 1
      })

      const documents = normalizeSDKResponse(response)
      if (documents.length === 0) return null

      const doc = documents[0]
      const data = (doc.data || doc) as Record<string, unknown>
      const followedUserIds = this.decodeUserIdArray(data.followedBlockers)

      return {
        $id: (doc.$id || doc.id) as string,
        $ownerId: (doc.$ownerId || doc.ownerId) as string,
        $revision: (doc.$revision || doc.revision) as number | undefined,
        followedUserIds
      }
    } catch (error) {
      console.error('Error getting block follow:', error)
      return null
    }
  }

  /**
   * Decode a byte array into an array of base58 user IDs.
   * Each user ID is 32 bytes.
   */
  private decodeUserIdArray(data: unknown): string[] {
    const bytes = toUint8Array(data)
    if (!bytes) return []

    const userIds: string[] = []
    for (let i = 0; i + 32 <= bytes.length; i += 32) {
      userIds.push(bs58.encode(bytes.slice(i, i + 32)))
    }
    return userIds
  }

  /**
   * Encode an array of base58 user IDs into a byte array.
   */
  private encodeUserIdArray(userIds: string[]): number[] {
    const result: number[] = []
    for (const userId of userIds) {
      const bytes = bs58.decode(userId)
      result.push(...Array.from(bytes))
    }
    return result
  }

  /**
   * Follow another user's block list.
   */
  async followUserBlocks(
    userId: string,
    targetUserId: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      if (userId === targetUserId) {
        return { success: false, error: 'Cannot follow your own blocks' }
      }

      const existing = await this.getBlockFollow(userId)

      if (existing) {
        // Check if already following
        if (existing.followedUserIds.includes(targetUserId)) {
          return { success: true }
        }

        // Check capacity
        if (existing.followedUserIds.length >= MAX_BLOCK_FOLLOWS) {
          return { success: false, error: `Maximum ${MAX_BLOCK_FOLLOWS} block follows reached` }
        }

        // Add to existing list
        const newList = [...existing.followedUserIds, targetUserId]
        const result = await stateTransitionService.updateDocument(
          this.contractId,
          DOCUMENT_TYPES.BLOCK_FOLLOW,
          existing.$id,
          userId,
          { followedBlockers: this.encodeUserIdArray(newList) },
          existing.$revision || 0
        )

        if (result.success) {
          setBlockFollows(userId, newList)
          // Invalidate merged filter cache
          invalidateBlockCache(userId)
        }

        return result
      } else {
        // Create new block follow document
        const result = await stateTransitionService.createDocument(
          this.contractId,
          DOCUMENT_TYPES.BLOCK_FOLLOW,
          userId,
          { followedBlockers: this.encodeUserIdArray([targetUserId]) }
        )

        if (result.success) {
          setBlockFollows(userId, [targetUserId])
          invalidateBlockCache(userId)
        }

        return result
      }
    } catch (error) {
      console.error('Error following user blocks:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to follow blocks'
      }
    }
  }

  /**
   * Unfollow a user's block list.
   */
  async unfollowUserBlocks(
    userId: string,
    targetUserId: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const existing = await this.getBlockFollow(userId)
      if (!existing) {
        return { success: true }
      }

      const newList = existing.followedUserIds.filter(id => id !== targetUserId)

      if (newList.length === existing.followedUserIds.length) {
        // Not following this user
        return { success: true }
      }

      if (newList.length === 0) {
        // Delete the document if empty
        const result = await stateTransitionService.deleteDocument(
          this.contractId,
          DOCUMENT_TYPES.BLOCK_FOLLOW,
          existing.$id,
          userId
        )

        if (result.success) {
          setBlockFollows(userId, [])
          invalidateBlockCache(userId)
        }

        return result
      } else {
        // Update with reduced list
        const result = await stateTransitionService.updateDocument(
          this.contractId,
          DOCUMENT_TYPES.BLOCK_FOLLOW,
          existing.$id,
          userId,
          { followedBlockers: this.encodeUserIdArray(newList) },
          existing.$revision || 0
        )

        if (result.success) {
          setBlockFollows(userId, newList)
          invalidateBlockCache(userId)
        }

        return result
      }
    } catch (error) {
      console.error('Error unfollowing user blocks:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to unfollow blocks'
      }
    }
  }

  /**
   * Get list of users whose blocks are being followed.
   */
  async getBlockFollows(userId: string): Promise<string[]> {
    // Check cache first
    const cached = getBlockFollowsFromCache(userId)
    if (cached.length > 0) {
      return cached
    }

    const data = await this.getBlockFollow(userId)
    if (data) {
      setBlockFollows(userId, data.followedUserIds)
      return data.followedUserIds
    }
    return []
  }

  // ============================================================
  // UNIFIED BLOCK CHECKING
  // ============================================================

  /**
   * Check if a target user is blocked by the viewer (own blocks + inherited blocks).
   */
  async isBlocked(targetUserId: string, viewerId: string): Promise<boolean> {
    if (!viewerId || !targetUserId) return false

    // Fast path: check sessionStorage caches first
    if (isInOwnBlocks(viewerId, targetUserId)) {
      return true
    }

    const confirmed = getConfirmedBlock(viewerId, targetUserId)
    if (confirmed !== undefined) {
      return confirmed.isBlocked
    }

    // Check merged bloom filter for quick negative
    const mergedFilter = getMergedBloomFilter(viewerId)
    if (mergedFilter && !mergedFilter.mightContain(targetUserId)) {
      return false
    }

    // Bloom filter positive or no filter - verify against platform
    const ownBlock = await this.getBlock(targetUserId, viewerId)
    if (ownBlock) {
      addConfirmedBlock(viewerId, targetUserId, viewerId, true, ownBlock.message)
      return true
    }

    // Check inherited blocks from followed users
    const followedBlockers = await this.getBlockFollows(viewerId)
    if (followedBlockers.length > 0) {
      const inheritedBlock = await this.checkInheritedBlocks(targetUserId, followedBlockers)
      if (inheritedBlock) {
        addConfirmedBlock(viewerId, targetUserId, inheritedBlock.blockedBy, true, inheritedBlock.message)
        return true
      }
    }

    addConfirmedBlock(viewerId, targetUserId, '', false)
    return false
  }

  /**
   * Check if target is blocked by any of the followed blockers.
   * Note: Must query each blocker individually since the index only supports
   * queries on ($ownerId, blockedId) with equality on both.
   */
  private async checkInheritedBlocks(
    targetUserId: string,
    followedBlockers: string[]
  ): Promise<{ blockedBy: string; message?: string } | null> {
    if (followedBlockers.length === 0) return null

    try {
      // Query each blocker individually in parallel
      const queries = followedBlockers.map(async (blockerId) => {
        try {
          const block = await this.getBlock(targetUserId, blockerId)
          if (block) {
            return {
              blockedBy: blockerId,
              message: block.message
            }
          }
        } catch (err) {
          console.error(`Error checking block from ${blockerId}:`, err)
        }
        return null
      })

      const results = await Promise.all(queries)

      // Return first found block
      for (const result of results) {
        if (result) return result
      }
    } catch (error) {
      console.error('Error checking inherited blocks:', error)
    }

    return null
  }

  /**
   * Batch check if any targets are blocked (own + inherited).
   */
  async checkBlockedBatch(
    viewerId: string,
    targetIds: string[]
  ): Promise<Map<string, boolean>> {
    const result = new Map<string, boolean>()

    if (!viewerId || targetIds.length === 0) {
      return result
    }

    const uniqueTargetIds = Array.from(new Set(targetIds))
    const unchecked: string[] = []

    // Phase 1: Check sessionStorage caches
    for (const targetId of uniqueTargetIds) {
      if (isInOwnBlocks(viewerId, targetId)) {
        result.set(targetId, true)
        continue
      }

      const confirmed = getConfirmedBlock(viewerId, targetId)
      if (confirmed !== undefined) {
        result.set(targetId, confirmed.isBlocked)
        continue
      }

      unchecked.push(targetId)
    }

    if (unchecked.length === 0) {
      return result
    }

    // Phase 2: Check bloom filter for remaining
    const mergedFilter = getMergedBloomFilter(viewerId)
    const possiblePositives: string[] = []
    const definiteNegatives: string[] = []

    for (const targetId of unchecked) {
      if (mergedFilter && !mergedFilter.mightContain(targetId)) {
        definiteNegatives.push(targetId)
        result.set(targetId, false)
      } else {
        possiblePositives.push(targetId)
      }
    }

    // Cache definite negatives
    if (definiteNegatives.length > 0) {
      const batchResults = new Map<string, { blockedBy: string; isBlocked: boolean }>()
      for (const targetId of definiteNegatives) {
        batchResults.set(targetId, { blockedBy: '', isBlocked: false })
      }
      addConfirmedBlocksBatch(viewerId, batchResults)
    }

    if (possiblePositives.length === 0) {
      return result
    }

    // Phase 3: Verify possible positives
    try {
      // Query own blocks
      const ownBlocks = await this.queryBlockedIn(viewerId, possiblePositives)
      const ownBlockedSet = new Set(ownBlocks.map(b => b.blockedId))

      const batchResults = new Map<string, { blockedBy: string; isBlocked: boolean; message?: string }>()

      for (const targetId of possiblePositives) {
        if (ownBlockedSet.has(targetId)) {
          result.set(targetId, true)
          const block = ownBlocks.find(b => b.blockedId === targetId)
          batchResults.set(targetId, { blockedBy: viewerId, isBlocked: true, message: block?.message })
        }
      }

      // Check inherited blocks for remaining
      const stillUnchecked = possiblePositives.filter(id => !ownBlockedSet.has(id))

      if (stillUnchecked.length > 0) {
        const followedBlockers = await this.getBlockFollows(viewerId)

        if (followedBlockers.length > 0) {
          const inheritedBlocks = await this.queryInheritedBlocksBatch(stillUnchecked, followedBlockers)

          for (const targetId of stillUnchecked) {
            const inherited = inheritedBlocks.get(targetId)
            if (inherited) {
              result.set(targetId, true)
              batchResults.set(targetId, { blockedBy: inherited.blockedBy, isBlocked: true, message: inherited.message })
            } else {
              result.set(targetId, false)
              batchResults.set(targetId, { blockedBy: '', isBlocked: false })
            }
          }
        } else {
          // No inherited blocks possible
          for (const targetId of stillUnchecked) {
            result.set(targetId, false)
            batchResults.set(targetId, { blockedBy: '', isBlocked: false })
          }
        }
      }

      addConfirmedBlocksBatch(viewerId, batchResults)
    } catch (error) {
      console.error('Error in batch block check:', error)
      // On error, assume not blocked for unchecked
      for (const targetId of possiblePositives) {
        if (!result.has(targetId)) {
          result.set(targetId, false)
        }
      }
    }

    return result
  }

  /**
   * Query blocks using 'in' operator for efficient batch lookup.
   *
   * TODO: This query uses 'in' clause which doesn't support reliable pagination.
   * The SDK returns incomplete results when subtrees are empty but still count against the limit.
   * Once SDK provides better 'in' query support (e.g., a flag indicating result completeness),
   * implement pagination here to handle cases where results exceed the limit.
   */
  private async queryBlockedIn(blockerId: string, targetIds: string[]): Promise<BlockDocument[]> {
    if (targetIds.length === 0) return []

    const sdk = await getEvoSdk()
    const response = await sdk.documents.query({
      dataContractId: this.contractId,
      documentTypeName: this.documentType,
      where: [
        ['$ownerId', '==', blockerId],
        ['blockedId', 'in', targetIds]
      ],
      orderBy: [['blockedId', 'asc']],
      limit: Math.min(targetIds.length, 100)
    })

    return normalizeSDKResponse(response).map(doc => this.transformDocument(doc))
  }

  /**
   * Query inherited blocks for multiple targets from multiple blockers.
   * Queries each blocker in parallel since Platform only supports one 'in' clause per query.
   *
   * TODO: This query uses 'in' clause which doesn't support reliable pagination.
   * The SDK returns incomplete results when subtrees are empty but still count against the limit.
   * Once SDK provides better 'in' query support (e.g., a flag indicating result completeness),
   * implement pagination here to handle cases where results exceed the limit.
   */
  private async queryInheritedBlocksBatch(
    targetIds: string[],
    followedBlockers: string[]
  ): Promise<Map<string, { blockedBy: string; message?: string }>> {
    const result = new Map<string, { blockedBy: string; message?: string }>()
    if (targetIds.length === 0 || followedBlockers.length === 0) return result

    try {
      const sdk = await getEvoSdk()

      const queries = followedBlockers.map(async (blockerId) => {
        try {
          const response = await sdk.documents.query({
            dataContractId: this.contractId,
            documentTypeName: this.documentType,
            where: [
              ['$ownerId', '==', blockerId],
              ['blockedId', 'in', targetIds]
            ],
            orderBy: [['blockedId', 'asc']],
            limit: Math.min(targetIds.length, 100)
          })
          return normalizeSDKResponse(response)
        } catch (err) {
          console.error(`Error querying blocks for blocker ${blockerId}:`, err)
          return []
        }
      })

      const allResults = await Promise.all(queries)

      for (const documents of allResults) {
        for (const doc of documents) {
          const transformed = this.transformDocument(doc)
          if (!result.has(transformed.blockedId)) {
            result.set(transformed.blockedId, {
              blockedBy: transformed.$ownerId,
              message: transformed.message
            })
          }
        }
      }
    } catch (error) {
      console.error('Error querying inherited blocks batch:', error)
    }

    return result
  }

  // ============================================================
  // INITIALIZATION
  // ============================================================

  /**
   * Initialize block data on page load.
   * Queries all necessary data and populates sessionStorage cache.
   */
  async initializeBlockData(userId: string): Promise<void> {
    // Check if cache already exists and is fresh
    const existingCache = loadBlockCache(userId)
    if (existingCache) {
      return // Cache is fresh, skip initialization
    }

    try {
      // Query all data in parallel
      const [blockFollowData, ownBlocks] = await Promise.all([
        this.getBlockFollow(userId),
        this.getUserBlocks(userId)
      ])

      const followedUserIds = blockFollowData?.followedUserIds ?? []
      const ownBlockedIds = ownBlocks.map(b => b.blockedId)

      // Get bloom filters for self and followed users
      const filterUserIds = [userId, ...followedUserIds]
      const filters = await this.getBloomFiltersBatch(filterUserIds)

      // Merge all bloom filters
      const mergedFilter = filters.size > 0 ? BloomFilter.merge(Array.from(filters.values())) : null

      // Initialize cache with all data
      initializeBlockCache(
        userId,
        ownBlockedIds,
        followedUserIds,
        mergedFilter,
        filterUserIds
      )

      // Store merged filter in sessionStorage
      if (mergedFilter) {
        setMergedBloomFilter(userId, mergedFilter, filterUserIds)
      }
    } catch (error) {
      console.error('Error initializing block data:', error)
    }
  }

  /**
   * Count blocked users.
   */
  async countUserBlocks(userId: string): Promise<number> {
    const blocks = await this.getUserBlocks(userId)
    return blocks.length
  }
}

// Singleton instance
export const blockService = new BlockService()
