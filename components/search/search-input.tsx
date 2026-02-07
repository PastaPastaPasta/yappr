'use client'

import { useState, useEffect, useRef, KeyboardEvent } from 'react'
import { useRouter } from 'next/navigation'
import { MagnifyingGlassIcon, XMarkIcon } from '@heroicons/react/24/outline'
import { motion, AnimatePresence } from 'framer-motion'
import { dpnsService, unifiedProfileService } from '@/lib/services'
import { UserAvatar } from '@/components/ui/avatar-image'
import { Spinner } from '@/components/ui/spinner'

// Minimum characters to trigger search (like DashPay)
const MIN_SEARCH_LENGTH = 3

interface SearchResult {
  type: 'user' | 'hashtag'
  id: string
  username?: string
  displayName?: string
  hashtag?: string
}

export function SearchInput() {
  const router = useRouter()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [showDropdown, setShowDropdown] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const searchIdRef = useRef(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node) &&
        inputRef.current &&
        !inputRef.current.contains(e.target as Node)
      ) {
        setShowDropdown(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // Search when query changes
  useEffect(() => {
    const trimmedQuery = query.trim()

    // Clear results if query is too short
    if (trimmedQuery.length < MIN_SEARCH_LENGTH) {
      // Invalidate any in-flight searches
      ++searchIdRef.current
      setResults([])
      setIsSearching(false)
      setShowDropdown(false)
      return
    }

    const searchId = ++searchIdRef.current
    setIsSearching(true)
    setShowDropdown(true)

    const debounceTimer = setTimeout(async () => {
      try {
        const searchResults: SearchResult[] = []

        // Check if it looks like a hashtag search
        const isHashtagSearch = trimmedQuery.startsWith('#')
        const searchTerm = isHashtagSearch ? trimmedQuery.slice(1) : trimmedQuery

        if (searchTerm.length < MIN_SEARCH_LENGTH) {
          if (searchId === searchIdRef.current) {
            setResults([])
            setIsSearching(false)
          }
          return
        }

        // Search for users via DPNS
        if (!isHashtagSearch) {
          const dpnsResults = await dpnsService.searchUsernamesWithDetails(searchTerm, 5)

          if (searchId !== searchIdRef.current) return

          if (dpnsResults.length > 0) {
            // Get unique owner IDs
            const ownerIds = Array.from(
              new Set(dpnsResults.map((r) => r.ownerId).filter(Boolean))
            )

            // Fetch profiles for display names
            let profiles: Array<{ $ownerId?: string; ownerId?: string; displayName?: string }> = []
            if (ownerIds.length > 0) {
              try {
                profiles = await unifiedProfileService.getProfilesByIdentityIds(ownerIds)
              } catch (error) {
                console.error('Failed to fetch profiles:', error)
              }
            }

            if (searchId !== searchIdRef.current) return

            // Create profile map
            const profileMap = new Map(
              profiles.map((p) => [p.$ownerId || p.ownerId, p])
            )

            // Build results (one per unique owner)
            const seenOwners = new Set<string>()
            for (const dpnsResult of dpnsResults) {
              if (!dpnsResult.ownerId || seenOwners.has(dpnsResult.ownerId)) continue
              seenOwners.add(dpnsResult.ownerId)

              const profile = profileMap.get(dpnsResult.ownerId)
              const username = dpnsResult.username.replace(/\.dash$/, '')

              searchResults.push({
                type: 'user',
                id: dpnsResult.ownerId,
                username,
                displayName: profile?.displayName || username,
              })
            }
          }
        }

        // Add hashtag suggestion if query looks like a hashtag
        if (isHashtagSearch && searchTerm.length >= MIN_SEARCH_LENGTH) {
          searchResults.push({
            type: 'hashtag',
            id: searchTerm.toLowerCase(),
            hashtag: searchTerm.toLowerCase(),
          })
        }

        if (searchId === searchIdRef.current) {
          setResults(searchResults)
          setSelectedIndex(0)
        }
      } catch (error) {
        console.error('Search failed:', error)
        if (searchId === searchIdRef.current) {
          setResults([])
        }
      } finally {
        if (searchId === searchIdRef.current) {
          setIsSearching(false)
        }
      }
    }, 300)

    return () => clearTimeout(debounceTimer)
  }, [query])

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (showDropdown && results.length > 0) {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          setSelectedIndex((prev) => (prev + 1) % results.length)
          return
        case 'ArrowUp':
          e.preventDefault()
          setSelectedIndex((prev) => (prev - 1 + results.length) % results.length)
          return
        case 'Enter': {
          e.preventDefault()
          const selected = results[selectedIndex]
          if (selected) {
            navigateToResult(selected)
            return
          }
          break
        }
        case 'Escape':
          setShowDropdown(false)
          return
      }
    }

    // Default Enter behavior - go to search page
    if (e.key === 'Enter' && query.trim()) {
      router.push(`/search?q=${encodeURIComponent(query.trim())}`)
      setShowDropdown(false)
    }
  }

  const navigateToResult = (result: SearchResult) => {
    if (result.type === 'user') {
      router.push(`/user?id=${result.id}`)
    } else if (result.type === 'hashtag') {
      router.push(`/hashtag/${result.hashtag}`)
    }
    setShowDropdown(false)
    setQuery('')
  }

  const handleClear = () => {
    setQuery('')
    setResults([])
    setShowDropdown(false)
  }

  const handleFocus = () => {
    if (query.trim().length >= MIN_SEARCH_LENGTH && results.length > 0) {
      setShowDropdown(true)
    }
  }

  return (
    <div className="relative">
      <MagnifyingGlassIcon className="absolute left-3.5 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-400 dark:text-gray-500 z-10" />
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        onFocus={handleFocus}
        placeholder="Search users & hashtags"
        className="w-full h-10 pl-10 pr-10 bg-surface-100 dark:bg-surface-800 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-yappr-500/50 focus:bg-white dark:focus:bg-surface-900 border border-transparent focus:border-surface-300 dark:focus:border-neutral-750 transition-all duration-200"
      />
      {query && (
        <button
          onClick={handleClear}
          className="absolute right-3 top-1/2 -translate-y-1/2 p-1 hover:bg-surface-200 dark:hover:bg-neutral-750 rounded-lg z-10 transition-colors"
        >
          <XMarkIcon className="h-4 w-4 text-gray-500" />
        </button>
      )}

      {/* Search Results Dropdown */}
      <AnimatePresence>
        {showDropdown && query.trim().length >= MIN_SEARCH_LENGTH && (
          <motion.div
            ref={dropdownRef}
            initial={{ opacity: 0, y: -5 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -5 }}
            transition={{ duration: 0.15 }}
            className="absolute top-full left-0 right-0 mt-2 bg-white dark:bg-surface-900 rounded-xl shadow-elevated-lg border border-surface-200 dark:border-neutral-750 overflow-hidden z-50"
          >
            {isSearching ? (
              <div className="p-3 flex items-center justify-center gap-2 text-gray-500">
                <Spinner size="sm" />
                <span className="text-sm">Searching...</span>
              </div>
            ) : results.length > 0 ? (
              <div className="max-h-64 overflow-y-auto">
                {results.map((result, index) => (
                  <button
                    key={`${result.type}-${result.id}`}
                    type="button"
                    onClick={() => navigateToResult(result)}
                    onMouseEnter={() => setSelectedIndex(index)}
                    className={`w-full flex items-center gap-3 p-3 text-left transition-colors ${
                      index === selectedIndex
                        ? 'bg-yappr-50 dark:bg-yappr-900/30'
                        : 'hover:bg-surface-100 dark:hover:bg-surface-800'
                    }`}
                  >
                    {result.type === 'user' ? (
                      <>
                        <div className="h-10 w-10 rounded-full overflow-hidden flex-shrink-0">
                          <UserAvatar
                            userId={result.id}
                            size="md"
                            alt={result.displayName || result.username || ''}
                          />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-sm truncate text-gray-900 dark:text-gray-100">
                            {result.displayName}
                          </p>
                          <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
                            @{result.username}
                          </p>
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="h-10 w-10 rounded-xl bg-yappr-100 dark:bg-yappr-900/50 flex items-center justify-center flex-shrink-0">
                          <span className="text-yappr-600 dark:text-yappr-400 font-bold">#</span>
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-sm truncate text-gray-900 dark:text-gray-100">
                            #{result.hashtag}
                          </p>
                          <p className="text-xs text-gray-500 dark:text-gray-400">
                            View hashtag
                          </p>
                        </div>
                      </>
                    )}
                  </button>
                ))}
                {/* View all results link */}
                <button
                  type="button"
                  onClick={() => {
                    router.push(`/search?q=${encodeURIComponent(query.trim())}`)
                    setShowDropdown(false)
                  }}
                  className="w-full p-3 text-sm text-yappr-500 hover:bg-surface-100 dark:hover:bg-surface-800 text-center border-t border-surface-200 dark:border-neutral-750 transition-colors"
                >
                  View all results for &quot;{query.trim()}&quot;
                </button>
              </div>
            ) : (
              <div className="p-3 text-center text-sm text-gray-500 dark:text-gray-400">
                No results found for &quot;{query.trim()}&quot;
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
