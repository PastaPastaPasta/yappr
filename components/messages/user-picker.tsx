'use client'

import { CheckIcon, MagnifyingGlassIcon } from '@heroicons/react/24/outline'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { UserAvatar } from '@/components/ui/avatar-image'
import { useFollowerSuggestions, useUserSearch, type UserSearchResult } from './use-user-search'

interface UserPickerProps {
  inputId: string
  query: string
  onQueryChange: (query: string) => void
  onPick: (user: UserSearchResult) => void
  viewerId: string | undefined
  disabled?: boolean
  /** Picked users are shown checked (multi-select). */
  selectedIds?: ReadonlySet<string>
  /** Users that cannot be picked (already members). */
  excludeIds?: ReadonlySet<string>
  hint?: string
}

/**
 * The people picker used by the new-message and group dialogs: followers
 * until three characters are typed, then a DPNS username search.
 */
export function UserPicker({ inputId, query, onQueryChange, onPick, viewerId, disabled, selectedIds, excludeIds, hint }: UserPickerProps) {
  const trimmed = query.trim()
  const { results, isSearching } = useUserSearch(query, viewerId)
  const { followers, isLoading: isLoadingFollowers } = useFollowerSuggestions(true, viewerId)
  // Below the 3-character search threshold we show the user's followers instead
  // of hitting DPNS; a 1-2 character query just filters that list locally.
  const showFollowers = trimmed.length < 3
  const needle = trimmed.toLowerCase()
  const visible = (list: UserSearchResult[]) => list.filter(user => !excludeIds?.has(user.id))
  const filteredFollowers = visible(needle
    ? followers.filter(f => f.username?.toLowerCase().includes(needle) || f.displayName.toLowerCase().includes(needle))
    : followers)

  const renderUser = (user: UserSearchResult) => {
    const selected = selectedIds?.has(user.id) ?? false
    return (
      <button
        key={user.id}
        type="button"
        onClick={() => onPick(user)}
        disabled={disabled}
        aria-pressed={selectedIds ? selected : undefined}
        className="w-full flex items-center gap-3 p-3 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors text-left border-b border-gray-100 dark:border-gray-800 last:border-b-0"
      >
        <div className="h-10 w-10 rounded-full overflow-hidden bg-gray-100 dark:bg-gray-800 flex-shrink-0">
          <UserAvatar userId={user.id} size="md" alt={user.displayName} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-semibold truncate">{user.displayName}</p>
          <p className="text-sm text-gray-500 truncate">
            {user.username ? `@${user.username}` : `${user.id.slice(0, 8)}...${user.id.slice(-4)}`}
          </p>
          {user.bio && <p className="text-xs text-gray-400 truncate mt-0.5">{user.bio}</p>}
        </div>
        {selected && <CheckIcon className="h-5 w-5 text-yappr-500 flex-shrink-0" aria-hidden="true" />}
      </button>
    )
  }

  return (
    <>
      <div className="mb-4">
        <label htmlFor={inputId} className="block text-sm font-medium mb-2 text-gray-700 dark:text-gray-300">
          Search for a user
        </label>
        <div className="relative">
          <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-400" />
          <Input
            id={inputId}
            aria-describedby={`${inputId}-hint`}
            type="text"
            placeholder="Search by username..."
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            disabled={disabled}
            autoFocus
            className="pl-10"
          />
        </div>
        <p id={`${inputId}-hint`} className="text-xs text-gray-500 mt-2">
          {hint ?? 'Type at least 3 characters to search, or paste a full identity ID'}
        </p>
      </div>

      {showFollowers && (
        <div className="mb-4 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
          <div className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-gray-500 bg-gray-50 dark:bg-gray-800/50 border-b border-gray-100 dark:border-gray-800">
            Your followers
          </div>
          {isLoadingFollowers ? (
            <div className="p-4 flex items-center justify-center gap-2 text-gray-500">
              <Spinner size="sm" className="border-gray-500" />
              <span className="text-sm">Loading followers...</span>
            </div>
          ) : filteredFollowers.length > 0 ? (
            <div className="max-h-64 overflow-y-auto">{filteredFollowers.map(renderUser)}</div>
          ) : (
            <p className="p-4 text-center text-sm text-gray-500">
              {followers.length === 0 ? 'No followers yet — search for a username above.' : `No followers matching "${trimmed}"`}
            </p>
          )}
        </div>
      )}

      {!showFollowers && (isSearching || results.length > 0) && (
        <div className="mb-4 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
          {isSearching ? (
            <div className="p-4 flex items-center justify-center gap-2 text-gray-500">
              <Spinner size="sm" className="border-gray-500" />
              <span className="text-sm">Searching...</span>
            </div>
          ) : (
            <div className="max-h-64 overflow-y-auto">{visible(results).map(renderUser)}</div>
          )}
        </div>
      )}

      {!isSearching && results.length === 0 && trimmed.length >= 3 && trimmed.length <= 30 && (
        <div className="mb-4 p-3 text-center text-sm text-gray-500 border border-gray-200 dark:border-gray-700 rounded-xl">
          No users found matching &quot;{trimmed}&quot;
        </div>
      )}
    </>
  )
}
