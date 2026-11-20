'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, CheckCircle, RefreshCw, ShieldAlert } from 'lucide-react'
import type { AppConnectCarrier, AppConnectGrant } from 'platform-auth'
import { logger } from '@/lib/logger'
import { useAppConnectLogin } from '@/hooks/use-app-connect-login'
import { selectCarrierUri } from '@/lib/app-connect/carrier'
import type { AppConnectUnavailableReason, VerifiedCandidate } from '@/lib/app-connect/login-flow'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { CarrierSwitch } from './carrier-switch'
import { KeyExchangeQR } from './key-exchange-qr'
import { IdentityConfirmCard } from './identity-confirm-card'

interface AppConnectLoginPanelProps {
  /** Signs in (or renews) with the grant the user confirmed. The grant's keys are wiped by the callee. */
  onGrant: (grant: AppConnectGrant) => Promise<unknown>
  /** Called once signed in and the panel is done. */
  onComplete: () => void
  /** Renewal: only this identity may answer, and it is accepted without asking. */
  identityHint?: string
}

const UNAVAILABLE_COPY: Record<AppConnectUnavailableReason, { title: string; description: string; retry: boolean }> = {
  'not-configured': {
    title: 'Wallet sign-in isn\'t available here yet',
    description: 'Sign in with a private key instead, or try again later.',
    retry: false,
  },
  'network-not-ready': {
    title: 'Wallet sign-in isn\'t available yet',
    description: 'Wallet sign-in is coming soon.',
    retry: false,
  },
  untrusted: {
    title: 'Wallet sign-in is paused',
    description: 'Something about wallet sign-in doesn\'t look right, so it\'s turned off to keep your account safe. Please try again later.',
    retry: false,
  },
  offline: {
    title: 'Couldn\'t reach the network',
    description: 'Check your connection, then try again.',
    retry: true,
  },
  storage: {
    title: 'Wallet sign-in needs browser storage',
    description: 'This browser is blocking site storage, which wallet sign-in uses to keep you signed in. Allow it for this site (or leave private browsing), then try again.',
    retry: true,
  },
}

/**
 * Wallet sign-in through App Connect: one QR code and an "Open in wallet app"
 * link. When a wallet answers, every response is verified on chain, and the
 * user confirms which account it is ("Continue as @alice" or "That's not me")
 * before anything is stored. No countdown is shown; when the request runs out
 * the panel offers "Check again".
 */
