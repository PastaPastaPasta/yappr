'use client'

import { useState, useRef, useEffect } from 'react'
import { PlusIcon, TrashIcon, ChevronDownIcon } from '@heroicons/react/24/outline'
import type { StorePolicy } from '@/lib/types'
import {
  calculatePoliciesLength,
  MAX_POLICIES_LENGTH,
  SUGGESTED_POLICY_NAMES
} from '@/lib/utils/policies'

interface PoliciesEditorProps {
  policies: StorePolicy[]
  onChange: (policies: StorePolicy[]) => void
  maxLength?: number
}

export function PoliciesEditor({
  policies,
  onChange,
  maxLength = MAX_POLICIES_LENGTH
}: PoliciesEditorProps) {
  const [openSuggestionIndex, setOpenSuggestionIndex] = useState<number | null>(null)
  const suggestionRef = useRef<HTMLDivElement>(null)

  // Close suggestions on outside click
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (suggestionRef.current && !suggestionRef.current.contains(event.target as Node)) {
        setOpenSuggestionIndex(null)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const addPolicy = () => {
    onChange([...policies, { name: '', content: '' }])
  }

  const removePolicy = (index: number) => {
    onChange(policies.filter((_, i) => i !== index))
  }

  const updatePolicy = (index: number, field: 'name' | 'content', value: string) => {
    const updated = [...policies]
    updated[index] = { ...updated[index], [field]: value }
    onChange(updated)
  }

  const selectSuggestion = (index: number, name: string) => {
    updatePolicy(index, 'name', name)
    setOpenSuggestionIndex(null)
  }

  const currentLength = calculatePoliciesLength(policies)
  const isOverLimit = currentLength > maxLength

  // Filter out already-used policy names from suggestions
  const usedNames = new Set(policies.map(p => p.name.toLowerCase()))
  const getAvailableSuggestions = (currentIndex: number) => {
    const currentName = policies[currentIndex]?.name.toLowerCase() || ''
    return SUGGESTED_POLICY_NAMES.filter(
      name => !usedNames.has(name.toLowerCase()) || name.toLowerCase() === currentName
    )
  }

  return (
    <div className="space-y-4">
      {policies.length === 0 ? (
        <p className="text-sm text-gray-500">No policies defined. Click &quot;Add Policy&quot; to create one.</p>
      ) : (
        <div className="space-y-4">
          {policies.map((policy, index) => (
            <div
              key={index}
              className="p-4 border border-surface-200 dark:border-surface-700 rounded-lg space-y-3"
            >
              {/* Policy Name */}
              <div className="relative" ref={openSuggestionIndex === index ? suggestionRef : undefined}>
                <label className="block text-sm font-medium mb-1">Policy Name</label>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <input
                      type="text"
                      value={policy.name}
                      onChange={(e) => updatePolicy(index, 'name', e.target.value)}
                      onFocus={() => setOpenSuggestionIndex(index)}
                      placeholder="e.g., Return Policy"
                      maxLength={100}
                      className="w-full px-4 py-2 pr-10 border border-surface-200 dark:border-surface-700 rounded-lg bg-white dark:bg-surface-900 focus:outline-none focus:ring-2 focus:ring-yappr-500"
                    />
                    <button
                      type="button"
                      onClick={() => setOpenSuggestionIndex(openSuggestionIndex === index ? null : index)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-gray-600"
                    >
                      <ChevronDownIcon className="h-4 w-4" />
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => removePolicy(index)}
                    className="p-2 text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors"
                    title="Remove policy"
                  >
                    <TrashIcon className="h-5 w-5" />
                  </button>
                </div>

                {/* Suggestions dropdown */}
                {openSuggestionIndex === index && (
                  <div className="absolute z-10 mt-1 w-full bg-white dark:bg-surface-900 border border-surface-200 dark:border-surface-700 rounded-lg shadow-lg max-h-48 overflow-y-auto">
                    {getAvailableSuggestions(index).length > 0 ? (
                      getAvailableSuggestions(index).map((name) => (
                        <button
                          key={name}
                          type="button"
                          onClick={() => selectSuggestion(index, name)}
                          className="w-full px-4 py-2 text-left text-sm hover:bg-surface-50 dark:hover:bg-surface-800 first:rounded-t-lg last:rounded-b-lg"
                        >
                          {name}
                        </button>
                      ))
                    ) : (
                      <div className="px-4 py-2 text-sm text-gray-500">
                        All suggested names are in use
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Policy Content */}
              <div>
                <label className="block text-sm font-medium mb-1">Policy Content</label>
                <textarea
                  value={policy.content}
                  onChange={(e) => updatePolicy(index, 'content', e.target.value)}
                  placeholder="Describe this policy..."
                  rows={4}
                  className="w-full px-4 py-2 border border-surface-200 dark:border-surface-700 rounded-lg bg-white dark:bg-surface-900 focus:outline-none focus:ring-2 focus:ring-yappr-500 resize-none"
                />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add Policy Button */}
      <button
        type="button"
        onClick={addPolicy}
        className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-yappr-600 hover:text-yappr-700 hover:bg-yappr-50 dark:hover:bg-yappr-900/20 rounded-lg transition-colors"
      >
        <PlusIcon className="h-4 w-4" />
        Add Policy
      </button>

      {/* Character Counter */}
      {policies.length > 0 && (
        <div className={`text-sm ${isOverLimit ? 'text-red-500' : 'text-gray-500'}`}>
          Character count: {currentLength.toLocaleString()} / {maxLength.toLocaleString()}
          {isOverLimit && (
            <span className="ml-2 font-medium">
              (Over limit by {(currentLength - maxLength).toLocaleString()} characters)
            </span>
          )}
        </div>
      )}
    </div>
  )
}
