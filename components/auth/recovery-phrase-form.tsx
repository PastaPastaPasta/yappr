'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import toast from 'react-hot-toast'
import { SupersededSignInError } from 'platform-auth'
import { useAuth } from '@/contexts/auth-context'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { logger } from '@/lib/logger'
import { normalizeRecoveryPhrase } from '@/lib/crypto/dip13'
import {
  INVALID_PHRASE,
  openRecoveryPhrase,
  PhraseSignInError,
  preparePhraseSession,
  type OpenedPhrase,
  type PhraseAccount,
  type PhraseMessaging,
} from '@/lib/auth/recovery-phrase-sign-in'

type Phase =
  | { kind: 'enter' }
  | { kind: 'finding' }
  | { kind: 'choose'; accounts: PhraseAccount[] }
  | { kind: 'signing-in' }

/** BIP-39 phrases DashPay and other wallets use. */
const WORD_COUNTS = new Set([12, 15, 18, 21, 24])

const MESSAGING_NOTICE: Partial<Record<PhraseMessaging, string>> = {
  'another-wallet': 'Messaging on this account was set up with another wallet. Sign in with that wallet to read your messages.',
  'not-set-up': 'Messaging couldn\'t be set up just now. Sign in with your recovery phrase again to try once more.',
}

const CONNECTION_FAILURE = 'Couldn\'t reach Dash Platform. Check your connection and try again.'

function accountLabel(account: PhraseAccount): string {
  return account.username ?? `${account.identityId.slice(0, 8)}…${account.identityId.slice(-4)}`
}

/**
 * Sign in with a recovery phrase (App Connect builds, D38): the account and
 * its messaging key are derived exactly as the Dash wallet holding the phrase
 * derives them, so messages read here are the ones the wallet reads.
 *
 * The phrase is used once and never kept. The field is uncontrolled, so the
 * phrase never reaches React state or a DOM `value` attribute, and it is a
 * masked text field outside any form, so browsers never offer to save it as a
 * password. It is emptied as soon as a valid phrase is submitted, whatever
 * happens next.
 */
