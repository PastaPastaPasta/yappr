'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { dpnsService, unifiedProfileService } from '@/lib/services'
import { UserAvatar } from '@/components/ui/avatar-image'
import { Spinner } from '@/components/ui/spinner'

// Minimum characters after @ to trigger search (like DashPay)
const MIN_SEARCH_LENGTH = 3

interface MentionSuggestion {
  username: string
  displayName: string
  identityId: string
}

interface MentionAutocompleteProps {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  content: string
  onSelect: (username: string, startPos: number, endPos: number) => void
}

/**
 * Detects if there's an active @mention being typed at the cursor position
 * Returns the mention text (without @) and the start/end positions, or null if no active mention
 */
function detectActiveMention(
  content: string,
  cursorPos: number
): { mention: string; start: number; end: number } | null {
  // Look backwards from cursor to find @
  let start = cursorPos - 1
  while (start >= 0) {
    const char = content[start]
    // Found @, check if it's at start or preceded by whitespace
    if (char === '@') {
      const precededByWhitespace = start === 0 || /\s/.test(content[start - 1])
      if (precededByWhitespace) {
        const mention = content.substring(start + 1, cursorPos)
        // Only valid if mention contains valid username characters
        if (/^[a-zA-Z0-9_]*$/.test(mention)) {
          return { mention, start, end: cursorPos }
        }
      }
      break
    }
    // Stop at whitespace or if we hit an invalid character
    if (/\s/.test(char)) {
      break
    }
    // Invalid username character - stop searching
    if (!/[a-zA-Z0-9_]/.test(char)) {
      break
    }
    start--
  }
  return null
}

