'use client'

import { useEffect, useRef, useState } from 'react'
import { logger } from '@/lib/logger'
import { dpnsService, followService, identityService, unifiedProfileService } from '@/lib/services'
import { loadIdentityBatch } from '@/lib/services/identity-batch'
import { getPrimaryUsername } from '@/lib/utils/username'

// Upper bound on the follower suggestions shown before anything is typed; also
// keeps the batched DPNS lookup within its single-query limit.
const MAX_FOLLOWER_SUGGESTIONS = 50

export interface UserSearchResult {
  id: string
  username?: string
  displayName: string
  bio?: string
}

/** Debounced DPNS username search (3 to 30 characters), excluding the viewer. */
export function useUserSearch(input: string, viewerId: string | undefined) {
  const [results, setResults] = useState<UserSearchResult[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const searchIdRef = useRef(0)

  useEffect(() => {
    const query = input.trim()
    // Clear results if query is empty or looks like an identity ID
    if (!query || query.length > 30) {
      setResults([])
      setIsSearching(false)
      return
    }
    // Only search if at least 3 characters (like DashPay)
    if (query.length < 3) {
      setResults([])
      return
    }

    const currentSearchId = ++searchIdRef.current
    setIsSearching(true)

    const debounceTimer = setTimeout(async () => {
      try {
        const dpnsResults = await dpnsService.searchUsernamesWithDetails(query, 5)
        if (currentSearchId !== searchIdRef.current) return
        if (dpnsResults.length === 0) {
          setResults([])
          setIsSearching(false)
          return
        }

        const ownerIds = Array.from(new Set(dpnsResults.map(r => r.ownerId).filter(id => id && id !== viewerId)))
        let profiles: { $ownerId?: string; ownerId?: string; displayName?: string; bio?: string }[] = []
        if (ownerIds.length > 0) {
          try {
            profiles = await unifiedProfileService.getProfilesByIdentityIds(ownerIds)
          } catch (error) {
            logger.error('Failed to fetch profiles for search:', error)
          }
        }
        if (currentSearchId !== searchIdRef.current) return

        const profileMap = new Map(profiles.map(p => [p.$ownerId || p.ownerId, p]))
        // Group matched names by owner to handle multiple names per owner
        const ownerToNames = new Map<string, string[]>()
        for (const dpnsResult of dpnsResults) {
          if (!dpnsResult.ownerId || dpnsResult.ownerId === viewerId) continue
          const names = ownerToNames.get(dpnsResult.ownerId) || []
          names.push(dpnsResult.username)
          ownerToNames.set(dpnsResult.ownerId, names)
        }

        setResults(Array.from(ownerToNames.entries()).map(([ownerId, names]) => {
          const profile = profileMap.get(ownerId)
          const username = (getPrimaryUsername(names) ?? names[0]).replace(/\.dash$/, '')
          return { id: ownerId, username, displayName: profile?.displayName || username, bio: profile?.bio }
        }))
      } catch (error) {
        logger.error('User search failed:', error)
        setResults([])
      } finally {
        if (currentSearchId === searchIdRef.current) setIsSearching(false)
      }
    }, 300)

    return () => clearTimeout(debounceTimer)
  }, [input, viewerId])

  return { results, isSearching }
}

/** The viewer's most recent followers, loaded once when `active` first turns true. */
export function useFollowerSuggestions(active: boolean, viewerId: string | undefined) {
  const [followers, setFollowers] = useState<UserSearchResult[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const loadedRef = useRef(false)

  useEffect(() => {
    if (!active || !viewerId || loadedRef.current) return
    loadedRef.current = true
    let cancelled = false
    setIsLoading(true)

    const load = async () => {
      try {
        const follows = await followService.getFollowers(viewerId)
        // getFollowers returns oldest first; suggest the most recent followers
        // and cap the list so the DPNS/profile lookups stay a single batch.
        const followerIds = Array.from(new Set(follows.map(f => f.$ownerId).filter(id => id && id !== viewerId)))
          .reverse()
          .slice(0, MAX_FOLLOWER_SUGGESTIONS)
        if (cancelled) return
        if (followerIds.length === 0) {
          setFollowers([])
          return
        }
        const { usernames, profiles } = await loadIdentityBatch(followerIds).catch(() => ({
          usernames: new Map<string, string | null>(),
          profiles: [],
        }))
        if (cancelled) return
        const profileMap = new Map(profiles.map(profile => [profile.$ownerId, profile] as const))
        setFollowers(followerIds.map(id => {
          const username = usernames.get(id)?.replace(/\.dash$/, '') || undefined
          const profile = profileMap.get(id)
          return { id, username, displayName: profile?.displayName || username || `User ${id.slice(-6)}`, bio: profile?.bio }
        }))
      } catch (error) {
        logger.error('Failed to load followers for new conversation:', error)
        // Allow a retry the next time the picker opens
        loadedRef.current = false
        if (!cancelled) setFollowers([])
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }

    load().catch(err => logger.error('Failed to load followers:', err))
    return () => { cancelled = true }
  }, [active, viewerId])

  return { followers, isLoading }
}

/**
 * Resolve typed input to an identity: a full identity ID (verified to exist)
 * or a DPNS username. Throws a user-facing message on failure.
 */
export async function resolveUserInput(input: string): Promise<{ id: string; username?: string }> {
  const trimmed = input.trim()
  if (trimmed.length > 30 && !trimmed.includes('.')) {
    let identity: unknown
    try {
      identity = await identityService.getIdentity(trimmed)
    } catch (err) {
      logger.error('Error verifying identity:', err)
      throw new Error('Could not verify identity. Please check the ID.')
    }
    if (!identity) throw new Error('Identity not found')
    return { id: trimmed }
  }
  const username = trimmed.replace(/\.dash$/, '')
  const resolvedId = await dpnsService.resolveIdentity(username)
  if (!resolvedId) throw new Error(`Username "${username}" not found`)
  return { id: resolvedId, username }
}