export function RecoveryPhraseForm({ onComplete }: { onComplete: () => void }) {
  const inputId = useId()
  const noteId = useId()
  const { controller, loginWithRecoveryPhrase } = useAuth()
  const field = useRef<HTMLInputElement>(null)
  const [hasText, setHasText] = useState(false)
  const [show, setShow] = useState(false)
  const [phase, setPhase] = useState<Phase>({ kind: 'enter' })
  const [error, setError] = useState<string | null>(null)
  /** The opened phrase while an account is chosen; taken by the sign-in that uses it. */
  const opened = useRef<OpenedPhrase | null>(null)
  /** The session epoch the phrase was entered on: a sign-in or sign-out since supersedes this one. */
  const since = useRef(0)
  /** False once the dialog closes: a sign-in under way then stops before writing anything. */
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      opened.current = null
    }
  }, [])

  const clearField = () => {
    if (field.current) field.current.value = ''
    setHasText(false)
    setShow(false)
  }

  const fail = (failure: unknown) => {
    if (!alive.current) return
    logger.warn('Recovery phrase sign-in did not complete:', failure)
    // Its own refusals and a superseded sign-in say what happened; anything else is the network.
    const speaks = failure instanceof SupersededSignInError || failure instanceof PhraseSignInError
    setError(speaks ? failure.message : CONNECTION_FAILURE)
    setPhase({ kind: 'enter' })
  }

  const signIn = async (account: PhraseAccount) => {
    const wallet = opened.current?.wallet
    // Taken once: a second click on the chooser finds nothing to sign in with.
    opened.current = null
    if (!wallet) return
    setPhase({ kind: 'signing-in' })
    try {
      // A dialog closed mid-sign-in makes preparePhraseSession throw PhraseSignInCancelled, which `fail` ignores once not alive.
      const session = await preparePhraseSession(wallet, account, () => !alive.current)
      if (!alive.current) {
        session.messagingKey?.privateKey.fill(0)
        return
      }
      await loginWithRecoveryPhrase(session, since.current)
      const notice = MESSAGING_NOTICE[session.messaging]
      if (notice) toast(notice, { duration: 8_000 })
      onComplete()
    } catch (failure) {
      fail(failure)
    }
  }

  const submit = async () => {
    const normalized = normalizeRecoveryPhrase(field.current?.value ?? '')
    if (!WORD_COUNTS.has(normalized.split(' ').length)) {
      setError('Enter all the words of your recovery phrase, in order.')
      return
    }
    setError(null)
    since.current = controller.sessionEpoch()
    setPhase({ kind: 'finding' })
    try {
      const found = await openRecoveryPhrase(normalized)
      // A valid phrase has been used: it leaves the page now.
      clearField()
      if (!alive.current) return
      if (found.accounts.length === 0) {
        setError('No Dash account uses this recovery phrase yet.')
        setPhase({ kind: 'enter' })
        return
      }
      opened.current = found
      if (found.accounts.length === 1) await signIn(found.accounts[0])
      else setPhase({ kind: 'choose', accounts: found.accounts })
    } catch (failure) {
      // A phrase that fails its checksum stays to be corrected; after any other failure it goes.
      if (!(failure instanceof Error && failure.message === INVALID_PHRASE)) clearField()
      fail(failure)
    }
  }

  if (phase.kind === 'choose') {
    return (
      <div className="space-y-3" data-testid="recovery-phrase-accounts">
        <p className="text-sm text-gray-600 dark:text-gray-400">This recovery phrase has more than one account. Which one?</p>
        {phase.accounts.map((account) => (
          <Button key={account.identityId} type="button" variant="outline" className="w-full" onClick={() => { signIn(account).catch(fail) }}>
            {accountLabel(account)}
          </Button>
        ))}
        <Button type="button" variant="ghost" className="w-full" onClick={() => { opened.current = null; setPhase({ kind: 'enter' }) }}>
          Cancel
        </Button>
      </div>
    )
  }

  const busy = phase.kind !== 'enter'
  return (
    <div className="space-y-4" data-testid="recovery-phrase-form">
      <div>
        <label htmlFor={inputId} className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          Recovery phrase
        </label>
        <div className="relative">
          <input
            ref={field}
            id={inputId}
            type="text"
            onInput={(event) => { setHasText(event.currentTarget.value.trim().length > 0); setError(null) }}
            onKeyDown={(event) => { if (event.key === 'Enter' && !busy) submit().catch(fail) }}
            placeholder="Your 12 or 24 words"
            aria-describedby={noteId}
            disabled={busy}
            // Masked without type=password, which browsers would offer to save; never autofilled or corrected.
            style={show ? undefined : { WebkitTextSecurity: 'disc' } as React.CSSProperties}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            data-1p-ignore
            data-lpignore="true"
            data-bwignore
            data-form-type="other"
            className="w-full px-3 py-2 pr-10 bg-gray-50 dark:bg-gray-950 border border-gray-200 dark:border-gray-800 rounded-lg text-gray-900 dark:text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-yappr-500 focus:border-transparent"
          />
          <button
            type="button"
            onClick={() => setShow((value) => !value)}
            aria-label={show ? 'Hide recovery phrase' : 'Show recovery phrase'}
            className="absolute inset-y-0 right-0 flex items-center pr-3 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
          >
            {show ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
          </button>
        </div>
        <p id={noteId} aria-live="polite" className={`mt-2 text-xs ${error ? 'text-red-500 dark:text-red-400' : 'text-gray-500 dark:text-gray-400'}`}>
          {error ?? 'Your recovery phrase controls your Dash wallet. It stays on this device and is never saved. Only enter it on yap.pr.'}
        </p>
      </div>
      <Button type="button" onClick={() => { submit().catch(fail) }} disabled={busy || !hasText} className="w-full" size="lg">
        {busy ? (
          <span className="flex items-center justify-center gap-2">
            <Spinner size="sm" className="border-white" />
            {phase.kind === 'finding' ? 'Finding your account' : 'Signing in'}
          </span>
        ) : 'Sign In'}
      </Button>
    </div>
  )
}
