'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { XMarkIcon, ShieldCheckIcon, ChevronDownIcon, ChevronUpIcon } from '@heroicons/react/24/outline'
import { motion, AnimatePresence } from 'framer-motion'
import toast from 'react-hot-toast'
import { useAuth } from '@/contexts/auth-context'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { UserAvatar } from '@/components/ui/avatar-image'
import { proposalClaimService } from '@/lib/services/proposal-claim-service'
import type { Proposal } from '@/lib/types'
import { cn } from '@/lib/utils'

const CHARACTER_LIMIT = 500

interface GovernanceClaimModalProps {
  proposal: Proposal
  isOpen: boolean
  onClose: () => void
  onSuccess?: () => void
}

// Character counter component
function CharacterCounter({ current, limit }: { current: number; limit: number }) {
  const remaining = limit - current
  const percentage = Math.min((current / limit) * 100, 100)
  const isWarning = remaining <= 50 && remaining > 20
  const isDanger = remaining <= 20
  const isValid = current > 0 && current <= limit

  const radius = 10
  const circumference = 2 * Math.PI * radius
  const offset = circumference * (1 - percentage / 100)

  function getProgressColor(): string {
    if (isDanger) return 'text-red-500'
    if (isWarning) return 'text-amber-500'
    return 'text-blue-500'
  }

  if (current === 0) {
    return <div className="flex items-center gap-2" />
  }

  return (
    <div className="flex items-center gap-2">
      <div className="relative w-6 h-6">
        <svg className="w-6 h-6 -rotate-90" viewBox="0 0 24 24">
          <circle
            cx="12"
            cy="12"
            r={radius}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="text-gray-200 dark:text-gray-700"
          />
          <circle
            cx="12"
            cy="12"
            r={radius}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            strokeLinecap="round"
            className={getProgressColor()}
          />
        </svg>
        {isValid && !isDanger && !isWarning && (
          <div className="absolute inset-0 flex items-center justify-center">
            <svg className="w-3 h-3 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
        )}
      </div>
      {isDanger && (
        <span className={`text-xs font-medium tabular-nums ${remaining < 0 ? 'text-red-500' : 'text-amber-500'}`}>
          {remaining}
        </span>
      )}
    </div>
  )
}

