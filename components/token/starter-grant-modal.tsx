'use client'

import { useEffect, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { GiftIcon } from '@heroicons/react/24/outline'
import toast from 'react-hot-toast'
import { Modal, ModalTitle } from '@/components/ui/modal'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/contexts/auth-context'
import { useStarterGrantModal } from '@/hooks/use-starter-grant-modal'
import { starterGrantAmount, yappIsLocked, yappIsPausedForGood } from '@/lib/contract-topology'
import { logger } from '@/lib/logger'
import { markStarterGrantClaimed, refreshStarterClaimState, useStarterClaimState } from '@/hooks/use-starter-claim'
import { tokenService } from '@/lib/services/token-service'
import { useTokenClaimHidden } from '@/lib/app-connect/session-manager'

/**
 * On a contract whose token declares a once-per-identity grant (v9, v10: 100
 * YAPP), a signed-in identity with NO YAPP is offered its grant once. Whether
 * it was already claimed is read from chain first (#740): the claim is only
 * offered when chain says it is still open, never while that is unknown. A
 * successful claim, or a 40722 "already claimed", settles the identity so the
 * prompt never returns; declining only postpones it to the next session.
 *
 * Where YAPP is locked (v10 onwards) it can't be bought, so running out of
 * YAPP opens this modal in place of Buy YAPP. Where it is also paused for
 * good (v10–v13) it can't be spent either: posts, replies and likes always
 * pay credits (lib/payment-preference.ts), so the grant is never pushed on
 * anyone; it still opens from the account menu's Claim row. v14's YAPP pays
 * token costs again, so the grant is offered as on v9, without "buy more".
 */
export function StarterGrantModal() {
  const { user } = useAuth()
  const { isOpen, open, close } = useStarterGrantModal()
  const [busy, setBusy] = useState(false)
  const identityId = user?.identityId
  const amount = starterGrantAmount()
  // A wallet sign-in whose group key is only HIGH cannot sign the claim: never offer it.
  const claimHidden = useTokenClaimHidden(identityId)
  const claimState = useStarterClaimState(identityId)

  const locked = yappIsLocked()
  const paused = yappIsPausedForGood()

  useEffect(() => {
    if (!identityId || amount === null || paused || claimHidden || claimState !== 'unclaimed') return
    let cancelled = false
    tokenService.getBalance(identityId)
      .then((balance) => {
        if (!cancelled && balance === BigInt(0)) open()
      })
      .catch((error) => logger.debug('StarterGrantModal: balance probe failed', error))
    return () => {
      cancelled = true
    }
  }, [identityId, amount, paused, claimHidden, claimState, open])

  if (!identityId || amount === null) return null

  const handleClaim = async () => {
    if (busy) return
    setBusy(true)
    // Asked again right before the claim: it may have been made in another tab or on another device since.
    const latest = await refreshStarterClaimState(identityId)
    if (latest !== 'unclaimed') {
      setBusy(false)
      if (latest === 'unknown') toast.error('Couldn\'t check your starter YAPP right now. Please try again in a moment.')
      else close()
      return
    }
    // A session without the account's CRITICAL key is asked for it by the shared sheet (lib/auth/critical-key.ts).
    const result = await tokenService.claimStarterGrant(identityId)
    setBusy(false)
    // The sheet was closed: nothing was sent, and the offer stays open.
    if (result.errorCode === 'CANCELLED') return
    if (result.success || result.errorCode === 'ALREADY_CLAIMED') {
      markStarterGrantClaimed(identityId)
      if (result.success) {
        toast.success(`${amount} YAPP claimed`)
        if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('yapp-balance-changed'))
      } else {
        toast.error(result.error ?? 'Already claimed')
      }
      close()
      return
    }
    if (result.errorCode === 'NEEDS_CRITICAL_KEY') {
      toast.error('Claiming needs your account\'s highest-security key')
      return
    }
    toast.error(result.error ?? 'Claim failed')
  }

  // Fail closed: unless chain says the grant is still open, there is nothing to claim here.
  if (locked && claimState !== 'unclaimed') {
    return (
      <Modal open={isOpen} onOpenChange={(next) => !next && close()} className="w-[420px] max-w-[90vw]">
        <ModalTitle>
          <GiftIcon className="h-6 w-6 text-yappr-500" />
          Out of YAPP
        </ModalTitle>
        <Dialog.Description className="text-gray-600 dark:text-gray-400 mb-4">
          {paused
            ? 'YAPP can\'t be used right now.'
            : claimState === 'claimed'
              ? 'You\'ve used up your starter YAPP. Try again to pay with credits instead.'
              : 'You don\'t have enough YAPP for this. Try again to pay with credits instead.'}
        </Dialog.Description>
        <Button data-testid="starter-grant-dismiss" onClick={close} className="w-full bg-yappr-500 hover:bg-yappr-600 text-white">
          OK
        </Button>
      </Modal>
    )
  }

  if (claimHidden || claimState !== 'unclaimed') return null

  return (
    <Modal open={isOpen} onOpenChange={(next) => !next && !busy && close()} className="w-[420px] max-w-[90vw]">
      <ModalTitle>
        <GiftIcon className="h-6 w-6 text-yappr-500" />
        Claim your starter YAPP
      </ModalTitle>
      <Dialog.Description className="text-gray-600 dark:text-gray-400 mb-4">
        {paused ? 'YAPP can\'t be used right now.' : 'Claim your free YAPP.'}
      </Dialog.Description>
      <div className="flex flex-col gap-3">
        <Button data-testid="starter-grant-claim" onClick={handleClaim} disabled={busy} className="w-full bg-yappr-500 hover:bg-yappr-600 text-white">
          {busy ? 'Claiming…' : `Claim ${amount.toString()} YAPP`}
        </Button>
        <Button onClick={close} variant="outline" disabled={busy} className="w-full">
          Not now
        </Button>
      </div>
    </Modal>
  )
}
