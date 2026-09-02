'use client'

import { logger } from '@/lib/logger'
import { useState, useEffect, useCallback, useRef } from 'react'
import { CheckCircle, AlertCircle, RefreshCw, KeyRound } from 'lucide-react'
import { useYapprKeyExchangeLogin } from 'platform-auth'
import { useAuth } from '@/contexts/auth-context'
import { useBuyYappModal } from '@/hooks/use-buy-yapp-modal'
import { authVaultService } from '@/lib/services/auth-vault-service'
import { tokenService } from '@/lib/services/token-service'
import { getPasskeyPrfSupport } from '@/lib/webauthn/passkey-support'
import { YAPP_TOKEN_COSTS } from '@/lib/constants'
import { Spinner } from '@/components/ui/spinner'
import { KeyExchangeQR } from './key-exchange-qr'
import { KeyRegistrationFlow } from './key-registration-flow'
import { Button } from '@/components/ui/button'

/**
 * Where the (unabortable) `loginWithKeyExchange` call has got to. Only 'idle'
 * lets the effect below start an attempt, so a finished or failed one is never
 * silently retried.
 */
type LoginPhase = 'idle' | 'running' | 'done' | 'failed'

interface WalletLoginPanelProps {
  /** Called once the session is established and the panel is done. */
  onComplete: () => void
  /** Called when the user backs out of a first-time key registration. */
  onCancel: () => void
}

/**
 * After a wallet login lands on a ready account, decide whether to prompt for
 * YAPP right away: true when the balance can't cover a single post. A failed
 * balance fetch is "unknown", not zero, so it never triggers the prompt.
 */
async function needsYappPrompt(identityId: string): Promise<boolean> {
  try {
    const balance = await tokenService.getBalance(identityId)
    return balance < BigInt(YAPP_TOKEN_COSTS.post)
  } catch (err) {
    logger.warn('Skipping post-login YAPP prompt: balance check failed', err)
    return false
  }
}

/**
 * A passkey is only worth offering when the vault exists, has no passkey yet,
 * and the browser can actually run a PRF-capable ceremony.
 */
async function shouldOfferPasskeyEnrollment(identityId: string): Promise<boolean> {
  try {
    if (!authVaultService.isConfigured()) return false
    const status = await authVaultService.getStatus(identityId)
    const support = await getPasskeyPrfSupport()
    return (
      status.hasVault &&
      status.passkeyCount === 0 &&
      support.webauthnAvailable &&
      support.likelyPrfCapable
    )
  } catch (supportError) {
    logger.warn('Key exchange login completed, but passkey support check failed:', supportError)
    return false
  }
}

/**
 * The wallet (dash-key:) sign-in flow, rendered inline inside the login
 * modal. Mounting the panel starts a key exchange request immediately; the
 * QR code is the first thing the user sees. Unmounting aborts the request
 * and zeros any key material the hook is holding.
 *
 * States:
 * - generating: spinner
 * - waiting: QR code
 * - decrypting / checking: brief spinner
 * - registering: first-login key registration (its own QR)
 * - passkey offer: post-login prompt to enrol a passkey (vault has none yet)
 * - complete: success, then `onComplete`
 * - timeout / error: check again
 *
 * A wallet login yields a HIGH key, which can post but not buy YAPP; only the
 * wallet holds the CRITICAL key. So when the account is ready but can't afford
 * a post, the Buy-YAPP modal opens in wallet-signing mode as this panel goes
 * away, while the wallet is still in hand.
 */
