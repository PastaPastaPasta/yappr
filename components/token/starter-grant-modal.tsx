'use client'

import { useEffect, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { GiftIcon } from '@heroicons/react/24/outline'
import toast from 'react-hot-toast'
import { Modal, ModalTitle } from '@/components/ui/modal'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/contexts/auth-context'
import { useStarterGrantModal } from '@/hooks/use-starter-grant-modal'
import { starterGrantAmount } from '@/lib/contract-topology'
import { logger } from '@/lib/logger'
import { readScoped, writeScoped } from '@/lib/storage-scope'
import { tokenService } from '@/lib/services/token-service'

const SETTLED_KEY = 'yappr_starter_grant_settled'

/** Identities whose grant is claimed (or was already claimed): never prompt again. */
function settledIdentities(): Set<string> {
  try {
    return new Set(JSON.parse(readScoped(SETTLED_KEY) ?? '[]') as string[])
  } catch {
    return new Set()
  }
}

function markSettled(identityId: string): void {
  writeScoped(SETTLED_KEY, JSON.stringify([...settledIdentities(), identityId]))
}

/**
 * On a contract whose token declares a once-per-identity grant (v9: 100
 * YAPP), a signed-in identity with NO YAPP is offered its grant once. A
 * successful claim, or a 40722 "already claimed", settles the identity so the
 * prompt never returns; declining only postpones it to the next session.
 */
export function StarterGrantModal() {
  const { user } = useAuth()
  const { isOpen, open, close } = useStarterGrantModal()
  const [busy, setBusy] = useState(false)
  const [needsCritical, setNeedsCritical] = useState(false)
  const [wif, setWif] = useState('')
  const identityId = user?.identityId
  const amount = starterGrantAmount()

  useEffect(() => {
    if (!identityId || amount === null || settledIdentities().has(identityId)) return
    let cancelled = false
    tokenService.getBalance(identityId)
      .then((balance) => {
        if (!cancelled && balance === BigInt(0)) open()
      })
      .catch((error) => logger.debug('StarterGrantModal: balance probe failed', error))
    return () => {
      cancelled = true
    }
  }, [identityId, amount, open])

  if (!identityId || amount === null) return null

  const handleClaim = async () => {
    if (busy) return
    setBusy(true)
    const result = await tokenService.claimStarterGrant(identityId, needsCritical ? wif : undefined)
    setBusy(false)
    if (result.success || result.errorCode === 'ALREADY_CLAIMED') {
      markSettled(identityId)
      if (result.success) {
        toast.success(`${amount} YAPP claimed`)
        if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('yapp-balance-changed'))
      } else {
        toast.error(result.error ?? 'Already claimed')
      }
      setWif('')
      close()
      return
    }
    if (result.errorCode === 'NEEDS_CRITICAL_KEY') {
      setNeedsCritical(true)
      toast.error(result.error ?? 'A CRITICAL key is needed')
      return
    }
    toast.error(result.error ?? 'Claim failed')
  }

  return (
    <Modal open={isOpen} onOpenChange={(next) => !next && !busy && close()} className="w-[420px] max-w-[90vw]">
      <ModalTitle>
        <GiftIcon className="h-6 w-6 text-yappr-500" />
        Claim your starter YAPP
      </ModalTitle>
      <Dialog.Description className="text-gray-600 dark:text-gray-400 mb-4">
        Every identity may claim {amount.toString()} YAPP once. Posts, replies, likes and reposts paid in YAPP have their
        network fee covered by Yappr while the grant lasts; after that you can keep posting on credits or buy more YAPP.
      </Dialog.Description>
      {needsCritical && (
        <div className="mb-4">
          <label htmlFor="starter-grant-wif" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            CRITICAL authentication key (WIF)
          </label>
          <input
            id="starter-grant-wif"
            type="password"
            value={wif}
            onChange={(e) => setWif(e.target.value)}
            autoComplete="off"
            className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-neutral-800 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-yappr-500"
          />
          <p className="mt-1 text-xs text-gray-500">Token claims must be signed with a CRITICAL key. It is used once and never stored.</p>
        </div>
      )}
      <div className="flex flex-col gap-3">
        <Button data-testid="starter-grant-claim" onClick={handleClaim} disabled={busy || (needsCritical && !wif.trim())} className="w-full bg-yappr-500 hover:bg-yappr-600 text-white">
          {busy ? 'Claiming…' : `Claim ${amount.toString()} YAPP`}
        </Button>
        <Button onClick={close} variant="outline" disabled={busy} className="w-full">
          Not now
        </Button>
      </div>
    </Modal>
  )
}
