'use client'

// Import the centralized SDK service
import { evoSdkService } from './services/evo-sdk-service'
import { YAPPR_CONTRACT_ID } from './constants'

export class DashPlatformClient {
  private sdk: any = null
  private identityId: string | null = null
  private isInitializing: boolean = false
  private postsCache: Map<string, { posts: any[], timestamp: number }> = new Map()
  private readonly CACHE_TTL = 120000 // 2 minutes for posts cache (reduced query frequency)
  private pendingQueries: Map<string, Promise<any[]>> = new Map() // Prevent duplicate queries
  
  constructor() {
    // SDK will be initialized on first use
  }
  
  /**
   * Initialize the SDK using the centralized WASM service
   */
  public async ensureInitialized() {
    if (this.sdk || this.isInitializing) {
      // Already initialized or initializing
      while (this.isInitializing) {
        // Wait for initialization to complete
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      return
    }
    
    this.isInitializing = true
    
    try {
      // Use the centralized WASM service
      const network = (process.env.NEXT_PUBLIC_NETWORK as 'testnet' | 'mainnet') || 'testnet'
      const contractId = YAPPR_CONTRACT_ID
      
      console.log('DashPlatformClient: Initializing via WasmSdkService for network:', network)
      
      // Initialize the WASM SDK service if not already done
      await evoSdkService.initialize({ network, contractId })
      
      // Get the SDK instance
      this.sdk = await evoSdkService.getSdk()
      
      console.log('DashPlatformClient: WASM SDK initialized successfully via service')
    } catch (error) {
      console.error('DashPlatformClient: Failed to initialize WASM SDK:', error)
      throw error
    } finally {
      this.isInitializing = false
    }
  }
  
  /**
   * Set the identity ID for document operations
   * This is called by the auth system after identity verification
   */
  setIdentity(identityId: string) {
    this.identityId = identityId
    console.log('DashPlatformClient: Identity set to:', identityId)
  }
  
  /**
   * Create a post document
   */
  async createPost(content: string, options?: {
    replyToPostId?: string
    quotedPostId?: string
    mediaUrl?: string
    primaryHashtag?: string
  }) {
    // Get identity ID from instance or auth context
    let identityId = this.identityId
    
    if (!identityId) {
      // Try to get from auth context via user session
      if (typeof window !== 'undefined') {
        const savedSession = localStorage.getItem('yappr_session')
        if (savedSession) {
          try {
            const sessionData = JSON.parse(savedSession)
            identityId = sessionData.user?.identityId
            if (identityId) {
              // Set it for future use
              this.identityId = identityId
              console.log('DashPlatformClient: Identity restored from session:', identityId)
            }
          } catch (e) {
            console.error('Failed to parse session data:', e)
          }
        }
      }
    }
    
    if (!identityId) {
      throw new Error('Not logged in - no identity found')
    }
    
    try {
      await this.ensureInitialized()

      console.log('Creating post for identity:', identityId)

      // Use the post service which goes through the new state-transition-service
      const { postService } = await import('./services/post-service')

      // Create the post using the post service
      const post = await postService.createPost(identityId, content.trim(), {
        replyToId: options?.replyToPostId,
        quotedPostId: options?.quotedPostId,
        mediaUrl: options?.mediaUrl,
        primaryHashtag: options?.primaryHashtag?.replace('#', ''),
        language: 'en'
      })

      console.log('Post created successfully!')

      // Invalidate posts cache since we created a new post
      this.postsCache.clear()

      return post

    } catch (error) {
      console.error('Failed to create post:', error)
      throw error
    }
  }
  
  /**
   * Get user profile
   */
  async getUserProfile(identityId: string) {
    try {
      await this.ensureInitialized()
      
      console.log('Fetching profile for identity:', identityId)
      
      // Query profile document for this identity
      const query = {
        where: [
          ['$ownerId', '==', identityId]
        ],
        limit: 1
      }
      
      const contractId = YAPPR_CONTRACT_ID

      // Use EvoSDK documents facade
      const profileResponse = await this.sdk.documents.query({
        dataContractId: contractId,
        documentTypeName: 'profile',
        where: query.where,
        limit: query.limit
      })
      
      console.log('Profile query response:', profileResponse)

      // Convert Map response (v3 SDK) to array
      let profiles: unknown[] = []
      if (profileResponse instanceof Map) {
        profiles = Array.from(profileResponse.values())
          .filter(Boolean)
          .map((doc: unknown) => {
            const d = doc as { toJSON?: () => unknown }
            return typeof d.toJSON === 'function' ? d.toJSON() : doc
          })
      } else if (Array.isArray(profileResponse)) {
        profiles = profileResponse
      }

      console.log('Profiles found:', profiles)

      if (profiles.length > 0) {
        return profiles[0]
      }
      
      return null
    } catch (error) {
      console.error('Failed to fetch profile:', error)
      // Return null if profile doesn't exist
      return null
    }
  }
  
  /**
   * Query posts with caching
   */
  async queryPosts(options?: {
    limit?: number
    startAfter?: any
    authorId?: string
    forceRefresh?: boolean
  }) {
    try {
      // Create cache key based on options
      const cacheKey = JSON.stringify({
        limit: options?.limit || 20,
        authorId: options?.authorId,
        startAfter: options?.startAfter
      })
      
      // Check if there's already a pending query for this exact request
      const pendingQuery = this.pendingQueries.get(cacheKey)
      if (!options?.forceRefresh && pendingQuery) {
        console.log('DashPlatformClient: Returning pending query result')
        return await pendingQuery
      }
      
      // Check cache first (unless force refresh)
      if (!options?.forceRefresh) {
        const cached = this.postsCache.get(cacheKey)
        if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
          console.log('DashPlatformClient: Returning cached posts')
          return cached.posts
        }
      }
      
      await this.ensureInitialized()
      
      const contractId = YAPPR_CONTRACT_ID
      
      console.log('DashPlatformClient: Querying posts from contract:', contractId)
      
      // Create the query promise and store it to prevent duplicates
      const queryPromise = this._executePostsQuery(contractId, options, cacheKey)
      this.pendingQueries.set(cacheKey, queryPromise)
      
      try {
        const result = await queryPromise
        return result
      } finally {
        // Clean up the pending query
        this.pendingQueries.delete(cacheKey)
      }
    } catch (error: any) {
      // Extract error message from WasmSdkError or regular Error
      let errorMessage = 'Unknown error'
      if (error && typeof error.message === 'string') {
        errorMessage = error.message
      } else if (error instanceof Error) {
        errorMessage = error.message
      }
      console.error('DashPlatformClient: Failed to query posts:', errorMessage, {
        code: error?.code,
        kind: error?.kind
      })
      throw error
    }
  }