export function AppConnectLoginPanel({ onGrant, onComplete, identityHint }: AppConnectLoginPanelProps) {
  const { login, state } = useAppConnectLogin(identityHint)
  const [signing, setSigning] = useState<'idle' | 'running' | 'done'>('idle')
  const [signInError, setSignInError] = useState<string | null>(null)
  const [restartedAfterRejection, setRestartedAfterRejection] = useState(false)
  // null: the build's default carrier. Kept across new requests, so a tester's choice sticks.
  const [carrier, setCarrier] = useState<AppConnectCarrier | null>(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const accept = useCallback((identityId: string) => {
    const grant = login?.accept(identityId)
    if (!grant) return
    setSigning('running')
    setSignInError(null)
    onGrant(grant)
      .then(() => {
        if (!mounted.current) return
        setSigning('done')
        setTimeout(() => {
          if (mounted.current) onComplete()
        }, 900)
      })
      .catch((error: unknown) => {
        logger.error('App Connect sign-in failed:', error)
        if (!mounted.current) return
        setSigning('idle')
        setSignInError('We couldn\'t finish signing you in. Try again with a new code.')
        login?.start({ identityHint, fresh: true }).catch((restartError: unknown) => logger.error('App Connect: restart failed', restartError))
      })
  }, [identityHint, login, onComplete, onGrant])

  const notMe = useCallback(() => {
    setRestartedAfterRejection(true)
    login?.reject().catch((error: unknown) => logger.error('App Connect: restart failed', error))
  }, [login])

  // A renewal names its identity: the one verified answer is the account already signed in.
  const confirmCandidates = state.phase === 'confirm' ? state.candidates : null
  useEffect(() => {
    if (!identityHint || !confirmCandidates || signing !== 'idle') return
    const match = confirmCandidates.find((candidate) => candidate.identityId === identityHint)
    if (match) accept(match.identityId)
  }, [accept, confirmCandidates, identityHint, signing])

  if (signing === 'running') return <PanelSpinner label={identityHint ? 'Renewing' : 'Signing you in'} />
  if (signing === 'done') {
    return (
      <PanelStatus>
        <StatusBadge tone="success"><CheckCircle className="w-7 h-7" /></StatusBadge>
        <p className="font-medium text-gray-900 dark:text-white">{identityHint ? 'Renewed' : 'Signed in'}</p>
      </PanelStatus>
    )
  }

  const notices = (
    <>
      {signInError && <Notice tone="error">{signInError}</Notice>}
      {restartedAfterRejection && state.phase === 'waiting' && (
        <Notice tone="warning">
          Someone else may have scanned your code. Here&apos;s a new one: only scan it with your own wallet.
        </Notice>
      )}
    </>
  )

  switch (state.phase) {
    case 'checking':
      return <PanelSpinner label="Preparing a sign-in request" />

    case 'unavailable': {
      const copy = UNAVAILABLE_COPY[state.reason]
      return (
        <PanelPrompt tone={state.reason === 'untrusted' ? 'error' : 'neutral'} icon={state.reason === 'untrusted' ? <ShieldAlert className="w-6 h-6" /> : <AlertCircle className="w-6 h-6" />} title={copy.title} description={copy.description}>
          {copy.retry && (
            <Button onClick={() => { login?.start({ identityHint }).catch((error: unknown) => logger.error('App Connect: retry failed', error)) }}>
              Try again
            </Button>
          )}
        </PanelPrompt>
      )
    }

    case 'waiting': {
      // Where a build offers both carriers, the switch only picks which URI is drawn.
      const shown = selectCarrierUri(state.uris, carrier)
      return (
        <div className="flex flex-col items-center gap-4" role="status" aria-live="polite">
          {notices}
          {state.uris.length > 1 && <CarrierSwitch uris={state.uris} value={shown.carrier} onChange={setCarrier} />}
          <KeyExchangeQR uri={shown.uri} size={208} />
        </div>
      )
    }

    case 'timeout':
      return (
        <PanelPrompt tone="neutral" icon={<RefreshCw className="w-6 h-6" />} title="No response from your wallet yet" description="Approve the request in your wallet, then check again.">
          <Button onClick={() => { login?.checkAgain().catch((error: unknown) => logger.error('App Connect: check again failed', error)) }}>
            Check again
          </Button>
        </PanelPrompt>
      )

    case 'too-many':
      return (
        <PanelPrompt tone="neutral" icon={<RefreshCw className="w-6 h-6" />} title="Let's start again" description="Something kept answering this code. Here's a fresh one to scan with your wallet.">
          <Button onClick={() => { login?.start({ identityHint, fresh: true }).catch((error: unknown) => logger.error('App Connect: restart failed', error)) }}>
            Start again
          </Button>
        </PanelPrompt>
      )

    case 'confirm':
      if (identityHint) return <PanelSpinner label="Renewing" />
      return <ConfirmIdentity candidates={state.candidates} onAccept={accept} onReject={notMe} />
  }
}

function ConfirmIdentity({
  candidates,
  onAccept,
  onReject,
}: {
  candidates: VerifiedCandidate[]
  onAccept: (identityId: string) => void
  onReject: () => void
}) {
  if (candidates.length === 1) {
    return (
      <div className="flex flex-col gap-4 py-2" data-testid="app-connect-confirm">
        <p className="text-sm text-center text-gray-600 dark:text-gray-400">Your wallet approved the sign-in. Is this you?</p>
        <IdentityConfirmCard identityId={candidates[0].identityId} onContinue={onAccept} />
        <Button variant="ghost" className="w-full" onClick={onReject}>That&apos;s not me</Button>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-3 py-2" data-testid="app-connect-chooser">
      <p className="text-sm text-center text-gray-600 dark:text-gray-400">More than one account answered. Choose yours.</p>
      {candidates.map((candidate) => (
        <IdentityConfirmCard key={candidate.identityId} identityId={candidate.identityId} onContinue={onAccept} />
      ))}
      <Button variant="ghost" className="w-full" onClick={onReject}>None of these are me</Button>
    </div>
  )
}

function Notice({ tone, children }: { tone: 'error' | 'warning'; children: React.ReactNode }) {
  const toneClass = tone === 'error'
    ? 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300'
    : 'bg-amber-50 text-amber-800 dark:bg-amber-900/20 dark:text-amber-200'
  return <p role="alert" className={`w-full text-sm rounded-lg px-3 py-2 ${toneClass}`}>{children}</p>
}

function PanelSpinner({ label }: { label: string }) {
  return (
    <PanelStatus>
      <Spinner size="lg" />
      <p className="text-sm text-gray-600 dark:text-gray-400">{label}</p>
    </PanelStatus>
  )
}

function PanelPrompt({
  tone,
  icon,
  title,
  description,
  children,
}: {
  tone: StatusTone
  icon: React.ReactNode
  title: string
  description: string
  children?: React.ReactNode
}) {
  return (
    <PanelStatus>
      <StatusBadge tone={tone}>{icon}</StatusBadge>
      <div className="text-center">
        <p className="font-medium text-gray-900 dark:text-white">{title}</p>
        <p className="text-sm text-gray-600 dark:text-gray-400 mt-1 max-w-xs">{description}</p>
      </div>
      {children}
    </PanelStatus>
  )
}

function PanelStatus({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-4 py-8" role="status" aria-live="polite">
      {children}
    </div>
  )
}

type StatusTone = 'success' | 'error' | 'neutral'

function StatusBadge({ tone, children }: { tone: StatusTone; children: React.ReactNode }) {
  const toneClass = {
    success: 'bg-green-50 text-green-600 dark:bg-green-900/20 dark:text-green-400',
    error: 'bg-red-50 text-red-600 dark:bg-red-900/20 dark:text-red-400',
    neutral: 'bg-gray-100 text-gray-500 dark:bg-neutral-800 dark:text-gray-400',
  }[tone]
  return <div className={`p-3 rounded-full ${toneClass}`}>{children}</div>
}
