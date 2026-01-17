'use client'

import { useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { XMarkIcon, ClipboardDocumentIcon, CheckIcon, ArrowTopRightOnSquareIcon } from '@heroicons/react/24/outline'
import { motion, AnimatePresence } from 'framer-motion'
import toast from 'react-hot-toast'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { cn } from '@/lib/utils'

type VoteOutcome = 'yes' | 'no' | 'abstain'

interface GovernanceMNVoteModalProps {
  proposalHash: string
  proposalName: string
  isOpen: boolean
  onClose: () => void
}

const VOTE_OPTIONS: { value: VoteOutcome; label: string; description: string; color: string }[] = [
  {
    value: 'yes',
    label: 'Yes',
    description: 'Support this proposal',
    color: 'bg-green-100 dark:bg-green-900/30 border-green-500 text-green-700 dark:text-green-400',
  },
  {
    value: 'no',
    label: 'No',
    description: 'Oppose this proposal',
    color: 'bg-red-100 dark:bg-red-900/30 border-red-500 text-red-700 dark:text-red-400',
  },
  {
    value: 'abstain',
    label: 'Abstain',
    description: 'Neither support nor oppose',
    color: 'bg-gray-100 dark:bg-gray-800 border-gray-400 text-gray-700 dark:text-gray-400',
  },
]

const DASH_GOVERNANCE_DOCS = 'https://docs.dash.org/en/stable/masternodes/understanding.html#voting-on-proposals'

export function GovernanceMNVoteModal({
  proposalHash,
  proposalName,
  isOpen,
  onClose,
}: GovernanceMNVoteModalProps) {
  const [selectedVote, setSelectedVote] = useState<VoteOutcome>('yes')
  const [copied, setCopied] = useState(false)

  // Generate the vote command
  const voteCommand = `gobject vote-many ${proposalHash} funding ${selectedVote}`

  // Copy command to clipboard
  const copyCommand = async () => {
    try {
      await navigator.clipboard.writeText(voteCommand)
      setCopied(true)
      toast.success('Command copied to clipboard!')
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy:', err)
      toast.error('Failed to copy command')
    }
  }

  return (
    <Dialog.Root open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <AnimatePresence>
        {isOpen && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild>
              <motion.div
                className="fixed inset-0 bg-black/50 z-50"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
              />
            </Dialog.Overlay>

            <Dialog.Content
              asChild
              onPointerDownOutside={(e) => e.preventDefault()}
              onClick={(e) => e.stopPropagation()}
            >
              <motion.div
                className="fixed inset-0 z-50 flex items-center justify-center p-4"
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                transition={{ duration: 0.2 }}
              >
                <div className="bg-white dark:bg-gray-950 rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto border border-gray-200 dark:border-gray-800">
                  {/* Header */}
                  <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-800">
                    <Dialog.Title className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                      Vote as Masternode
                    </Dialog.Title>
                    <Dialog.Close asChild>
                      <IconButton aria-label="Close">
                        <XMarkIcon className="h-5 w-5" />
                      </IconButton>
                    </Dialog.Close>
                  </div>

                  {/* Content */}
                  <div className="p-4 space-y-6">
                    {/* Proposal Info */}
                    <div className="p-3 bg-gray-50 dark:bg-gray-900 rounded-lg">
                      <span className="text-sm text-gray-500 dark:text-gray-400">Proposal</span>
                      <p className="font-medium text-gray-900 dark:text-gray-100 line-clamp-2">
                        {proposalName}
                      </p>
                    </div>

                    {/* Vote Selection */}
                    <div>
                      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
                        Select your vote
                      </label>
                      <div className="grid grid-cols-3 gap-3">
                        {VOTE_OPTIONS.map((option) => (
                          <button
                            key={option.value}
                            onClick={() => setSelectedVote(option.value)}
                            className={cn(
                              'p-3 rounded-lg border-2 transition-all duration-200',
                              selectedVote === option.value
                                ? option.color
                                : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600'
                            )}
                          >
                            <div className="text-center">
                              <span className={cn(
                                'text-lg font-semibold block',
                                selectedVote === option.value
                                  ? ''
                                  : 'text-gray-900 dark:text-gray-100'
                              )}>
                                {option.label}
                              </span>
                              <span className={cn(
                                'text-xs',
                                selectedVote === option.value
                                  ? 'opacity-80'
                                  : 'text-gray-500 dark:text-gray-400'
                              )}>
                                {option.description}
                              </span>
                            </div>
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Generated Command */}
                    <div>
                      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                        Vote command
                      </label>
                      <div className="relative">
                        <code className="block w-full p-3 pr-12 text-sm font-mono bg-gray-900 text-green-400 rounded-lg overflow-x-auto whitespace-nowrap">
                          {voteCommand}
                        </code>
                        <button
                          onClick={copyCommand}
                          className="absolute top-1/2 right-2 -translate-y-1/2 p-2 rounded-md hover:bg-gray-800 transition-colors"
                          title="Copy command"
                        >
                          {copied ? (
                            <CheckIcon className="h-5 w-5 text-green-400" />
                          ) : (
                            <ClipboardDocumentIcon className="h-5 w-5 text-gray-400" />
                          )}
                        </button>
                      </div>
                    </div>

                    {/* Instructions */}
                    <div className="space-y-3 text-sm text-gray-600 dark:text-gray-400">
                      <p className="font-medium text-gray-700 dark:text-gray-300">
                        How to vote:
                      </p>
                      <ol className="list-decimal list-inside space-y-2 pl-1">
                        <li>Copy the command above</li>
                        <li>Open your Dash Core wallet with console access</li>
                        <li>Go to <span className="font-mono text-xs bg-gray-100 dark:bg-gray-800 px-1 py-0.5 rounded">Help → Debug window → Console</span></li>
                        <li>Paste the command and press Enter</li>
                      </ol>
                      <p className="text-xs text-gray-500 dark:text-gray-500 italic">
                        Note: This command votes with all masternodes controlled by your wallet.
                        Use <span className="font-mono">gobject vote-conf</span> to vote with a specific masternode.
                      </p>
                    </div>

                    {/* Documentation Link */}
                    <a
                      href={DASH_GOVERNANCE_DOCS}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-2 text-sm text-blue-600 dark:text-blue-400 hover:underline"
                    >
                      <ArrowTopRightOnSquareIcon className="h-4 w-4" />
                      Learn more about masternode voting
                    </a>
                  </div>

                  {/* Footer */}
                  <div className="flex items-center justify-end gap-3 p-4 border-t border-gray-200 dark:border-gray-800">
                    <Button
                      variant="secondary"
                      onClick={onClose}
                    >
                      Close
                    </Button>
                    <Button
                      variant="default"
                      onClick={copyCommand}
                    >
                      {copied ? 'Copied!' : 'Copy Command'}
                    </Button>
                  </div>
                </div>
              </motion.div>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>

      {/* Hidden description for accessibility */}
      <Dialog.Description className="sr-only">
        Generate a vote command for this governance proposal to run in your Dash Core wallet.
      </Dialog.Description>
    </Dialog.Root>
  )
}