  /**
   * Execute the actual posts query (separated to allow proper pending query management)
   */
  private async _executePostsQuery(contractId: string, options: any, cacheKey: string): Promise<any[]> {
    try {
      
      // Build where clause
      const where: any[] = []
      if (options?.authorId) {
        // Query by $ownerId (system field)
        where.push(['$ownerId', '==', options.authorId])
      }

      // Dash Platform requires a where clause on the orderBy field for ordering to work.
      // Add a range query on $createdAt that matches all documents if no other filter.
      if (where.length === 0) {
        where.push(['$createdAt', '>', 0])
      }

      // Build order by clause - most recent first
      const orderBy = [['$createdAt', 'desc']]
      
      try {
        // Use EvoSDK documents facade
        const postsResponse = await this.sdk.documents.query({
          dataContractId: contractId,
          documentTypeName: 'post',
          where: where.length > 0 ? where : undefined,
          orderBy,
          limit: options?.limit || 20,
          startAfter: options?.startAfter || undefined
        })
        
        console.log('DashPlatformClient: Posts query response received')

        // Convert Map response (v3 SDK) to array
        let posts: unknown[] = []
        if (postsResponse instanceof Map) {
          posts = Array.from(postsResponse.values())
            .filter(Boolean)
            .map((doc: unknown) => {
              const d = doc as { toJSON?: () => unknown }
              return typeof d.toJSON === 'function' ? d.toJSON() : doc
            })
        } else if (Array.isArray(postsResponse)) {
          posts = postsResponse
        }

        console.log(`DashPlatformClient: Found ${posts.length} posts`)
        
        // Cache the results
        this.postsCache.set(cacheKey, {
          posts,
          timestamp: Date.now()
        })
        
        return posts
      } catch (queryError: any) {
        // Extract error message from WasmSdkError or regular Error
        // WasmSdkError has getters for message, code, kind, retriable, name
        let errorMessage = 'Unknown error'
        let errorCode: string | undefined
        let errorKind: string | undefined

        // Try to access WasmSdkError properties (they're getters)
        try {
          if (queryError?.message) errorMessage = queryError.message
          if (queryError?.code) errorCode = queryError.code
          if (queryError?.kind) errorKind = queryError.kind
        } catch (e) {
          // Getters might throw
        }

        // Fallback checks
        if (errorMessage === 'Unknown error') {
          if (queryError instanceof Error) {
            errorMessage = queryError.message
          } else if (typeof queryError === 'string') {
            errorMessage = queryError
          }
        }

        console.log('DashPlatformClient: Document query failed:', {
          message: errorMessage,
          code: errorCode,
          kind: errorKind,
          retriable: queryError?.retriable,
          errorType: queryError?.constructor?.name,
          errorString: String(queryError)
        })

        // For contract-related errors or "not found" errors, return empty array instead of throwing
        // These are expected for new contracts or when no documents exist
        const isContractError = errorMessage.toLowerCase().includes('contract')
        const isNotFoundError = errorMessage.toLowerCase().includes('not found') ||
            errorMessage.toLowerCase().includes('no documents')
        const isKindNotFound = errorKind === 'NotFound' || errorKind === 'not_found'
        const isCodeNotFound = errorCode === 'NOT_FOUND' || errorCode === 'not_found'

        if (isContractError || isNotFoundError || isKindNotFound || isCodeNotFound) {
          console.log('DashPlatformClient: Expected error (contract/not found), returning empty posts array')
          return []
        }

        // Re-throw other errors
        throw queryError
      }
    } catch (error: any) {
      // Extract error message from WasmSdkError or regular Error
      let errorMessage = 'Unknown error'
      if (error && typeof error.message === 'string') {
        errorMessage = error.message
      } else if (error instanceof Error) {
        errorMessage = error.message
      }
      console.error('DashPlatformClient: _executePostsQuery failed:', errorMessage, {
        code: error?.code,
        kind: error?.kind
      })
      throw error
    }
  }

