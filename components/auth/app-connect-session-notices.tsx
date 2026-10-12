'use client'

import { useCallback, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { KeyRound, LogOut } from 'lucide-react'
import type { AppConnectGrant } from 'platform-auth'
import { useAuth } from '@/contexts/auth-context'
import { Modal, ModalTitle } from '@/components/ui/modal'
import { Button } from '@/components/ui/button'
import { useAppConnectStatus, type RenewReason } from '@/lib/app-connect/session-manager'
import { useRenewModal } from '@/hooks/use-renew-modal'
import { useLoginModal } from '@/hooks/use-login-modal'
import { AppConnectLoginPanel } from './app-connect-login-panel'

const RENEW_REASON_COPY: Record<RenewReason, string> = {
  expired: 'Your wallet sign-in has expired. Renew it in your Dash wallet to keep posting. You can still read everything.',
  'allowance-spent': 'Yappr has used the allowance your wallet gave it. Renew it in your Dash wallet to keep posting. You can still read everything.',
  'insufficient-allowance': 'There isn\'t enough allowance left for that. Renew it in your Dash wallet to keep posting. You can still read everything.',
}

/**
 * The App Connect session's prompts, mounted once for the whole app:
 * - a banner when the allowance or the time left runs low;
 * - the renew dialog, opened by the banner, by Settings, or by a write the
 *   allowance or expiry stopped (that one explains why);
 * - "Signed out from DashPay" when the wallet revoked this browser's keys.
 */
export function AppConnectSessionNotices() {
  const { user, renewWithAppConnect } = useAuth()
  const { identityId, health, renewRequired, signedOutByWallet, dismissRenewRequired, dismissSignedOut } = useAppConnectStatus()
  const renew = useRenewModal()
  const openLogin = useLoginModal((state) => state.open)
  const [bannerDismissed, setBannerDismissed] = useState(false)

  const sessionUser = user && identityId === user.identityId ? user : null
  const dialogOpen = Boolean(sessionUser) && (renew.isOpen || renewRequired !== null)

  const closeRenew = useCallback(() => {
    renew.close()
    dismissRenewRequired()
  }, [dismissRenewRequired, renew])

  const onGrant = useCallback(async (grant: AppConnectGrant) => {
    await renewWithAppConnect(grant)
  }, [renewWithAppConnect])

  return (
    <>
      {sessionUser && health === 'renew-soon' && !bannerDismissed && !dialogOpen && (
        <div className="fixed bottom-20 md:bottom-4 inset-x-4 md:left-auto md:right-4 md:w-96 z-40 rounded-2xl bg-white dark:bg-neutral-900 ring-1 ring-gray-200 dark:ring-neutral-700 shadow-lg p-4 flex flex-col gap-3" role="status" data-testid="app-connect-renew-banner">
          <p className="text-sm text-gray-700 dark:text-gray-300">
            Yappr&apos;s allowance from your wallet is running low. Renew it in your Dash wallet so posting keeps working.
          </p>
          <div className="flex gap-2 justify-end">
            <Button variant="ghost" size="sm" onClick={() => setBannerDismissed(true)}>Later</Button>
            <Button size="sm" onClick={() => renew.open()}>Renew</Button>
          </div>
        </div>
      )}

      <Modal open={dialogOpen} onOpenChange={(next) => { if (!next) closeRenew() }} className="w-[420px] max-w-[90vw]">
        <ModalTitle>
          <KeyRound className="h-6 w-6 text-yappr-500" />
          Renew in your wallet
        </ModalTitle>
        <Dialog.Description className="text-sm text-gray-600 dark:text-gray-400 mb-2">
          {renewRequired ? RENEW_REASON_COPY[renewRequired] : 'Scan the code with your Dash wallet to give Yappr a fresh allowance.'}
        </Dialog.Description>
        {sessionUser && dialogOpen && (
          <AppConnectLoginPanel identityHint={sessionUser.identityId} onGrant={onGrant} onComplete={closeRenew} />
        )}
      </Modal>

      <Modal open={signedOutByWallet} onOpenChange={(next) => { if (!next) dismissSignedOut() }} className="w-[420px] max-w-[90vw]">
        <ModalTitle>
          <LogOut className="h-6 w-6 text-yappr-500" />
          Signed out from DashPay
        </ModalTitle>
        <Dialog.Description className="text-sm text-gray-600 dark:text-gray-400 mb-4">
          Your wallet ended Yappr&apos;s access on this browser, so you&apos;ve been signed out. Sign in again whenever you like.
        </Dialog.Description>
        <div className="flex gap-2 justify-end">
          <Button variant="ghost" onClick={dismissSignedOut}>Close</Button>
          <Button onClick={() => { dismissSignedOut(); openLogin() }}>Sign in</Button>
        </div>
      </Modal>
    </>
  )
}
