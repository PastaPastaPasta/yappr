'use client'

import { logger } from '@/lib/logger'
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import * as Dialog from '@radix-ui/react-dialog'
import { Modal, ModalTitle } from '@/components/ui/modal'
import { XMarkIcon, ExclamationTriangleIcon, AtSymbolIcon } from '@heroicons/react/24/outline'
import { ExclamationCircleIcon } from '@heroicons/react/24/solid'
import toast from 'react-hot-toast'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useRecoveryModal } from '@/hooks/use-recovery-modal'
import { useAuth } from '@/contexts/auth-context'
import { hashtagService } from '@/lib/services/hashtag-service'
import { mentionService } from '@/lib/services/mention-service'
import { dpnsService } from '@/lib/services/dpns-service'
import { dispatchFieldRegistered, type PostFieldKind } from '@/lib/services/post-field-validation'

const COPY: Record<PostFieldKind, { noun: string; Noun: string; title: string; prefix: string; consequence: string }> = {
  hashtag: {
    noun: 'hashtag',
    Noun: 'Hashtag',
    title: 'Hashtag Not Registered',
    prefix: '#',
    consequence: "this post won't appear in hashtag searches for",
  },
  mention: {
    noun: 'mention',
    Noun: 'Mention',
    title: 'Mention Not Registered',
    prefix: '@',
    consequence: "this post won't appear when viewing posts that mention",
  },
}

/**
 * Offers the post author a retry when a hashtag or mention index document
 * failed to write alongside the post. A mention must first resolve to an
 * identity, since the index document stores the mentioned identity's id.
 */