  /**
   * Clear the posts cache and pending queries
   */
  clearPostsCache() {
    this.postsCache.clear()
    this.pendingQueries.clear()
    console.log('DashPlatformClient: Posts cache and pending queries cleared')
  }
  
  /**
   * Get key type name
   */
  private getKeyTypeName(type: number): string {
    const types = ['ECDSA_SECP256K1', 'BLS12_381', 'ECDSA_HASH160', 'BIP13_SCRIPT_HASH', 'EDDSA_25519_HASH160']
    return types[type] || 'UNKNOWN'
  }
  
  /**
   * Get key purpose name
   */
  private getKeyPurposeName(purpose: number): string {
    const purposes = ['AUTHENTICATION', 'ENCRYPTION', 'DECRYPTION', 'TRANSPORT', 'SYSTEM', 'VOTING']
    return purposes[purpose] || 'UNKNOWN'
  }
  
  /**
   * Get security level name
   */
  private getSecurityLevelName(level: number): string {
    const levels = ['MASTER', 'CRITICAL', 'HIGH', 'MEDIUM', 'LOW']
    return levels[level] || 'UNKNOWN'
  }
}

// Singleton instance
let dashClient: DashPlatformClient | null = null

export function getDashPlatformClient(): DashPlatformClient {
  if (!dashClient) {
    dashClient = new DashPlatformClient()
  }
  return dashClient
}

// Reset the client (useful for handling errors)
export function resetDashPlatformClient(): void {
  if (dashClient) {
    dashClient = null
  }
}