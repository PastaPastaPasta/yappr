'use client'

import { useCallback, useEffect, useState } from 'react'
import { KeyIcon } from '@heroicons/react/24/outline'
import type { AppConnectGrant } from 'platform-auth'
import { logger } from '@/lib/logger'
import { useAuth, type PasskeyRenewal } from '@/contexts/auth-context'
import { passkeysOffered } from '@/lib/auth/passkey-vault'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { AppConnectLoginPanel } from './app-connect-login-panel'
import { RENEW_COPY, signInErrorCopy } from './passkey-copy'

/**
 * "Sign in with a passkey" in the sign-in dialog. One tap opens the browser's
 * passkey picker; the passkey brings back the session it was added in. When
 * that was a wallet sign-in that has since run out, the wallet is asked to
 * renew it right here. Shown only where passkeys work (yap.pr, a browser with
 * WebAuthn, a deployment with the vault).
 */
export function PasskeySignIn({ onComplete }: { onComplete: () => void }) {
  const { loginWithPasskey, loginWithAppConnect } = useAuth()
  const [offered, setOffered] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [renewal, setRenewal] = useState<PasskeyRenewal | null>(null)

  // Decided after mount: it reads the page's host, which the static export does not know.
  useEffect(() => setOffered(passkeysOffered()), [])

  const signIn = useCallback(() => {
    setBusy(true)
    setError(null)
    loginWithPasskey()
      .then((needsRenewal) => {
        if (needsRenewal) setRenewal(needsRenewal)
        else onComplete()
      })
      .catch((failure: unknown) => {
        logger.warn('Passkey sign-in did not complete:', failure)
        setError(signInErrorCopy(failure))
      })
      .finally(() => setBusy(false))
  }, [loginWithPasskey, onComplete])

  const renewWithGrant = useCallback(async (grant: AppConnectGrant) => {
    await loginWithAppConnect(grant)
  }, [loginWithAppConnect])

  if (!offered) return null

  if (renewal) {
    return (
      <div className="flex flex-col gap-3" data-testid="passkey-renew">
        <p className="text-sm text-center text-gray-600 dark:text-gray-400">{RENEW_COPY[renewal.reason]}</p>
        <AppConnectLoginPanel identityHint={renewal.identityId} onGrant={renewWithGrant} onComplete={onComplete} />
        <Button variant="ghost" className="w-full" onClick={() => setRenewal(null)}>Back</Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <Button type="button" onClick={signIn} disabled={busy} className="w-full gap-2" data-testid="passkey-sign-in">
        {busy ? <Spinner size="sm" /> : <KeyIcon aria-hidden="true" className="h-5 w-5" />}
        Sign in with a passkey
      </Button>
      {error && <p role="alert" className="text-sm text-center text-red-600 dark:text-red-400">{error}</p>}
      <div className="flex items-center gap-3 my-2" aria-hidden="true">
        <span className="h-px flex-1 bg-gray-200 dark:bg-gray-800" />
        <span className="text-xs text-gray-500">or</span>
        <span className="h-px flex-1 bg-gray-200 dark:bg-gray-800" />
      </div>
    </div>
  )
}
