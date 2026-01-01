'use client'

import { getDashPlatformClient } from './dash-platform-client'
import { DPNS_CONTRACT_ID } from './constants'

/**
 * Service for managing DPNS (Dash Platform Name Service) operations
 */
export class DPNSService {
  private dashClient: ReturnType<typeof getDashPlatformClient>
  private cache: Map<string, { value: any; timestamp: number }> = new Map()
  private readonly CACHE_TTL = 5 * 60 * 1000 // 5 minutes
  
  constructor() {
    this.dashClient = getDashPlatformClient()
  }
  
  /**
   * Get cached value if not expired
   */
  private getCached<T>(key: string): T | null {
    const cached = this.cache.get(key)
    if (!cached) return null
    
    if (Date.now() - cached.timestamp > this.CACHE_TTL) {
      this.cache.delete(key)
      return null
    }
    
    return cached.value as T
  }
  
  /**
   * Set cache value
   */
  private setCache(key: string, value: any): void {
    this.cache.set(key, { value, timestamp: Date.now() })
  }
  
  /**
   * Clear cache for a specific key or all cache
   */
  public clearCache(key?: string): void {
    if (key) {
      this.cache.delete(key)
    } else {
      this.cache.clear()
    }
  }
  
  /**
   * Check if a username is available
   * @param username The username to check
   * @returns true if available, false otherwise
   */
  async isUsernameAvailable(username: string): Promise<boolean> {
    try {
      // Validate username format
      if (!this.isValidUsername(username)) {
        return false
      }
      
      // Check if username is already registered
      const existingIdentity = await this.resolveUsername(username)
      return existingIdentity === null
    } catch (error) {
      console.error('Failed to check username availability:', error)
      throw error
    }
  }
  
  /**
   * Register a new DPNS username for an identity
   * @param identityId The identity to register the username for
   * @param username The username to register
   * @param privateKey The private key for signing the transaction
   */
  async registerUsername(identityId: string, username: string, privateKey: string): Promise<void> {
    try {
      // Validate username
      if (!this.isValidUsername(username)) {
        throw new Error('Invalid username format')
      }
      
      // Check availability
      const isAvailable = await this.isUsernameAvailable(username)
      if (!isAvailable) {
        throw new Error('Username is not available')
      }
      
      // TODO: Implement DPNS registration using WASM SDK
      // This would involve creating a DPNS document and broadcasting it
      console.log('Registering DPNS username:', username, 'for identity:', identityId)
      
      // For now, throw error since it's not implemented
      throw new Error('DPNS registration not yet implemented in WASM SDK')
    } catch (error) {
      console.error('Failed to register username:', error)
      throw error
    }
  }
  
  /**
   * Get the DPNS username for an identity
   * @param identityId The identity to lookup
   * @returns The username if found, null otherwise
   */
  async getUsername(identityId: string): Promise<string | null> {
    try {
      // Check cache first
      const cacheKey = `username:${identityId}`
      const cached = this.getCached<string>(cacheKey)
      if (cached !== null) {
        console.log('✅ Returning cached DPNS username for identity:', identityId)
        return cached
      }
      
      console.log('🔍 Looking up DPNS username for identity:', identityId)
      
      // Get the SDK instance from the client
      await this.dashClient.ensureInitialized()
      const sdk = (this.dashClient as any).sdk
      
      if (!sdk) {
        console.error('❌ SDK not initialized')
        return null
      }
      
      console.log('✅ SDK initialized, starting DPNS query')
      
      // First, let's try to query all domains to see what's available
      console.log('📋 Querying all domains first...')
      
      try {
        // Use EvoSDK documents facade
        const allDomainsResponse = await sdk.documents.query({
          contractId: DPNS_CONTRACT_ID,
          type: 'domain',
          limit: 10
        })
        
        console.log('🗂️ All domains response:', allDomainsResponse)
        
        let allDomains
        if (allDomainsResponse && typeof allDomainsResponse.toJSON === 'function') {
          allDomains = allDomainsResponse.toJSON()
        } else {
          allDomains = allDomainsResponse
        }
        
        console.log('🗂️ All domains processed:', allDomains)
        
        if (allDomains && allDomains.length > 0) {
          console.log('🔍 Found domains, checking structure:', allDomains[0])
          
          // Check if any of these domains belong to our identity
          const myDomain = allDomains.find((domain: any) => {
            const domainIdentityId = domain.records?.dashUniqueIdentityId || domain.dashUniqueIdentityId
            console.log('🔍 Checking domain:', {
              label: domain.label || domain.normalizedLabel,
              identityId: domainIdentityId,
              targetIdentityId: identityId,
              matches: domainIdentityId === identityId
            })
            return domainIdentityId === identityId
          })
          
          if (myDomain) {
            const username = myDomain.label || myDomain.normalizedLabel
            console.log('✅ Found DPNS username:', username)
            return username
          }
        }
      } catch (allDomainsError) {
        console.error('❌ Error querying all domains:', allDomainsError)
      }
      
      // Now try the specific query for this identity
      const where = [
        ['records.dashUniqueIdentityId', '==', identityId]
      ]

      console.log('🎯 Querying DPNS with specific identity:', {
        contractId: DPNS_CONTRACT_ID,
        documentType: 'domain',
        where,
        identityId
      })

      // Use EvoSDK documents facade
      const domainsResponse = await sdk.documents.query({
        contractId: DPNS_CONTRACT_ID,
        type: 'domain',
        where,
        limit: 1
      })
      
      console.log('🎯 DPNS specific domains response:', domainsResponse)
      
      // Convert response if needed
      let domains
      if (domainsResponse && typeof domainsResponse.toJSON === 'function') {
        domains = domainsResponse.toJSON()
      } else {
        domains = domainsResponse
      }
      
      console.log('🎯 Processed specific domains:', domains)
      
      if (domains && domains.length > 0) {
        const domain = domains[0]
        // Extract the username from the domain data
        const username = domain.label || domain.normalizedLabel
        console.log('✅ Found DPNS username:', username)
        // Cache the result
        this.setCache(cacheKey, username)
        return username
      }
      
      console.log('❌ No DPNS username found for identity:', identityId)
      // Cache the null result to avoid repeated lookups
      this.setCache(cacheKey, null)
      return null
    } catch (error) {
      console.error('❌ Failed to lookup username:', error)
      const errorDetails = error instanceof Error ? {
        message: error.message,
        stack: error.stack,
        name: error.name
      } : { message: String(error) }
      console.error('❌ Error details:', errorDetails)
      return null
    }
  }
  
