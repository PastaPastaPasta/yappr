'use client'

import { useState, useEffect } from 'react'
import { LockClosedIcon, GlobeAltIcon, EyeIcon } from '@heroicons/react/24/outline'
import { LockClosedIcon as LockClosedIconSolid } from '@heroicons/react/24/solid'
import type { PostVisibility } from '@/lib/store'

interface VisibilitySelectorProps {
  visibility: PostVisibility
  onVisibilityChange: (visibility: PostVisibility) => void
  hasPrivateFeed: boolean
  privateFeedLoading: boolean
  privateFollowerCount: number
  disabled?: boolean
  /** Called when user clicks a private visibility option but doesn't have a private feed */
  onEnablePrivateFeedRequest?: (targetVisibility: PostVisibility) => void
}

const TEASER_LIMIT = 280
const PRIVATE_CONTENT_LIMIT = 500

interface VisibilityOption {
  value: PostVisibility
  label: string
  description: string
  icon: React.ElementType
  requiresPrivateFeed: boolean
}

const visibilityOptions: VisibilityOption[] = [
  {
    value: 'public',
    label: 'Public',
    description: 'Visible to everyone',
    icon: GlobeAltIcon,
    requiresPrivateFeed: false,
  },
  {
    value: 'private',
    label: 'Private',
    description: 'Only private followers',
    icon: LockClosedIcon,
    requiresPrivateFeed: true,
  },
  {
    value: 'private-with-teaser',
    label: 'Private with Teaser',
    description: 'Teaser public, full content private',
    icon: EyeIcon,
    requiresPrivateFeed: true,
  },
]

export function VisibilitySelector({
  visibility,
  onVisibilityChange,
  hasPrivateFeed,
  privateFeedLoading,
  privateFollowerCount,
  disabled = false,
  onEnablePrivateFeedRequest,
}: VisibilitySelectorProps) {
  const [isExpanded, setIsExpanded] = useState(false)

  // Get current option
  const currentOption = visibilityOptions.find((o) => o.value === visibility) || visibilityOptions[0]
  const CurrentIcon = currentOption.icon
  const isPrivate = visibility === 'private' || visibility === 'private-with-teaser'

  // Handle option selection
  const handleSelect = (option: VisibilityOption) => {
    if (option.requiresPrivateFeed && !hasPrivateFeed) {
      // Trigger enable flow instead of blocking
      if (onEnablePrivateFeedRequest) {
        onEnablePrivateFeedRequest(option.value)
        setIsExpanded(false)
      }
      return
    }
    onVisibilityChange(option.value)
    setIsExpanded(false)
  }

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = () => setIsExpanded(false)
    if (isExpanded) {
      document.addEventListener('click', handleClickOutside)
      return () => document.removeEventListener('click', handleClickOutside)
    }
  }, [isExpanded])

  // Don't show if private feed is loading
  if (privateFeedLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-400">
        <div className="w-4 h-4 rounded-full border-2 border-gray-300 border-t-transparent animate-spin" />
        <span>Loading...</span>
      </div>
    )
  }

  return (
    <div className="relative">
      {/* Main selector button */}
      <button
        data-testid="visibility-selector"
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          setIsExpanded(!isExpanded)
        }}
        disabled={disabled}
        className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium transition-all ${
          isPrivate
            ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 hover:bg-amber-200 dark:hover:bg-amber-900/50'
            : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'
        } ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
      >
        <CurrentIcon className={`w-4 h-4 ${isPrivate ? 'text-amber-600 dark:text-amber-400' : ''}`} />
        <span>{currentOption.label}</span>
        <svg
          className={`w-3 h-3 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Dropdown menu */}
      {isExpanded && (
        <div
          onClick={(e) => e.stopPropagation()}
          className="absolute top-full left-0 mt-1 w-64 bg-white dark:bg-neutral-900 rounded-xl border border-gray-200 dark:border-gray-700 shadow-xl z-50 overflow-hidden"
        >
          {visibilityOptions.map((option) => {
            const Icon = option.icon
            const isDisabled = option.requiresPrivateFeed && !hasPrivateFeed
            const isSelected = option.value === visibility

            // Make the option clickable if we have an enable handler
            const canClick = !isDisabled || onEnablePrivateFeedRequest

            return (
              <button
                key={option.value}
                data-testid={`visibility-${option.value}`}
                type="button"
                onClick={() => handleSelect(option)}
                disabled={isDisabled && !onEnablePrivateFeedRequest}
                className={`w-full flex items-start gap-3 px-4 py-3 text-left transition-colors ${
                  isSelected
                    ? 'bg-yappr-50 dark:bg-yappr-900/20'
                    : 'hover:bg-gray-50 dark:hover:bg-gray-800'
                } ${isDisabled && !onEnablePrivateFeedRequest ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
              >
                <div
                  className={`mt-0.5 p-1.5 rounded-lg ${
                    isSelected
                      ? 'bg-yappr-100 dark:bg-yappr-900/40 text-yappr-600 dark:text-yappr-400'
                      : option.requiresPrivateFeed
                      ? 'bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400'
                      : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400'
                  }`}
                >
                  <Icon className="w-4 h-4" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span
                      className={`font-medium ${
                        isSelected ? 'text-yappr-600 dark:text-yappr-400' : 'text-gray-900 dark:text-gray-100'
                      }`}
                    >
                      {option.label}
                    </span>
                    {isSelected && (
                      <svg className="w-4 h-4 text-yappr-500" fill="currentColor" viewBox="0 0 20 20">
                        <path
                          fillRule="evenodd"
                          d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                          clipRule="evenodd"
                        />
                      </svg>
                    )}
                  </div>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{option.description}</p>
                  {isDisabled && (
                    <p className="text-xs text-yappr-500 dark:text-yappr-400 mt-1">
                      {onEnablePrivateFeedRequest ? 'Click to enable private feed' : 'Enable private feed first'}
                    </p>
                  )}
                </div>
              </button>
            )
          })}

          {/* Footer with follower info */}
          {isPrivate && privateFollowerCount === 0 && (
            <div data-testid="no-followers-warning" className="px-4 py-2 bg-amber-50 dark:bg-amber-900/20 border-t border-amber-100 dark:border-amber-800">
              <p className="text-xs text-amber-700 dark:text-amber-400">
                <LockClosedIconSolid className="w-3 h-3 inline-block mr-1" />
                You have no private followers yet. This post will only be visible to you.
              </p>
            </div>
          )}
          {isPrivate && privateFollowerCount > 0 && (
            <div className="px-4 py-2 bg-gray-50 dark:bg-gray-800/50 border-t border-gray-100 dark:border-gray-800">
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Visible to {privateFollowerCount} private follower{privateFollowerCount !== 1 ? 's' : ''}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export { TEASER_LIMIT, PRIVATE_CONTENT_LIMIT }
