import { logger } from '@/lib/logger';
import { BaseDocumentService, QueryOptions } from './document-service'
import { stateTransitionService } from './state-transition-service'
import { identifierStringToDocumentBytes, identifierToBase58, normalizeSDKResponse, normalizeBytes, RequestDeduplicator } from './sdk-helpers'
import { getEvoSdk } from './evo-sdk-service'
import { DOCUMENT_TYPES } from '../constants'
import { blockFollowsAreTyped } from '../contract-topology'
import { decodeBlockFollowIds, encodeBlockFollowIds } from '../typed-array-codecs'
import { BloomFilter, BLOOM_FILTER_VERSION } from '../bloom-filter'
import { BlockDocument, BlockFollowData } from '../types'
import {
  loadBlockCache,
  initializeBlockCache,
  addOwnBlock,
  removeOwnBlock,
  getOwnBlocksFromCache,
  setOwnBlocks,
  getConfirmedBlock,
  addConfirmedBlocksBatch,
  getMergedBloomFilter,
  setMergedBloomFilter,
  getBlockFollowsFromCache,
  setBlockFollows,
  invalidateBlockCache
} from '../caches/block-cache'

// Max users whose blocks can be followed (100 * 32 bytes = 3200 bytes)
const MAX_BLOCK_FOLLOWS = 100

/** A followed blocker's block on a target, as found by an inherited-block query. */
interface InheritedBlock {
  blockedBy: string
  message?: string
}

/** Whether a blocked target is blocked by the viewer's own block or only by a followed list. */
export type BlockSource = 'own' | 'inherited'