export function WalletLoginPanel({ onComplete, onCancel }: WalletLoginPanelProps) {
  const { controller, loginWithKeyExchange, addPasskeyWrapper } = useAuth()

  const {
    state,
    uri,
    error,
    result,
    start,
    cancel,
    retry,
  } = useYapprKeyExchangeLogin(controller)

  const [loginPhase, setLoginPhase] = useState<LoginPhase>('idle')
  const [loginError, setLoginError] = useState<string | null>(null)
  const [passkeyOffer, setPasskeyOffer] = useState(false)
  const [isAddingPasskey, setIsAddingPasskey] = useState(false)
  const [passkeyError, setPasskeyError] = useState<string | null>(null)

  // loginWithKeyExchange can't be aborted. Continuations check that the panel
  // is still mounted and that no newer attempt superseded them before acting.
  const mountedRef = useRef(true)
  const attemptGenerationRef = useRef(0)

  // Decided once login succeeds. The Buy-YAPP modal opens from the unmount
  // cleanup, so it fires exactly once whether the panel finished on its own or
  // the user dismissed the dialog during the passkey offer / auto-close wait.
  const promptForYappRef = useRef(false)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (promptForYappRef.current) {
        promptForYappRef.current = false
        useBuyYappModal.getState().open(
          'You\'re signed in! Posting, replying, and liking cost YAPP. Grab some now and approve it in your wallet.',
          'wallet',
        )
      }
    }
  }, [])

  const attemptLogin = useCallback((identityId: string, loginKey: Uint8Array, keyIndex: number) => {
    attemptGenerationRef.current += 1
    const generation = attemptGenerationRef.current
    const isCurrent = () => mountedRef.current && attemptGenerationRef.current === generation

    setLoginError(null)
    setLoginPhase('running')
    promptForYappRef.current = false
    loginWithKeyExchange(identityId, loginKey, keyIndex)
      .then(async (intent) => {
        if (!isCurrent()) return

        // Accounts still needing a username or profile go through those steps
        // first; the YAPP prompt only makes sense once the account is ready.
        const [offerPasskey, promptForYapp] = await Promise.all([
          shouldOfferPasskeyEnrollment(identityId),
          intent.kind === 'ready' ? needsYappPrompt(identityId) : Promise.resolve(false),
        ])
        if (!isCurrent()) return
        promptForYappRef.current = promptForYapp
        setLoginPhase('done')

        if (offerPasskey) {
          setPasskeyOffer(true)
          return
        }

        setTimeout(() => {
          if (isCurrent()) onComplete()
        }, 1200)
      })
      .catch((err) => {
        if (!isCurrent()) return
        logger.error('Key exchange login failed:', err)
        setLoginError(err instanceof Error ? err.message : 'Sign-in failed')
        setLoginPhase('failed')
      })
  }, [loginWithKeyExchange, onComplete])

  // Leaves the passkey step, whether the user enrolled or skipped.
  const finishPasskeyStep = useCallback(() => {
    if (!mountedRef.current) return
    setIsAddingPasskey(false)
    setPasskeyError(null)
    setPasskeyOffer(false)
    onComplete()
  }, [onComplete])

  const handleAddPasskey = useCallback(() => {
    setPasskeyError(null)
    setIsAddingPasskey(true)
    addPasskeyWrapper('Wallet login passkey')
      .then(finishPasskeyStep)
      .catch((err) => {
        if (!mountedRef.current) return
        logger.error('Passkey enrollment failed:', err)
        setPasskeyError(err instanceof Error ? err.message : 'Could not add a passkey')
        setIsAddingPasskey(false)
      })
  }, [addPasskeyWrapper, finishPasskeyStep])

  // Start the request as soon as the panel mounts.
  useEffect(() => {
    if (state === 'idle') {
      setLoginPhase('idle')
      setLoginError(null)
      setPasskeyOffer(false)
      setIsAddingPasskey(false)
      setPasskeyError(null)
      start()
    }
  }, [state, start])

  useEffect(() => {
    if (state === 'complete' && result && loginPhase === 'idle') {
      attemptLogin(result.identityId, result.loginKey, result.keyIndex)
    }
  }, [state, result, loginPhase, attemptLogin])

  const handleCancelRegistration = useCallback(() => {
    attemptGenerationRef.current += 1
    setLoginPhase('idle')
    setLoginError(null)
    cancel()
    onCancel()
  }, [cancel, onCancel])

  if (passkeyOffer) {
    return (
      <PanelPrompt
        tone="brand"
        icon={<KeyRound className="w-7 h-7" />}
        title="You're signed in. Add a passkey?"
        description="Next time, unlock this account on this device without scanning a code."
      >
        {passkeyError && (
          <p className="text-sm text-red-600 dark:text-red-400 text-center max-w-xs">{passkeyError}</p>
        )}
        <div className="w-full space-y-2">
          <Button className="w-full" size="lg" onClick={handleAddPasskey} disabled={isAddingPasskey}>
            {isAddingPasskey ? (
              <>
                <Spinner size="xs" className="mr-2 border-white" />
                Adding passkey
              </>
            ) : (
              <>
                <KeyRound className="w-4 h-4 mr-2" />
                Add a passkey
              </>
            )}
          </Button>
          <Button variant="ghost" className="w-full" onClick={finishPasskeyStep} disabled={isAddingPasskey}>
            Not now
          </Button>
        </div>
      </PanelPrompt>
    )
  }

  switch (state) {
    case 'idle':
    case 'generating':
      return <PanelSpinner label="Preparing a sign-in request" />

    case 'waiting':
      return (
        <div className="flex flex-col items-center" role="status" aria-live="polite">
          {uri && <KeyExchangeQR uri={uri} size={208} />}
        </div>
      )

    case 'decrypting':
    case 'checking':
      return (
        <PanelSpinner
          label={state === 'decrypting' ? 'Wallet approved. Unlocking your keys' : 'Checking your identity'}
        />
      )

    case 'registering':
      if (!result) {
        return <PanelSpinner label="Preparing key registration" />
      }
      return (
        <KeyRegistrationFlow
          controller={controller}
          identityId={result.identityId}
          authKey={result.authKey}
          encryptionKey={result.encryptionKey}
          onComplete={() => attemptLogin(result.identityId, result.loginKey, result.keyIndex)}
          onCancel={handleCancelRegistration}
        />
      )

    case 'complete':
      if (loginError) {
        return (
          <PanelPrompt
            tone="error"
            icon={<AlertCircle className="w-7 h-7" />}
            title="Sign-in failed"
            description={loginError}
          >
            <Button
              onClick={() => {
                if (result) attemptLogin(result.identityId, result.loginKey, result.keyIndex)
              }}
            >
              Try again
            </Button>
          </PanelPrompt>
        )
      }
      if (loginPhase !== 'done') {
        return <PanelSpinner label="Signing you in" />
      }
      return (
        <PanelStatus>
          <StatusBadge tone="success"><CheckCircle className="w-7 h-7" /></StatusBadge>
          <p className="font-medium text-gray-900 dark:text-white">Signed in</p>
        </PanelStatus>
      )

    case 'timeout':
      return (
        <PanelPrompt
          tone="neutral"
          icon={<RefreshCw className="w-6 h-6" />}
          title="No response from your wallet yet"
          description="Approve the request in your wallet, then check again for a fresh code."
        >
          <Button onClick={retry}>Check again</Button>
        </PanelPrompt>
      )

    case 'error':
      return (
        <PanelPrompt
          tone="error"
          icon={<AlertCircle className="w-6 h-6" />}
          title="Couldn't reach your wallet"
          description={error || 'Something went wrong while creating the sign-in request.'}
        >
          <Button onClick={retry}>Try again</Button>
        </PanelPrompt>
      )

    default:
      return null
  }
}

/** The panel's plain "working on it" state: big spinner over a caption. */
function PanelSpinner({ label }: { label: string }) {
  return (
    <PanelStatus>
      <Spinner size="lg" />
      <p className="text-sm text-gray-600 dark:text-gray-400">{label}</p>
    </PanelStatus>
  )
}

/** Badge, headline and explanation, with the call(s) to action as children. */
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
  children: React.ReactNode
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

type StatusTone = 'success' | 'error' | 'neutral' | 'brand'

function StatusBadge({ tone, children }: { tone: StatusTone; children: React.ReactNode }) {
  const toneClass = {
    success: 'bg-green-50 text-green-600 dark:bg-green-900/20 dark:text-green-400',
    error: 'bg-red-50 text-red-600 dark:bg-red-900/20 dark:text-red-400',
    neutral: 'bg-gray-100 text-gray-500 dark:bg-neutral-800 dark:text-gray-400',
    brand: 'bg-yappr-100 text-yappr-600 dark:bg-yappr-900/30 dark:text-yappr-400',
  }[tone]
  return <div className={`p-3 rounded-full ${toneClass}`}>{children}</div>
}
