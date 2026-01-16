'use client'

import { useState } from 'react'
import { ChevronDownIcon } from '@heroicons/react/24/outline'
import toast from 'react-hot-toast'

interface UsernameDropdownProps {
  username: string
  allUsernames: string[]
}

export function UsernameDropdown({ username, allUsernames }: UsernameDropdownProps): React.ReactNode {
  const [isOpen, setIsOpen] = useState(false)

  if (allUsernames.length <= 1) {
    return <p className="text-gray-500">@{username}</p>
  }

  function handleCopyUsername(name: string): void {
    navigator.clipboard.writeText(name).catch(console.error)
    toast.success(`Copied @${name}`)
    setIsOpen(false)
  }

  return (
    <div className="relative inline-block">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1 text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
      >
        <span>@{username}</span>
        <ChevronDownIcon
          className={`h-4 w-4 transition-transform ${isOpen ? 'rotate-180' : ''}`}
        />
        <span className="text-xs bg-gray-200 dark:bg-gray-700 px-1.5 py-0.5 rounded-full">
          +{allUsernames.length - 1}
        </span>
      </button>

      {isOpen && (
        <>
          <div
            className="fixed inset-0 z-10"
            onClick={() => setIsOpen(false)}
          />
          <div className="absolute top-full left-0 mt-1 z-20 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg py-1 min-w-[160px]">
            {allUsernames.map((name, index) => (
              <button
                key={name}
                onClick={() => handleCopyUsername(name)}
                className="w-full text-left px-3 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2"
              >
                <span className="text-gray-500">@{name}</span>
                {index === 0 && (
                  <span className="text-xs bg-yappr-100 dark:bg-yappr-900 text-yappr-600 dark:text-yappr-400 px-1.5 py-0.5 rounded">
                    primary
                  </span>
                )}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
