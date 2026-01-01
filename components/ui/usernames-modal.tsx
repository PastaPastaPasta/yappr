'use client'

import { Fragment } from 'react'
import { Dialog, Transition } from '@headlessui/react'
import { XMarkIcon } from '@heroicons/react/24/outline'
import { WasmSdk } from '@dashevo/wasm-sdk'

// Helper wrapper for DPNS utility function
const dpns_is_contested_username = (label: string): boolean => WasmSdk.dpnsIsContestedUsername(label);

interface UsernamesModalProps {
  isOpen: boolean
  onClose: () => void
  usernames: string[]
  primaryUsername: string
  identityId: string
}

export function UsernamesModal({ isOpen, onClose, usernames, primaryUsername, identityId }: UsernamesModalProps) {
  // Sort usernames with contested ones first
  const sortedUsernames = [...usernames].sort((a, b) => {
    const aContested = dpns_is_contested_username(a.split('.')[0])
    const bContested = dpns_is_contested_username(b.split('.')[0])
    
    if (aContested && !bContested) return -1
    if (!aContested && bContested) return 1
    
    // Put primary username first if both have same contested status
    if (a === primaryUsername) return -1
    if (b === primaryUsername) return 1
    
    return a.localeCompare(b)
  })

  return (
    <Transition.Root show={isOpen} as={Fragment}>
      <Dialog as="div" className="relative z-50" onClose={onClose}>
        <Transition.Child
          as={Fragment}
          enter="ease-out duration-300"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="ease-in duration-200"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <div className="fixed inset-0 bg-black/50 transition-opacity" />
        </Transition.Child>

        <div className="fixed inset-0 z-10 overflow-y-auto">
          <div className="flex min-h-full items-center justify-center p-4 text-center sm:p-0">
            <Transition.Child
              as={Fragment}
              enter="ease-out duration-300"
              enterFrom="opacity-0 translate-y-4 sm:translate-y-0 sm:scale-95"
              enterTo="opacity-100 translate-y-0 sm:scale-100"
              leave="ease-in duration-200"
              leaveFrom="opacity-100 translate-y-0 sm:scale-100"
              leaveTo="opacity-0 translate-y-4 sm:translate-y-0 sm:scale-95"
            >
              <Dialog.Panel className="relative transform overflow-hidden rounded-lg bg-white dark:bg-gray-900 px-4 pb-4 pt-5 text-left shadow-xl transition-all sm:my-8 sm:w-full sm:max-w-sm sm:p-6">
                <div className="absolute right-0 top-0 pr-4 pt-4">
                  <button
                    type="button"
                    className="rounded-md bg-white dark:bg-gray-900 text-gray-400 hover:text-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:ring-offset-2"
                    onClick={onClose}
                  >
                    <span className="sr-only">Close</span>
                    <XMarkIcon className="h-6 w-6" aria-hidden="true" />
                  </button>
                </div>
                <div>
                  <Dialog.Title as="h3" className="text-lg font-semibold leading-6 text-gray-900 dark:text-white mb-4">
                    All Usernames
                  </Dialog.Title>
                  <div className="mb-4 p-3 bg-gray-50 dark:bg-gray-800 rounded-lg">
                    <p className="text-xs text-gray-500 dark:text-gray-400">Identity ID</p>
                    <p className="text-sm font-mono text-gray-900 dark:text-white break-all">{identityId}</p>
                  </div>
                  <div className="space-y-2">
                    {sortedUsernames.map((username, index) => {
                      const isContested = dpns_is_contested_username(username.split('.')[0])
                      const isPrimary = username === primaryUsername
                      
                      return (
                        <div
                          key={username}
                          className={`flex items-center justify-between px-3 py-2 rounded-lg ${
                            isPrimary ? 'bg-purple-50 dark:bg-purple-900/20' : 'bg-gray-50 dark:bg-gray-800'
                          }`}
                        >
                          <span className="text-sm font-medium text-gray-900 dark:text-white">
                            @{username}
                          </span>
                          <div className="flex items-center gap-2">
                            {isPrimary && (
                              <span className="text-xs bg-purple-100 dark:bg-purple-900 text-purple-700 dark:text-purple-300 px-2 py-1 rounded">
                                Primary
                              </span>
                            )}
                            {isContested && (
                              <span className="text-xs bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 px-2 py-1 rounded">
                                Contested
                              </span>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              </Dialog.Panel>
            </Transition.Child>
          </div>
        </div>
      </Dialog>
    </Transition.Root>
  )
}