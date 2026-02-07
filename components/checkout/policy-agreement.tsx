'use client'

import { useState } from 'react'
import { ChevronDownIcon, ChevronUpIcon, InformationCircleIcon, CheckIcon } from '@heroicons/react/24/outline'
import { Button } from '@/components/ui/button'
import type { StorePolicy } from '@/lib/types'

interface PolicyAgreementProps {
  policies: StorePolicy[]
  agreedIndexes: Set<number>
  onAgreementChange: (index: number, agreed: boolean) => void
  onSubmit: () => void
}

export function PolicyAgreement({
  policies,
  agreedIndexes,
  onAgreementChange,
  onSubmit
}: PolicyAgreementProps) {
  const [expandedIndexes, setExpandedIndexes] = useState<Set<number>>(new Set())

  const toggleExpanded = (index: number) => {
    setExpandedIndexes((prev) => {
      const next = new Set(prev)
      if (next.has(index)) {
        next.delete(index)
      } else {
        next.add(index)
      }
      return next
    })
  }

  const allAgreed = policies.length === 0 || policies.every((_, i) => agreedIndexes.has(i))

  const handleAgreeAll = () => {
    if (allAgreed) {
      // Uncheck all
      policies.forEach((_, i) => onAgreementChange(i, false))
    } else {
      // Check all
      policies.forEach((_, i) => onAgreementChange(i, true))
    }
  }

  // If no policies, show info message and allow proceeding
  if (policies.length === 0) {
    return (
      <div className="p-4 space-y-6">
        <div className="flex items-start gap-3 p-4 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
          <InformationCircleIcon className="h-5 w-5 text-blue-500 flex-shrink-0 mt-0.5" />
          <div className="text-sm text-blue-700 dark:text-blue-300">
            <p className="font-medium">No Store Policies</p>
            <p className="mt-1">
              This store has not configured any policies. You may proceed with your order.
            </p>
          </div>
        </div>

        <Button onClick={onSubmit} className="w-full">
          Continue to Review
        </Button>
      </div>
    )
  }

  return (
    <div className="p-4 space-y-6">
      <div>
        <h2 className="text-lg font-semibold mb-2">Store Policies</h2>
        <p className="text-sm text-gray-500">
          Please review and agree to the store&apos;s policies before placing your order.
        </p>
      </div>

      {/* Policies List */}
      <div className="space-y-3">
        {policies.map((policy, index) => {
          const isExpanded = expandedIndexes.has(index)
          const isAgreed = agreedIndexes.has(index)

          return (
            <div
              key={index}
              className="border border-surface-200 dark:border-surface-700 rounded-lg overflow-hidden"
            >
              {/* Policy Header */}
              <button
                type="button"
                onClick={() => toggleExpanded(index)}
                className="w-full flex items-center justify-between px-4 py-3 bg-surface-50 dark:bg-surface-800/50 hover:bg-surface-100 dark:hover:bg-surface-800 transition-colors"
              >
                <span className="font-medium">{policy.name || 'Store Policy'}</span>
                {isExpanded ? (
                  <ChevronUpIcon className="h-5 w-5 text-gray-500" />
                ) : (
                  <ChevronDownIcon className="h-5 w-5 text-gray-500" />
                )}
              </button>

              {/* Policy Content (expanded) */}
              {isExpanded && (
                <div className="px-4 py-3 bg-white dark:bg-surface-900 border-t border-surface-200 dark:border-surface-700">
                  <p className="text-surface-500 dark:text-surface-400 whitespace-pre-wrap text-sm">
                    {policy.content || 'No content provided.'}
                  </p>
                </div>
              )}

              {/* Agreement Checkbox */}
              <div className="px-4 py-3 border-t border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-900">
                <label className="flex items-center gap-3 cursor-pointer">
                  <div className="relative">
                    <input
                      type="checkbox"
                      checked={isAgreed}
                      onChange={(e) => onAgreementChange(index, e.target.checked)}
                      className="sr-only"
                    />
                    <div
                      className={`w-5 h-5 rounded border-2 flex items-center justify-center transition-colors ${
                        isAgreed
                          ? 'bg-yappr-500 border-yappr-500'
                          : 'border-surface-200 dark:border-surface-600'
                      }`}
                    >
                      {isAgreed && <CheckIcon className="h-3.5 w-3.5 text-white" />}
                    </div>
                  </div>
                  <span className="text-sm">
                    I have read and agree to <strong>{policy.name || 'this policy'}</strong>
                  </span>
                </label>
              </div>
            </div>
          )
        })}
      </div>

      {/* Agree to All */}
      {policies.length > 1 && (
        <label className="flex items-center gap-3 cursor-pointer p-3 bg-surface-50 dark:bg-surface-800/50 rounded-lg">
          <div className="relative">
            <input
              type="checkbox"
              checked={allAgreed}
              onChange={handleAgreeAll}
              className="sr-only"
            />
            <div
              className={`w-5 h-5 rounded border-2 flex items-center justify-center transition-colors ${
                allAgreed
                  ? 'bg-yappr-500 border-yappr-500'
                  : 'border-surface-200 dark:border-surface-600'
              }`}
            >
              {allAgreed && <CheckIcon className="h-3.5 w-3.5 text-white" />}
            </div>
          </div>
          <span className="text-sm font-medium">I agree to all store policies</span>
        </label>
      )}

      <Button onClick={onSubmit} disabled={!allAgreed} className="w-full">
        Continue to Review
      </Button>
    </div>
  )
}