export function MentionAutocomplete({
  textareaRef,
  content,
  onSelect,
}: MentionAutocompleteProps) {
  const [suggestions, setSuggestions] = useState<MentionSuggestion[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [activeMention, setActiveMention] = useState<{
    mention: string
    start: number
    end: number
  } | null>(null)
  const [dropdownPosition, setDropdownPosition] = useState({ top: 0, left: 0 })
  const searchIdRef = useRef(0)
  const dropdownRef = useRef<HTMLDivElement>(null)

  // Calculate dropdown position based on cursor
  const updateDropdownPosition = useCallback(() => {
    const textarea = textareaRef.current
    if (!textarea || !activeMention) return

    // Create a temporary span to measure text position
    const computedStyle = window.getComputedStyle(textarea)
    const mirror = document.createElement('div')
    mirror.style.cssText = `
      position: absolute;
      top: -9999px;
      left: -9999px;
      white-space: pre-wrap;
      word-wrap: break-word;
      font-family: ${computedStyle.fontFamily};
      font-size: ${computedStyle.fontSize};
      line-height: ${computedStyle.lineHeight};
      padding: ${computedStyle.padding};
      width: ${textarea.clientWidth}px;
    `

    // Text before the @ symbol
    const textBefore = content.substring(0, activeMention.start)
    mirror.textContent = textBefore

    // Add a marker span
    const marker = document.createElement('span')
    marker.textContent = '@'
    mirror.appendChild(marker)

    document.body.appendChild(mirror)

    try {
      const markerRect = marker.getBoundingClientRect()
      const mirrorRect = mirror.getBoundingClientRect()

      // Calculate position relative to textarea
      const relativeLeft = markerRect.left - mirrorRect.left
      // Parse lineHeight robustly - fall back to fontSize * 1.2 if "normal" or unparseable
      const parsedLineHeight = parseFloat(computedStyle.lineHeight)
      const lineHeight = Number.isNaN(parsedLineHeight)
        ? parseFloat(computedStyle.fontSize) * 1.2
        : parsedLineHeight
      const relativeTop = markerRect.top - mirrorRect.top + lineHeight

      // Account for scroll
      const scrollTop = textarea.scrollTop

      // Position dropdown below the @ symbol
      setDropdownPosition({
        top: relativeTop - scrollTop,
        left: Math.min(relativeLeft, textarea.clientWidth - 250) // Prevent overflow
      })
    } finally {
      document.body.removeChild(mirror)
    }
  }, [textareaRef, activeMention, content])

  // Detect active mention on content/cursor change
  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return

    const handleSelectionChange = () => {
      const cursorPos = textarea.selectionStart
      const mention = detectActiveMention(content, cursorPos)
      setActiveMention(mention)
      setSelectedIndex(0)
    }

    // Check immediately
    handleSelectionChange()

    // Listen for selection changes
    textarea.addEventListener('click', handleSelectionChange)
    textarea.addEventListener('keyup', handleSelectionChange)

    return () => {
      textarea.removeEventListener('click', handleSelectionChange)
      textarea.removeEventListener('keyup', handleSelectionChange)
    }
  }, [textareaRef, content])

  // Update dropdown position when active mention changes
  useEffect(() => {
    if (activeMention) {
      updateDropdownPosition()
    }
  }, [activeMention, updateDropdownPosition])

  // Search for usernames when mention text changes
  useEffect(() => {
    if (!activeMention || activeMention.mention.length < MIN_SEARCH_LENGTH) {
      // Invalidate any in-flight searches before clearing
      ++searchIdRef.current
      setSuggestions([])
      setIsLoading(false)
      return
    }

    const searchId = ++searchIdRef.current
    setIsLoading(true)

    const searchTimeout = setTimeout(async () => {
      try {
        // Search DPNS usernames
        const dpnsResults = await dpnsService.searchUsernamesWithDetails(
          activeMention.mention,
          5
        )

        // Ignore stale results
        if (searchId !== searchIdRef.current) return

        if (dpnsResults.length === 0) {
          setSuggestions([])
          setIsLoading(false)
          return
        }

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
            console.error('Failed to fetch profiles for autocomplete:', error)
          }
        }

        // Ignore stale results
        if (searchId !== searchIdRef.current) return

        // Create profile map
        const profileMap = new Map(
          profiles.map((p) => [p.$ownerId || p.ownerId, p])
        )

        // Build suggestions (one per unique owner)
        const seenOwners = new Set<string>()
        const results: MentionSuggestion[] = []

        for (const dpnsResult of dpnsResults) {
          if (!dpnsResult.ownerId || seenOwners.has(dpnsResult.ownerId)) continue
          seenOwners.add(dpnsResult.ownerId)

          const profile = profileMap.get(dpnsResult.ownerId)
          const username = dpnsResult.username.replace(/\.dash$/, '')

          results.push({
            username,
            displayName: profile?.displayName || username,
            identityId: dpnsResult.ownerId,
          })
        }

        setSuggestions(results)
      } catch (error) {
        console.error('Mention autocomplete search failed:', error)
        setSuggestions([])
      } finally {
        if (searchId === searchIdRef.current) {
          setIsLoading(false)
        }
      }
    }, 200) // Debounce

    return () => clearTimeout(searchTimeout)
  }, [activeMention])

  // Handle keyboard navigation
  useEffect(() => {
    const textarea = textareaRef.current
    // Attach handler whenever we have an active mention with sufficient length
    if (!textarea || !activeMention || activeMention.mention.length < MIN_SEARCH_LENGTH) return

    const handleKeyDown = (e: KeyboardEvent) => {
      // Always handle Escape to dismiss autocomplete (even while loading)
      if (e.key === 'Escape') {
        e.preventDefault()
        setSuggestions([])
        setActiveMention(null)
        return
      }

      // Gate navigation/selection on having suggestions
      if (suggestions.length === 0) return

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          setSelectedIndex((prev) => (prev + 1) % suggestions.length)
          break
        case 'ArrowUp':
          e.preventDefault()
          setSelectedIndex((prev) => (prev - 1 + suggestions.length) % suggestions.length)
          break
        case 'Enter':
        case 'Tab': {
          e.preventDefault()
          const selected = suggestions[selectedIndex]
          onSelect(selected.username, activeMention.start, activeMention.end)
          setSuggestions([])
          setActiveMention(null)
          break
        }
      }
    }

    textarea.addEventListener('keydown', handleKeyDown)
    return () => textarea.removeEventListener('keydown', handleKeyDown)
  }, [textareaRef, suggestions, selectedIndex, activeMention, onSelect])

  // Don't show if no active mention or mention too short
  if (!activeMention || activeMention.mention.length < MIN_SEARCH_LENGTH) {
    return null
  }

  // Don't show if no suggestions and not loading
  if (suggestions.length === 0 && !isLoading) {
    return null
  }

  return (
    <AnimatePresence>
      <motion.div
        ref={dropdownRef}
        initial={{ opacity: 0, y: -5 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -5 }}
        transition={{ duration: 0.15 }}
        className="absolute z-50 w-64 bg-white dark:bg-surface-900 rounded-xl shadow-lg border border-surface-200 dark:border-neutral-750 overflow-hidden"
        style={{
          top: dropdownPosition.top,
          left: dropdownPosition.left,
        }}
      >
        {isLoading ? (
          <div className="p-3 flex items-center justify-center gap-2 text-gray-500">
            <Spinner size="sm" className="h-4 w-4 border-gray-500" />
            <span className="text-sm">Searching...</span>
          </div>
        ) : (
          <div className="max-h-48 overflow-y-auto">
            {suggestions.map((suggestion, index) => (
              <button
                key={suggestion.identityId}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault() // Prevent textarea blur
                  onSelect(suggestion.username, activeMention.start, activeMention.end)
                  setSuggestions([])
                  setActiveMention(null)
                }}
                onMouseEnter={() => setSelectedIndex(index)}
                className={`w-full flex items-center gap-3 p-2 text-left transition-colors ${
                  index === selectedIndex
                    ? 'bg-yappr-50 dark:bg-yappr-900/30'
                    : 'hover:bg-surface-100 dark:hover:bg-surface-800'
                }`}
              >
                <div className="h-8 w-8 rounded-full overflow-hidden flex-shrink-0">
                  <UserAvatar
                    userId={suggestion.identityId}
                    size="sm"
                    alt={suggestion.displayName}
                  />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-sm truncate">
                    {suggestion.displayName}
                  </p>
                  <p className="text-xs text-gray-500 truncate">
                    @{suggestion.username}
                  </p>
                </div>
              </button>
            ))}
          </div>
        )}
      </motion.div>
    </AnimatePresence>
  )
}
