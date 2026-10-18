'use client'

import { useEffect, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Modal, ModalTitle } from '@/components/ui/modal'
import { Button } from '@/components/ui/button'
import { ArrowPathIcon, XMarkIcon } from '@heroicons/react/24/outline'
import { Loader2 } from 'lucide-react'
import { logger } from '@/lib/logger'
import type { RenewalEstimate } from '@/lib/services/private-feed-move'

interface RenewPrivateFeedDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  ownerId: string
  /** Why the owner is here: shapes the first line only. */
  reason?: 'choice' | 'key-changed' | 'full'
  /** Start the renewal; the dialog closes and the settings card shows the move. */
  onConfirm: (bringHistory: boolean) => void
}

function formatUsd(usd: number): string {
  return usd < 0.01 ? 'less than $0.01' : `$${usd.toFixed(2)}`
}

const INTRO: Record<NonNullable<RenewPrivateFeedDialogProps['reason']>, string> = {
  choice: 'Renewing gives your private feed new keys. Everyone who follows you privately is moved over automatically.',
  'key-changed': 'Your messaging key changed, so your private feed needs new keys. Everyone who follows you privately is moved over automatically.',
  full: 'Your private feed is nearly out of room. Renewing gives it new keys and room to grow, and moves everyone who follows you privately.',
}

const HISTORY_CHOICES = [
  { bringHistory: true, title: 'Yes', description: 'Your followers, and anyone you approve later, can read your older private posts.' },
  { bringHistory: false, title: 'No, start fresh', description: 'Only people who already follow you keep seeing your older private posts.' },
]

/**
 * Renew the private feed (PF3, PF5, PF9): the cost of moving the followers,
 * and whether older private posts come along. Without the old feed's secret
 * on this device there is no choice: older posts stay with the people who
 * already follow.
 */
export function RenewPrivateFeedDialog({ open, onOpenChange, ownerId, reason = 'choice', onConfirm }: RenewPrivateFeedDialogProps) {
  const [estimate, setEstimate] = useState<RenewalEstimate | null>(null)
  // 'no' only when the old feed's secret is out of reach for good (PF5); otherwise the renewal finds out.
  const [canLink, setCanLink] = useState<'yes' | 'no' | 'unknown' | null>(null)
  const [bringHistory, setBringHistory] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoadFailed(false)
    setEstimate(null)
    setCanLink(null)
    setBringHistory(true)
    const load = async () => {
      const { estimateRenewal, canBringHistory } = await import('@/lib/services/private-feed-move')
      const { getEncryptionKeyBytes } = await import('@/lib/secure-storage')
      const [cost, link] = await Promise.all([estimateRenewal(ownerId), canBringHistory(ownerId, getEncryptionKeyBytes(ownerId) ?? undefined)])
      if (cancelled) return
      setEstimate(cost)
      setCanLink(link)
      setBringHistory(link !== 'no')
    }
    load().catch((error) => {
      logger.error('Could not prepare the private feed renewal:', error)
      if (!cancelled) setLoadFailed(true)
    })
    return () => {
      cancelled = true
    }
  }, [open, ownerId, attempt])

  const ready = estimate !== null && canLink !== null

  return (
    <Modal open={open} onOpenChange={onOpenChange} className="w-[500px] max-w-[90vw] max-h-[90vh] overflow-y-auto">
      <button
        type="button"
        onClick={() => onOpenChange(false)}
        aria-label="Close"
        className="absolute top-4 right-4 p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors"
      >
        <XMarkIcon className="h-5 w-5" />
      </button>
      <ModalTitle>
        <ArrowPathIcon className="h-6 w-6" />
        Renew your private feed
      </ModalTitle>
      <Dialog.Description className="text-sm text-gray-600 dark:text-gray-400 mb-4">{INTRO[reason]}</Dialog.Description>

      {loadFailed ? (
        <div className="space-y-3 text-sm text-gray-700 dark:text-gray-300" data-testid="renew-load-failed">
          <p>We couldn&apos;t work out what renewing costs right now.</p>
          <Button variant="outline" size="sm" onClick={() => setAttempt((n) => n + 1)}>Try again</Button>
        </div>
      ) : !ready ? (
        <div className="space-y-3" data-testid="renew-loading">
          <div className="h-16 bg-gray-100 dark:bg-gray-800 rounded-lg animate-pulse" />
          <div className="h-10 bg-gray-100 dark:bg-gray-800 rounded-lg animate-pulse" />
        </div>
      ) : (
        <div className="space-y-4 text-sm text-gray-700 dark:text-gray-300">
          {canLink !== 'no' ? (
            <fieldset className="space-y-2">
              <legend className="font-medium mb-2">Bring your older private posts along?</legend>
              {HISTORY_CHOICES.map((choice) => (
                <label key={choice.title} className="flex gap-3 p-3 rounded-lg border border-gray-200 dark:border-gray-700 cursor-pointer has-[:checked]:border-yappr-500">
                  <input type="radio" name="bring-history" className="mt-1" checked={bringHistory === choice.bringHistory} onChange={() => setBringHistory(choice.bringHistory)} />
                  <span>
                    <span className="block font-medium">{choice.title}</span>
                    <span className="block text-gray-500 dark:text-gray-400">{choice.description}</span>
                  </span>
                </label>
              ))}
            </fieldset>
          ) : (
            <p className="bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-200 p-3 rounded-lg" data-testid="renew-history-break">
              Posts from before this change stay visible only to people who already follow you.
            </p>
          )}

          <div className="bg-gray-50 dark:bg-gray-900 p-3 rounded-lg space-y-1" data-testid="renew-cost">
            {estimate.followers > 0 ? (
              <>
                <p className="font-medium">
                  Moving your {estimate.followers.toLocaleString()} follower{estimate.followers === 1 ? '' : 's'} costs about {formatUsd(estimate.usd)}.
                </p>
                <p className="text-gray-500 dark:text-gray-400">Private posting pauses until everyone has been moved. You can leave this page; the move picks up where it left off.</p>
              </>
            ) : (
              <p className="font-medium">You have no private followers to move. Renewing costs about {formatUsd(estimate.usd)}.</p>
            )}
          </div>
        </div>
      )}

      <div className="flex justify-end gap-3 mt-6">
        <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button data-testid="renew-confirm" disabled={!ready} onClick={() => onConfirm(bringHistory)}>
          {!ready ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Renew'}
        </Button>
      </div>
    </Modal>
  )
}
