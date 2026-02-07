'use client'

import { useState } from 'react'
import { ChevronDownIcon, ChevronUpIcon, DocumentTextIcon } from '@heroicons/react/24/outline'
import type { StorePolicy } from '@/lib/types'

interface PoliciesDisplayProps {
  policies: StorePolicy[]
}

export function PoliciesDisplay({ policies }: PoliciesDisplayProps) {
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

  const expandAll = () => {
    setExpandedIndexes(new Set(policies.map((_, i) => i)))
  }

  const collapseAll = () => {
    setExpandedIndexes(new Set())
  }

  if (policies.length === 0) {
    return (
      <div className="py-12 text-center">
        <DocumentTextIcon className="h-12 w-12 text-gray-300 mx-auto mb-3" />
        <p className="text-gray-500">This store has not configured any policies.</p>
      </div>
    )
  }

  return (
    <div className="p-4 space-y-4">
      {/* Expand/Collapse All */}
      {policies.length > 1 && (
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={expandAll}
            className="text-sm text-yappr-600 hover:text-yappr-700"
          >
            Expand all
          </button>
          <span className="text-gray-300">|</span>
          <button
            type="button"
            onClick={collapseAll}
            className="text-sm text-yappr-600 hover:text-yappr-700"
          >
            Collapse all
          </button>
        </div>
      )}

      {/* Policy Accordions */}
      <div className="space-y-3">
        {policies.map((policy, index) => {
          const isExpanded = expandedIndexes.has(index)

          return (
            <div
              key={index}
              className="border border-surface-200 dark:border-surface-700 rounded-lg overflow-hidden"
            >
              <button
                type="button"
                onClick={() => toggleExpanded(index)}
                className="w-full flex items-center justify-between px-4 py-3 bg-surface-50 dark:bg-surface-800/50 hover:bg-surface-100 dark:hover:bg-surface-800 transition-colors"
              >
                <span className="font-medium">{policy.name || 'Untitled Policy'}</span>
                {isExpanded ? (
                  <ChevronUpIcon className="h-5 w-5 text-gray-500" />
                ) : (
                  <ChevronDownIcon className="h-5 w-5 text-gray-500" />
                )}
              </button>

              {isExpanded && (
                <div className="px-4 py-3 bg-white dark:bg-surface-900">
                  <p className="text-surface-500 dark:text-surface-400 whitespace-pre-wrap">
                    {policy.content || 'No content provided.'}
                  </p>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
