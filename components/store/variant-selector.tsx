'use client'

import { useMemo } from 'react'
import { storeItemService } from '@/lib/services/store-item-service'
import type { StoreItem } from '@/lib/types'

interface VariantSelectorProps {
  item: StoreItem
  selections: Record<string, string>
  onChange: (axisName: string, value: string) => void
  className?: string
}

export function VariantSelector({ item, selections, onChange, className }: VariantSelectorProps) {
  // Get available options for each axis based on current selections
  const axes = useMemo(() => {
    if (!item.variants?.axes) return []

    return item.variants.axes.map((axis, index) => {
      // For first axis, all options are available
      // For subsequent axes, filter based on prior selections
      const priorSelections: Record<string, string> = {}
      for (let i = 0; i < index; i++) {
        const priorAxis = item.variants!.axes[i]
        if (selections[priorAxis.name]) {
          priorSelections[priorAxis.name] = selections[priorAxis.name]
        }
      }

      const availableOptions = storeItemService.getAxisOptions(item, axis.name, priorSelections)

      return {
        ...axis,
        availableOptions
      }
    })
  }, [item, selections])

  if (axes.length === 0) {
    return null
  }

  return (
    <div className={`space-y-4 ${className || ''}`}>
      {axes.map((axis) => (
        <div key={axis.name}>
          <label className="block text-sm font-medium mb-2">
            {axis.name}
            {selections[axis.name] && (
              <span className="font-normal text-gray-500 ml-1">
                : {selections[axis.name]}
              </span>
            )}
          </label>
          <div className="flex flex-wrap gap-2">
            {axis.options.map((option) => {
              const isSelected = selections[axis.name] === option
              const isAvailable = axis.availableOptions.includes(option)

              return (
                <button
                  key={option}
                  type="button"
                  onClick={() => isAvailable && onChange(axis.name, option)}
                  disabled={!isAvailable}
                  className={`px-4 py-2 rounded-lg border text-sm font-medium transition-colors ${
                    isSelected
                      ? 'border-yappr-500 bg-yappr-50 dark:bg-yappr-900/20 text-yappr-600'
                      : isAvailable
                        ? 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600'
                        : 'border-gray-200 dark:border-gray-700 opacity-40 cursor-not-allowed line-through text-gray-400'
                  }`}
                >
                  {option}
                </button>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}