export function GovernanceClaimModal({ proposal, isOpen, onClose, onSuccess }: GovernanceClaimModalProps) {
  const { user } = useAuth()
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const [content, setContent] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [proofMessage, setProofMessage] = useState('')
  const [proofSignature, setProofSignature] = useState('')

  // Focus textarea when modal opens
  useEffect(() => {
    if (isOpen && textareaRef.current) {
      setTimeout(() => textareaRef.current?.focus(), 100)
    }
  }, [isOpen])

  // Reset state when modal closes
  useEffect(() => {
    if (!isOpen) {
      setContent('')
      setShowAdvanced(false)
      setProofMessage('')
      setProofSignature('')
    }
  }, [isOpen])

  // Generate proof message
  const generateProof = useCallback(() => {
    const message = proposalClaimService.generateProofMessage(proposal.hash)
    setProofMessage(message)
  }, [proposal.hash])

  // Submit claim
  const handleSubmit = async () => {
    if (!user || !content.trim()) return

    setIsSubmitting(true)

    try {
      const result = await proposalClaimService.createClaim(user.identityId, {
        proposalHash: proposal.hash,
        postContent: content.trim(),
        proofMessage: proofMessage || undefined,
        proofSignature: proofSignature || undefined,
      })

      if (result.success) {
        toast.success('Proposal claimed successfully!')
        onSuccess?.()
        onClose()
      } else {
        toast.error(result.error || 'Failed to claim proposal')
      }
    } catch (error) {
      console.error('Failed to submit claim:', error)
      toast.error('Failed to claim proposal')
    } finally {
      setIsSubmitting(false)
    }
  }

  // Handle keyboard shortcuts
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault()
      if (canSubmit) {
        void handleSubmit()
      }
    }
  }

  const canSubmit = content.trim().length > 0 && content.length <= CHARACTER_LIMIT && !isSubmitting

  return (
    <Dialog.Root open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <AnimatePresence>
        {isOpen && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-start justify-center pt-12 sm:pt-20 px-4 overflow-y-auto pb-12"
              >
                <Dialog.Content asChild>
                  <motion.div
                    initial={{ opacity: 0, scale: 0.95, y: 20 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.95, y: 20 }}
                    transition={{ duration: 0.2, ease: 'easeOut' }}
                    className="w-full max-w-2xl bg-white dark:bg-neutral-900 rounded-2xl shadow-2xl overflow-hidden"
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={handleKeyDown}
                  >
                    {/* Accessibility */}
                    <Dialog.Title className="sr-only">
                      Claim Proposal: {proposal.name}
                    </Dialog.Title>
                    <Dialog.Description className="sr-only">
                      Write an introduction for your proposal and optionally provide cryptographic proof of authorship.
                    </Dialog.Description>

                    {/* Header */}
                    <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-neutral-950">
                      <div className="flex items-center gap-3">
                        <IconButton onClick={onClose} className="hover:bg-gray-200 dark:hover:bg-gray-800">
                          <XMarkIcon className="h-5 w-5" />
                        </IconButton>
                        <h2 className="font-semibold text-gray-900 dark:text-gray-100">
                          Claim Proposal
                        </h2>
                      </div>
                      <Button
                        onClick={handleSubmit}
                        disabled={!canSubmit}
                        className={cn(
                          'min-w-[100px] h-10 px-5 text-sm font-semibold transition-all',
                          canSubmit
                            ? 'bg-blue-500 hover:bg-blue-600 shadow-lg shadow-blue-500/25'
                            : 'bg-gray-300 dark:bg-gray-700 text-gray-500 dark:text-gray-400 cursor-not-allowed'
                        )}
                      >
                        {isSubmitting ? (
                          <span className="flex items-center gap-2">
                            <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                            </svg>
                            Claiming...
                          </span>
                        ) : (
                          'Claim'
                        )}
                      </Button>
                    </div>

                    {/* Proposal Info */}
                    <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-800 bg-blue-50 dark:bg-blue-950/30">
                      <div className="flex items-start gap-3">
                        <div className="p-2 rounded-lg bg-blue-100 dark:bg-blue-900/50">
                          <ShieldCheckIcon className="h-5 w-5 text-blue-600 dark:text-blue-400" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <h3 className="font-medium text-gray-900 dark:text-gray-100 truncate">
                            {proposal.name}
                          </h3>
                          <p className="text-sm text-gray-600 dark:text-gray-400">
                            {proposal.paymentAmountDash.toLocaleString()} DASH
                          </p>
                        </div>
                      </div>
                    </div>

                    {/* Main Content */}
                    <div className="p-4">
                      <div className="flex gap-3">
                        {/* User avatar */}
                        {user && (
                          <div className="flex-shrink-0">
                            <UserAvatar userId={user.identityId} size="lg" alt="Your avatar" />
                          </div>
                        )}

                        {/* Post composer */}
                        <div className="flex-1">
                          <p className="text-sm text-gray-600 dark:text-gray-400 mb-2">
                            Write an introduction for your proposal. This will appear as a post in the main feed and start the discussion thread.
                          </p>

                          <textarea
                            ref={textareaRef}
                            value={content}
                            onChange={(e) => setContent(e.target.value)}
                            placeholder="Introduce your proposal to the community..."
                            className="w-full min-h-[120px] text-base resize-none outline-none bg-transparent placeholder:text-gray-400 dark:placeholder:text-gray-600 border border-gray-200 dark:border-gray-700 rounded-lg p-3 focus:border-blue-500 dark:focus:border-blue-500 transition-colors"
                          />

                          {/* Character counter */}
                          <div className="flex items-center justify-between mt-2">
                            <div className="flex items-center gap-2 text-xs text-gray-400">
                              <code className="px-1 py-0.5 bg-gray-100 dark:bg-gray-800 rounded">**bold**</code>
                              <code className="px-1 py-0.5 bg-gray-100 dark:bg-gray-800 rounded">*italic*</code>
                            </div>
                            <CharacterCounter current={content.length} limit={CHARACTER_LIMIT} />
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Advanced Options (Proof Signature) */}
                    <div className="border-t border-gray-200 dark:border-gray-800">
                      <button
                        onClick={() => setShowAdvanced(!showAdvanced)}
                        className="w-full px-4 py-3 flex items-center justify-between text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-900/50 transition-colors"
                      >
                        <span className="flex items-center gap-2">
                          <ShieldCheckIcon className="h-4 w-4" />
                          Advanced: Cryptographic Proof (Optional)
                        </span>
                        {showAdvanced ? (
                          <ChevronUpIcon className="h-4 w-4" />
                        ) : (
                          <ChevronDownIcon className="h-4 w-4" />
                        )}
                      </button>

                      {showAdvanced && (
                        <div className="px-4 pb-4 space-y-4">
                          <p className="text-xs text-gray-500 dark:text-gray-400">
                            Prove you created this proposal by signing a message with the collateral key used to create the proposal on Dash Core.
                          </p>

                          {/* Proof Message */}
                          <div>
                            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                              Proof Message
                            </label>
                            <div className="flex gap-2">
                              <input
                                type="text"
                                value={proofMessage}
                                onChange={(e) => setProofMessage(e.target.value)}
                                placeholder="Generate or enter a message to sign"
                                className="flex-1 text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 bg-transparent focus:border-blue-500 dark:focus:border-blue-500 outline-none transition-colors"
                              />
                              <Button
                                onClick={generateProof}
                                variant="outline"
                                size="sm"
                                className="shrink-0"
                              >
                                Generate
                              </Button>
                            </div>
                          </div>

                          {/* Proof Signature */}
                          <div>
                            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                              Signature
                            </label>
                            <input
                              type="text"
                              value={proofSignature}
                              onChange={(e) => setProofSignature(e.target.value)}
                              placeholder="Paste the signature from Dash Core"
                              className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 bg-transparent focus:border-blue-500 dark:focus:border-blue-500 outline-none transition-colors font-mono"
                            />
                            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                              Sign the proof message using: <code className="bg-gray-100 dark:bg-gray-800 px-1 rounded">signmessage &lt;address&gt; &quot;{proofMessage || 'message'}&quot;</code>
                            </p>
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Footer */}
                    <div className="px-4 py-2 border-t border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-neutral-950">
                      <p className="text-xs text-gray-400 text-center">
                        Your claim will create a post visible to all users
                      </p>
                    </div>
                  </motion.div>
                </Dialog.Content>
              </motion.div>
            </Dialog.Overlay>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  )
}