  /**
   * Resolve a username to an identity ID
   * @param username The username to resolve
   * @returns The identity ID if found, null otherwise
   */
  async resolveUsername(username: string): Promise<string | null> {
    try {
      // Check cache first
      const cacheKey = `resolve:${username.toLowerCase()}`
      const cached = this.getCached<string>(cacheKey)
      if (cached !== null) {
        console.log('✅ Returning cached identity for username:', username)
        return cached
      }
      
      console.log('Resolving DPNS username:', username)
      
      // Get the SDK instance from the client
      await this.dashClient.ensureInitialized()
      const sdk = (this.dashClient as any).sdk
      
      if (!sdk) {
        console.error('SDK not initialized')
        return null
      }
      
      // Query for domain documents with the specific label
      const where = [
        ['normalizedLabel', '==', username.toLowerCase()],
        ['normalizedParentDomainName', '==', 'dash']
      ]

      console.log('Resolving DPNS with:', {
        contractId: DPNS_CONTRACT_ID,
        documentType: 'domain',
        where
      })

      // Use EvoSDK documents facade
      const domainsResponse = await sdk.documents.query({
        contractId: DPNS_CONTRACT_ID,
        type: 'domain',
        where,
        limit: 1
      })
      
      console.log('DPNS resolution response:', domainsResponse)
      
      // Convert response if needed
      let domains
      if (domainsResponse && typeof domainsResponse.toJSON === 'function') {
        domains = domainsResponse.toJSON()
      } else {
        domains = domainsResponse
      }
      
      console.log('Processed domains:', domains)
      
      if (domains && domains.length > 0) {
        const domain = domains[0]
        // Extract the identity ID from the domain records
        const identityId = domain.records?.dashUniqueIdentityId
        console.log('Resolved username to identity:', identityId)
        // Cache the result
        this.setCache(cacheKey, identityId)
        return identityId
      }
      
      console.log('No identity found for username:', username)
      // Cache the null result
      this.setCache(cacheKey, null)
      return null
    } catch (error) {
      console.error('Failed to resolve username:', error)
      return null
    }
  }
  
  /**
   * Validate username format
   * @param username The username to validate
   * @returns true if valid, false otherwise
   */
  private isValidUsername(username: string): boolean {
    // DPNS username rules:
    // - 3-20 characters
    // - Alphanumeric and underscores only
    // - Cannot start or end with underscore
    // - No consecutive underscores
    
    if (!username || username.length < 3 || username.length > 20) {
      return false
    }
    
    // Check alphanumeric and underscores only
    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      return false
    }
    
    // Cannot start or end with underscore
    if (username.startsWith('_') || username.endsWith('_')) {
      return false
    }
    
    // No consecutive underscores
    if (username.includes('__')) {
      return false
    }
    
    return true
  }
  
  /**
   * Get username validation error message
   * @param username The username to validate
   * @returns Error message if invalid, null if valid
   */
  getUsernameValidationError(username: string): string | null {
    if (!username) {
      return 'Username is required'
    }
    
    if (username.length < 3) {
      return 'Username must be at least 3 characters'
    }
    
    if (username.length > 20) {
      return 'Username must be 20 characters or less'
    }
    
    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      return 'Username can only contain letters, numbers, and underscores'
    }
    
    if (username.startsWith('_') || username.endsWith('_')) {
      return 'Username cannot start or end with underscore'
    }
    
    if (username.includes('__')) {
      return 'Username cannot contain consecutive underscores'
    }
    
    return null
  }
}

// Singleton instance
let dpnsService: DPNSService | null = null

export function getDPNSService(): DPNSService {
  if (!dpnsService) {
    dpnsService = new DPNSService()
  }
  return dpnsService
}