'use client'

/**
 * Upload Provider Registry
 *
 * Manages available upload providers and tracks the active provider.
 * Currently only supports Storacha, but designed to be extensible.
 */

import type { UploadProvider } from './types'

/**
 * Registry for managing upload providers
 */
class ProviderRegistry {
  private providers = new Map<string, UploadProvider>()
  private activeProviderId: string | null = null

  /**
   * Register a provider with the registry
   */
  register(id: string, provider: UploadProvider): void {
    this.providers.set(id, provider)
  }

  /**
   * Unregister a provider from the registry
   */
  unregister(id: string): void {
    if (this.activeProviderId === id) {
      this.activeProviderId = null
    }
    this.providers.delete(id)
  }

  /**
   * Get a provider by ID
   */
  get(id: string): UploadProvider | undefined {
    return this.providers.get(id)
  }

  /**
   * Get all registered providers
   */
  getAll(): Map<string, UploadProvider> {
    return new Map(this.providers)
  }

  /**
   * Set the active provider
   */
  setActive(id: string): boolean {
    if (!this.providers.has(id)) {
      return false
    }
    this.activeProviderId = id
    return true
  }

  /**
   * Get the active provider
   */
  getActive(): UploadProvider | null {
    if (!this.activeProviderId) {
      // Return first connected provider if none explicitly set
      const providers = Array.from(this.providers.values())
      for (const provider of providers) {
        if (provider.isConnected()) {
          return provider
        }
      }
      return null
    }
    return this.providers.get(this.activeProviderId) ?? null
  }

  /**
   * Get the ID of the active provider
   */
  getActiveId(): string | null {
    return this.activeProviderId
  }

  /**
   * Check if any provider is connected
   */
  hasConnectedProvider(): boolean {
    const providers = Array.from(this.providers.values())
    for (const provider of providers) {
      if (provider.isConnected()) {
        return true
      }
    }
    return false
  }

  /**
   * Get the first connected provider
   */
  getFirstConnected(): UploadProvider | null {
    const providers = Array.from(this.providers.values())
    for (const provider of providers) {
      if (provider.isConnected()) {
        return provider
      }
    }
    return null
  }
}

// Singleton instance
export const providerRegistry = new ProviderRegistry()