export function RecoveryModal() {
  const { isOpen, kind, post, value, isRegistering, error, close, setRegistering, setError } = useRecoveryModal()
  const { user } = useAuth()
  const copy = COPY[kind]

  const [resolvedIdentityId, setResolvedIdentityId] = useState<string | null>(null)
  const [isResolving, setIsResolving] = useState(false)

  const isOwner = user?.identityId === post?.author.id
  const needsResolution = kind === 'mention'
  const canRegister = isOwner && (!needsResolution || resolvedIdentityId !== null)

  useEffect(() => {
    if (!isOpen || kind !== 'mention' || !value) {
      setResolvedIdentityId(null)
      setIsResolving(false)
      return
    }
    let cancelled = false
    setIsResolving(true)
    dpnsService
      .resolveIdentity(value)
      .then((id) => {
        if (!cancelled) setResolvedIdentityId(id)
      })
      .catch((err) => {
        logger.error('Failed to resolve username:', err)
        if (!cancelled) setResolvedIdentityId(null)
      })
      .finally(() => {
        if (!cancelled) setIsResolving(false)
      })
    return () => {
      cancelled = true
    }
  }, [isOpen, kind, value])

  const handleRegister = useCallback(async () => {
    if (!post || !value || !user || !canRegister) return
    setRegistering(true)
    setError(null)
    try {
      let success: boolean
      if (kind === 'hashtag') {
        success = await hashtagService.createPostHashtag(post.id, user.identityId, value)
      } else if (resolvedIdentityId) {
        success = await mentionService.createPostMention(post.id, user.identityId, resolvedIdentityId)
      } else {
        return
      }
      if (!success) {
        setError(`Failed to register ${copy.noun}. Please try again.`)
        return
      }
      dispatchFieldRegistered(kind, { postId: post.id, value })
      toast.success(`${copy.Noun} ${copy.prefix}${value} registered successfully!`)
      close()
    } catch (err) {
      logger.error(`Error registering ${copy.noun}:`, err)
      setError(err instanceof Error ? err.message : 'Unknown error occurred')
    } finally {
      setRegistering(false)
    }
  }, [post, value, user, canRegister, kind, resolvedIdentityId, copy, close, setRegistering, setError])

  const handleClose = () => {
    if (!isRegistering) close()
  }

  if (!post || !value) return null

  const valueHref =
    kind === 'hashtag'
      ? `/hashtag?tag=${encodeURIComponent(value)}`
      : resolvedIdentityId
        ? `/user?id=${encodeURIComponent(resolvedIdentityId)}`
        : null
  const valueLabel = kind === 'hashtag' ? `#${value}` : value

  return (
    <Modal open={isOpen} onOpenChange={handleClose} className="w-[420px] max-w-[90vw]">
                    <ModalTitle className="mb-4">
                      <ExclamationTriangleIcon className="h-6 w-6 text-amber-500" />
                      {copy.title}
                    </ModalTitle>

                    <Dialog.Description className="sr-only">
                      The {copy.noun} {copy.prefix}{value} was not properly registered for this post
                    </Dialog.Description>

                    <button
                      onClick={handleClose}
                      className="absolute top-4 right-4 p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors"
                      disabled={isRegistering}
                    >
                      <XMarkIcon className="h-5 w-5" />
                    </button>

                    {!isRegistering && !error && (
                      <div className="space-y-4">
                        <div className="flex items-center gap-2 p-3 bg-gray-50 dark:bg-neutral-800 rounded-lg">
                          {kind === 'mention' && <AtSymbolIcon className="h-5 w-5 text-yappr-500" />}
                          {valueHref ? (
                            <Link href={valueHref} className="font-mono text-lg font-medium text-yappr-500 hover:underline" onClick={close}>
                              {valueLabel}
                            </Link>
                          ) : (
                            <span className="font-mono text-lg font-medium text-yappr-500">{valueLabel}</span>
                          )}
                        </div>

                        <div className="text-gray-600 dark:text-gray-400 space-y-2">
                          <p>
                            This {copy.noun} wasn&apos;t properly registered when the post was created. This can happen
                            due to network issues.
                          </p>
                          <p className="text-sm">
                            Without registration, {copy.consequence}{' '}
                            {valueHref ? (
                              <Link href={valueHref} className="font-medium text-yappr-500 hover:underline" onClick={close}>
                                {copy.prefix}{value}
                              </Link>
                            ) : (
                              <span className="font-medium text-yappr-500">{copy.prefix}{value}</span>
                            )}
                            .
                          </p>
                        </div>

                        {isResolving && (
                          <div className="text-sm text-gray-500 flex items-center gap-2">
                            <Spinner size="sm" />
                            Resolving username...
                          </div>
                        )}

                        {needsResolution && !isResolving && !resolvedIdentityId && (
                          <div className="text-sm text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 p-3 rounded-lg">
                            Could not resolve @{value} to a user. The username may not exist on DPNS.
                          </div>
                        )}

                        {canRegister ? (
                          <div className="space-y-3 pt-2">
                            <p className="text-sm text-gray-500">Since you own this post, you can register the {copy.noun} now.</p>
                            <Button onClick={handleRegister} className="w-full bg-yappr-500 hover:bg-yappr-600 text-white">
                              Register {copy.Noun}
                            </Button>
                          </div>
                        ) : isOwner ? (
                          !isResolving && (
                            <div className="pt-2">
                              <Button onClick={close} variant="outline" className="w-full">
                                Close
                              </Button>
                            </div>
                          )
                        ) : (
                          <div className="pt-2">
                            <p className="text-sm text-gray-500 bg-gray-50 dark:bg-neutral-800 p-3 rounded-lg">
                              Only the post author can register this {copy.noun}. They can click the warning icon on
                              their post to fix it.
                            </p>
                            <Button onClick={close} variant="outline" className="w-full mt-3">
                              Got it
                            </Button>
                          </div>
                        )}
                      </div>
                    )}

                    {isRegistering && (
                      <div className="py-8 text-center space-y-4">
                        <Spinner size="lg" className="mx-auto" />
                        <p className="text-gray-600 dark:text-gray-400">Registering {copy.noun}...</p>
                        <p className="text-xs text-gray-500">Please wait, this may take a moment.</p>
                      </div>
                    )}

                    {error && !isRegistering && (
                      <div className="py-4 text-center space-y-4">
                        <ExclamationCircleIcon className="h-16 w-16 text-red-500 mx-auto" />
                        <div>
                          <p className="text-lg font-medium">Registration Failed</p>
                          <p className="text-red-500 text-sm">{error}</p>
                        </div>
                        <div className="flex gap-3">
                          <Button onClick={close} variant="outline" className="flex-1">
                            Close
                          </Button>
                          <Button onClick={() => setError(null)} className="flex-1 bg-yappr-500 hover:bg-yappr-600 text-white">
                            Try Again
                          </Button>
                        </div>
                      </div>
                    )}
    </Modal>
  )
}