/** Why a target is blocked for a viewer; own and inherited can both hold. */
export interface BlockProvenance {
  isBlocked: boolean
  /** The viewer's own block document exists. */
  isOwnBlock: boolean
  /** A followed blocker whose list blocks the target, if any. */
  inheritedFrom: string | null
}

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
  private ownBlocksInFlight = new RequestDeduplicator<string, string[]>(0)
  private ownBlockVersions = new Map<string, number>()

  private updateOwnBlock(userId: string, targetId: string, blocked: boolean): void {
    this.ownBlockVersions.set(userId, (this.ownBlockVersions.get(userId) ?? 0) + 1)
    if (blocked) addOwnBlock(userId, targetId)
    else removeOwnBlock(userId, targetId)
  }

  /** Share the complete owner list across auth, cards and feed enrichment. */
  private async getOwnBlockedIds(userId: string): Promise<string[]> {
    const cached = getOwnBlocksFromCache(userId)
    if (cached !== null) return cached

    return this.ownBlocksInFlight.dedupe(userId, async () => {
      const blockedIds: string[] = []
      let startAfter: string | undefined
      let version = this.ownBlockVersions.get(userId)
      while (true) {
        // Use the ownerAndBlocked index; never treat a capped page as a full list.
        const { documents } = await this.query({
          where: [['$ownerId', '==', userId]],
          orderBy: [['$ownerId', 'asc'], ['blockedId', 'asc']],
          limit: 100,
          startAfter,
        })
        // A local block/unblock completed while this snapshot was loading.
        // Restart the shared read so an older result cannot undo that mutation.
        if (version !== this.ownBlockVersions.get(userId)) {
          version = this.ownBlockVersions.get(userId)
          blockedIds.length = 0
          startAfter = undefined
          continue
        }
        blockedIds.push(...documents.map(block => block.blockedId))
        if (documents.length < 100) break
        const nextCursor = documents[documents.length - 1].$id
        if (!nextCursor || nextCursor === startAfter) throw new Error('Block list cursor did not advance')
        startAfter = nextCursor
      }
      setOwnBlocks(userId, blockedIds)
      return blockedIds
    })
  }

  constructor() {
    super(DOCUMENT_TYPES.BLOCK)
  }

  /**
   * Transform raw block document to typed object.
   * System identifier fields arrive as base58, while identifier-like document fields may
   * arrive as base64 or raw bytes in query results.
   */
  protected transformDocument(doc: Record<string, unknown>): BlockDocument {
    const data = (doc.data || doc) as Record<string, unknown>
    const rawBlockedId = data.blockedId

    const blockedId = rawBlockedId ? identifierToBase58(rawBlockedId) : ''
    if (rawBlockedId && !blockedId) {
      logger.error('BlockService: Invalid blockedId format:', rawBlockedId)
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

      const documentData: Record<string, unknown> = {
        blockedId: identifierStringToDocumentBytes(targetUserId),
      }
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
        this.updateOwnBlock(blockerId, targetUserId, true)
        await this.addToBloomFilter(blockerId, targetUserId)

        // Auto-revoke private feed access if target is a private follower (PRD §8.1)
        const autoRevoked = await this.autoRevokePrivateFeedAccess(blockerId, targetUserId)
        if (autoRevoked) {
          return { success: true, autoRevoked: true }
        }
      }

      return result
    } catch (error) {
      logger.error('Error blocking user:', error)
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
      logger.debug(`Auto-revoking private feed access for blocked user: ${targetUserId}`)
      const revokeResult = await privateFeedService.revokeFollower(blockerId, targetUserId)

      if (revokeResult.success) {
        logger.debug(`Successfully auto-revoked private feed access for: ${targetUserId}`)
        return true
      } else {
        // Log the error but don't fail the block operation
        logger.error(`Failed to auto-revoke private feed access: ${revokeResult.error}`)
        return false
      }
    } catch (error) {
      // Auto-revocation failure should not prevent block from succeeding
      logger.error('Error during auto-revoke of private feed access:', error)
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
        this.updateOwnBlock(blockerId, targetUserId, false)
        return { success: true }
      }

      const result = await stateTransitionService.deleteDocument(
        this.contractId,
        this.documentType,
        block.$id,
        blockerId
      )

      if (result.success) {
        this.updateOwnBlock(blockerId, targetUserId, false)
        // Note: Bloom filter is add-only. False positives may occur until rebuilt.
      }

      return result
    } catch (error) {
      logger.error('Error unblocking user:', error)
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
      const result = await this.query({
        where: [
          ['$ownerId', '==', blockerId],
          ['blockedId', '==', targetUserId]
        ],
        limit: 1
      })
      return result.documents[0] || null
    } catch (error) {
      logger.error('Error getting block:', error)
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
      logger.error('Error getting user blocks:', error)
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
      const bytes = normalizeBytes(data.filterData)
      if (!bytes) {
        logger.error('Unknown filterData format:', typeof data.filterData)
        return null
      }

      return {
        filter: new BloomFilter(bytes, (data.itemCount as number) || 0),
        documentId: (doc.$id || doc.id) as string,
        revision: ((doc.$revision || doc.revision || 0) as number)
      }
    } catch (error) {
      logger.error('Error getting bloom filter:', error)
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
        const bytes = normalizeBytes(data.filterData)
        if (!bytes) continue

        result.set(ownerId, new BloomFilter(bytes, (data.itemCount as number) || 0))
      }
    } catch (error) {
      logger.error('Error getting bloom filters batch:', error)
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
            filterData: existing.filter.serialize(),
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
            filterData: filter.serialize(),
            itemCount: filter.itemCount,
            version: BLOOM_FILTER_VERSION
          }
        )
      }
    } catch (error) {
      logger.error('Error adding to bloom filter:', error)
      // Non-fatal - block still succeeded
    }
  }

  // ============================================================
  // BLOCK FOLLOW MANAGEMENT
  // ============================================================

  // In-flight dedup: on a cold session, auth initialization and feed
  // enrichment all request the block follow document concurrently —
  // share one query instead of firing identical ones.
  private blockFollowInFlight = new Map<string, Promise<BlockFollowData | null>>()

  /**
   * Get the block follow document for a user.
   * Concurrent calls for the same user share a single query.
   */
  getBlockFollow(userId: string): Promise<BlockFollowData | null> {
    const existing = this.blockFollowInFlight.get(userId)
    if (existing) return existing

    const promise = this.fetchBlockFollow(userId).finally(() => {
      this.blockFollowInFlight.delete(userId)
    })
    this.blockFollowInFlight.set(userId, promise)
    return promise
  }

  /**
   * Query the block follow document. Returns null only when the document
   * genuinely doesn't exist; query failures throw so callers don't
   * mistake a transient error for "no document".
   */
  private async fetchBlockFollow(userId: string): Promise<BlockFollowData | null> {
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
  }

  /**
   * The followed blockers as stored: v9 keeps a typed list of identifiers,
   * v2–v8 one byte array of 32-byte ids laid end to end. Reads accept both.
   */
  private decodeUserIdArray(data: unknown): string[] {
    return decodeBlockFollowIds(data)
  }

  private encodeUserIdArray(userIds: string[]): Uint8Array | Uint8Array[] {
    return encodeBlockFollowIds(userIds, blockFollowsAreTyped())
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
      logger.error('Error following user blocks:', error)
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
      logger.error('Error unfollowing user blocks:', error)
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
    // Check cache first — null means "never cached", while an empty
    // array is a valid cached result (the common case) and must not
    // trigger a refetch.
    const cached = getBlockFollowsFromCache(userId)
    if (cached !== null) {
      return cached
    }

    try {
      const data = await this.getBlockFollow(userId)
      const followedUserIds = data?.followedUserIds ?? []
      // Cache the result even when empty — only a confirmed answer
      // reaches here, since query failures throw
      setBlockFollows(userId, followedUserIds)
      return followedUserIds
    } catch (error) {
      logger.error('Error getting block follows:', error)
      return []
    }
  }

  // ============================================================
  // UNIFIED BLOCK CHECKING
  // ============================================================

  /**
   * Check if a target user is blocked by the viewer (own blocks + inherited blocks).
   */
  async isBlocked(targetUserId: string, viewerId: string): Promise<boolean> {
    if (!viewerId || !targetUserId) return false

    const blocked = await this.checkBlockedBatch(viewerId, [targetUserId])
    return blocked.get(targetUserId) ?? false
  }

  /**
   * Why the viewer sees `targetUserId` as blocked: their own block document,
   * a followed block list, or both. Unlike isBlocked(), this always checks
   * both sources, so callers can offer the right remedy (delete the own block
   * vs. manage followed block lists). A failed own-list read rejects.
   */
  async getBlockProvenance(targetUserId: string, viewerId: string): Promise<BlockProvenance> {
    if (!viewerId || !targetUserId || viewerId === targetUserId) {
      return { isBlocked: false, isOwnBlock: false, inheritedFrom: null }
    }

    // A block this session just wrote may not be queryable yet; the
    // confirmed-block cache records it, so it must not be overwritten below.
    const cached = getConfirmedBlock(viewerId, targetUserId)
    const cachedOwnBlock = cached?.isBlocked === true && cached.blockedBy === viewerId
    const [ownBlockedIds, followedBlockers] = await Promise.all([
      this.getOwnBlockedIds(viewerId),
      this.getBlockFollows(viewerId),
    ])
    const isOwnBlock = cachedOwnBlock || ownBlockedIds.includes(targetUserId)
    // The merged filter covers followed lists too; a miss rules out an inherited block.
    const mergedFilter = getMergedBloomFilter(viewerId)
    const { blocks, complete } = mergedFilter && !mergedFilter.mightContain(targetUserId)
      ? { blocks: new Map<string, InheritedBlock>(), complete: true }
      : await this.queryInheritedBlocksBatch([targetUserId], followedBlockers)
    const inherited = blocks.get(targetUserId)
    const isBlocked = isOwnBlock || inherited !== undefined

    // Own block takes precedence in the cache, matching checkBlockedBatch().
    // A negative is only cached when every followed list was actually read.
    if (isBlocked || complete) {
      addConfirmedBlocksBatch(viewerId, new Map([[targetUserId, {
        isBlocked,
        blockedBy: isOwnBlock ? viewerId : inherited?.blockedBy ?? '',
        message: isOwnBlock ? cached?.message : inherited?.message,
      }]]))
    }

    return {
      isBlocked,
      isOwnBlock,
      inheritedFrom: inherited?.blockedBy ?? null,
    }
  }

  /**
   * Batch variant for surfaces that only label blocked targets: which of
   * `targetIds` are blocked, and whether by the viewer's own block ('own',
   * which wins when both apply) or only by a followed block list.
   */
  async getBlockSourcesBatch(viewerId: string, targetIds: string[]): Promise<Map<string, BlockSource>> {
    const sources = new Map<string, BlockSource>()
    const blocked = await this.checkBlockedBatch(viewerId, targetIds)
    if (![...blocked.values()].some(Boolean)) return sources

    // checkBlockedBatch just loaded this list, so this is a cache hit.
    const ownBlockedIds = new Set(await this.getOwnBlockedIds(viewerId))
    blocked.forEach((isBlocked, targetId) => {
      if (!isBlocked) return
      const confirmed = getConfirmedBlock(viewerId, targetId)
      const isOwn = ownBlockedIds.has(targetId) || confirmed?.blockedBy === viewerId
      sources.set(targetId, isOwn ? 'own' : 'inherited')
    })
    return sources
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

    // The same read also serves card hooks that mount before enrichment settles.
    // Let failures reject so neither hooks nor enrichers cache a false negative.
    const ownBlockedSet = new Set(await this.getOwnBlockedIds(viewerId))
    const uniqueTargetIds = Array.from(new Set(targetIds))
    const unchecked: string[] = []

    // Phase 1: Check sessionStorage caches
    for (const targetId of uniqueTargetIds) {
      // Never blocked from their own view, even if a followed list blocks
      // them; matches getBlockProvenance().
      if (targetId === viewerId) {
        result.set(targetId, false)
        continue
      }
      if (ownBlockedSet.has(targetId)) {
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
      const batchResults = new Map<string, { blockedBy: string; isBlocked: boolean; message?: string }>()
      const followedBlockers = await this.getBlockFollows(viewerId)
      const { blocks: inheritedBlocks, complete } = await this.queryInheritedBlocksBatch(possiblePositives, followedBlockers)
      for (const targetId of possiblePositives) {
        const inherited = inheritedBlocks.get(targetId)
        result.set(targetId, Boolean(inherited))
        // A failed blocker query must not be cached as "not blocked".
        if (!inherited && !complete) continue
        batchResults.set(targetId, {
          blockedBy: inherited?.blockedBy ?? '',
          isBlocked: Boolean(inherited),
          message: inherited?.message,
        })
      }

      addConfirmedBlocksBatch(viewerId, batchResults)
    } catch (error) {
      logger.error('Error in batch block check:', error)
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
   * Query inherited blocks for multiple targets from multiple blockers.
   * Queries each blocker in parallel since Platform only supports one 'in' clause per query.
   *
   * TODO: This query uses 'in' clause which doesn't support reliable pagination.
   * The SDK returns incomplete results when subtrees are empty but still count against the limit.
   * Once SDK provides better 'in' query support (e.g., a flag indicating result completeness),
   * implement pagination here to handle cases where results exceed the limit.
   *
   * Per-blocker failures are logged and skipped; `complete` is false when any
   * blocker could not be read, so callers must not cache misses as negatives.
   */
  private async queryInheritedBlocksBatch(
    targetIds: string[],
    followedBlockers: string[]
  ): Promise<{ blocks: Map<string, InheritedBlock>; complete: boolean }> {
    const result = new Map<string, InheritedBlock>()
    if (targetIds.length === 0 || followedBlockers.length === 0) return { blocks: result, complete: true }
    let complete = true

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
          logger.error(`Error querying blocks for blocker ${blockerId}:`, err)
          complete = false
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
      logger.error('Error querying inherited blocks batch:', error)
      complete = false
    }

    return { blocks: result, complete }
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
    if (getOwnBlocksFromCache(userId) !== null && existingCache?.blockFollows.timestamp) {
      return // Both sections are initialized; partial caches must still load.
    }

    try {
      // Query all data in parallel
      const [followedUserIds, ownBlockedIds] = await Promise.all([
        this.getBlockFollow(userId).then(data => {
          const ids = data?.followedUserIds ?? []
          setBlockFollows(userId, ids)
          return ids
        }),
        this.getOwnBlockedIds(userId)
      ])

      // Get bloom filters for self and followed users
      const filterUserIds = [userId, ...followedUserIds]
      const filters = await this.getBloomFiltersBatch(filterUserIds)

      // Merge all bloom filters
      const mergedFilter = filters.size > 0 ? BloomFilter.merge(Array.from(filters.values())) : null

      // Initialize cache with all data
      initializeBlockCache(
        userId,
        getOwnBlocksFromCache(userId) ?? ownBlockedIds,
        followedUserIds,
        mergedFilter,
        filterUserIds
      )

      // Store merged filter in sessionStorage
      if (mergedFilter) {
        setMergedBloomFilter(userId, mergedFilter, filterUserIds)
      }
    } catch (error) {
      logger.error('Error initializing block data:', error)
    }
  }

}

// Singleton instance
export const blockService = new BlockService()
