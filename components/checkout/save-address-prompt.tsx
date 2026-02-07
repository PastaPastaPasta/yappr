'use client'

import { useState } from 'react'
import { BookmarkIcon, LockClosedIcon } from '@heroicons/react/24/outline'
import { Button } from '@/components/ui/button'

interface SaveAddressPromptProps {
  onSave: (label: string) => void
  onSkip: () => void
  isSaving?: boolean
  hasEncryptionKey: boolean
  onSetupEncryption?: () => void
}

const LABEL_SUGGESTIONS = ['Home', 'Work', 'Other']

export function SaveAddressPrompt({
  onSave,
  onSkip,
  isSaving,
  hasEncryptionKey,
  onSetupEncryption
}: SaveAddressPromptProps) {
  const [label, setLabel] = useState('')
  const [showCustom, setShowCustom] = useState(false)

  const handleSave = () => {
    const finalLabel = label.trim() || 'Home'
    onSave(finalLabel)
  }

  const handleSuggestionClick = (suggestion: string) => {
    if (suggestion === 'Other') {
      setShowCustom(true)
      setLabel('')
    } else {
      setLabel(suggestion)
    }
  }

  // If user doesn't have an encryption key, show setup prompt
  if (!hasEncryptionKey) {
    return (
      <div className="p-4 bg-amber-50 dark:bg-amber-900/20 border-y border-amber-200 dark:border-amber-800">
        <div className="flex items-start gap-3">
          <LockClosedIcon className="h-5 w-5 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="font-medium text-amber-800 dark:text-amber-200">
              Save address for future orders?
            </p>
            <p className="text-sm text-amber-700 dark:text-amber-300 mt-1">
              To save your address securely, you need to set up an encryption key.
              Your addresses will be encrypted so only you can access them.
            </p>
            <div className="flex gap-2 mt-3">
              {onSetupEncryption && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onSetupEncryption}
                  className="border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-300"
                >
                  <LockClosedIcon className="h-4 w-4 mr-1.5" />
                  Add Encryption Key
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={onSkip}
                className="text-amber-600 dark:text-amber-400"
              >
                Skip for now
              </Button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="p-4 bg-surface-50 dark:bg-surface-900/50 border-y border-surface-200 dark:border-surface-800">
      <div className="flex items-start gap-3">
        <BookmarkIcon className="h-5 w-5 text-yappr-500 flex-shrink-0 mt-0.5" />
        <div className="flex-1">
          <p className="font-medium">Save this address?</p>
          <p className="text-sm text-gray-500 mt-0.5">
            Save for faster checkout next time. Your address is encrypted.
          </p>

          <div className="mt-3">
            {!showCustom ? (
              <div className="flex flex-wrap gap-2">
                {LABEL_SUGGESTIONS.map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    onClick={() => handleSuggestionClick(suggestion)}
                    className={`px-3 py-1.5 rounded-full text-sm border transition-colors ${
                      label === suggestion
                        ? 'border-yappr-500 bg-yappr-50 dark:bg-yappr-950/30 text-yappr-700 dark:text-yappr-300'
                        : 'border-surface-200 dark:border-surface-700 hover:border-surface-200 dark:hover:border-gray-600'
                    }`}
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            ) : (
              <input
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Enter a label..."
                className="w-full px-3 py-2 text-sm border border-surface-200 dark:border-surface-700 rounded-lg bg-white dark:bg-surface-900 focus:outline-none focus:ring-2 focus:ring-yappr-500"
                autoFocus
              />
            )}
          </div>

          <div className="flex gap-2 mt-3">
            <Button
              size="sm"
              onClick={handleSave}
              disabled={isSaving}
            >
              {isSaving ? 'Saving...' : 'Save Address'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={onSkip}
              disabled={isSaving}
            >
              Skip
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
