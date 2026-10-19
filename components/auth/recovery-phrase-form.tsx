'use client'

import { useId, useRef, useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import toast from 'react-hot-toast'
import { useAuth } from '@/contexts/auth-context'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { logger } from '@/lib/logger'
import { normalizeRecoveryPhrase } from '@/lib/crypto/dip13'
import type { OpenedPhrase, PhraseAccount, PhraseMessaging } from '@/lib/auth/recovery-phrase-sign-in'

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

function failureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  if (/recovery phrase|can't sign in|couldn't be found/i.test(message)) return message
  return 'Couldn\'t reach Dash Platform. Check your connection and try again.'
}

function accountLabel(account: PhraseAccount): string {
  return account.username ?? `${account.identityId.slice(0, 8)}…${account.identityId.slice(-4)}`
}

/**
 * Sign in with a recovery phrase (App Connect builds, D38): the account and
 * its messaging key are derived exactly as the Dash wallet holding the phrase
 * derives them, so messages read here are the ones the wallet reads. The
 * phrase is used once and never kept: the field clears as soon as a valid
 * phrase is submitted, whatever happens next.
 */
export function RecoveryPhraseForm({ onComplete }: { onComplete: () => void }) {
  const inputId = useId()
  const noteId = useId()
  const { controller, loginWithRecoveryPhrase } = useAuth()
  const [phrase, setPhrase] = useState('')
  const [show, setShow] = useState(false)
  const [phase, setPhase] = useState<Phase>({ kind: 'enter' })
  const [error, setError] = useState<string | null>(null)
  /** The opened phrase while an account is chosen; dropped as soon as the sign-in ends. */
  const opened = useRef<OpenedPhrase | null>(null)
  /** The session epoch the phrase was entered on: a sign-in or sign-out since supersedes this one. */
  const since = useRef(0)

  const signIn = async (account: PhraseAccount) => {
    const wallet = opened.current?.wallet
    if (!wallet) return
    setPhase({ kind: 'signing-in' })
    try {
      const { preparePhraseSession } = await import('@/lib/auth/recovery-phrase-sign-in')
      const session = await preparePhraseSession(wallet, account)
      await loginWithRecoveryPhrase(session, since.current)
      const notice = MESSAGING_NOTICE[session.messaging]
      if (notice) toast(notice, { duration: 8_000 })
      onComplete()
    } catch (failure) {
      logger.warn('Recovery phrase sign-in did not complete:', failure)
      setError(failureMessage(failure))
      setPhase({ kind: 'enter' })
    } finally {
      opened.current = null
    }
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    const normalized = normalizeRecoveryPhrase(phrase)
    if (!WORD_COUNTS.has(normalized.split(' ').length)) {
      setError('Enter all the words of your recovery phrase, in order.')
      return
    }
    setError(null)
    since.current = controller.sessionEpoch()
    setPhase({ kind: 'finding' })
    try {
      const { openRecoveryPhrase } = await import('@/lib/auth/recovery-phrase-sign-in')
      const found = await openRecoveryPhrase(normalized)
      // A valid phrase has been used: it leaves the page's state now.
      setPhrase('')
      setShow(false)
      if (found.accounts.length === 0) {
        setError('No Dash account uses this recovery phrase yet.')
        setPhase({ kind: 'enter' })
        return
      }
      opened.current = found
      if (found.accounts.length === 1) await signIn(found.accounts[0])
      else setPhase({ kind: 'choose', accounts: found.accounts })
    } catch (failure) {
      const invalid = failure instanceof Error && /recovery phrase isn't valid/.test(failure.message)
      if (!invalid) {
        setPhrase('')
        setShow(false)
      }
      logger.warn('Recovery phrase lookup did not complete:', failure)
      setError(failureMessage(failure))
      setPhase({ kind: 'enter' })
    }
  }

  if (phase.kind === 'choose') {
    return (
      <div className="space-y-3" data-testid="recovery-phrase-accounts">
        <p className="text-sm text-gray-600 dark:text-gray-400">This recovery phrase has more than one account. Which one?</p>
        {phase.accounts.map((account) => (
          <Button key={account.identityId} type="button" variant="outline" className="w-full" onClick={() => { signIn(account).catch(() => undefined) }}>
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
    <form onSubmit={(event) => { submit(event).catch(() => undefined) }} className="space-y-4" data-testid="recovery-phrase-form">
      <div>
        <label htmlFor={inputId} className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          Recovery phrase
        </label>
        <div className="relative">
          <input
            id={inputId}
            type={show ? 'text' : 'password'}
            value={phrase}
            onChange={(e) => { setPhrase(e.target.value); setError(null) }}
            placeholder="Your 12 or 24 words"
            aria-describedby={noteId}
            disabled={busy}
            // Never offered to the browser's or a password manager's saving, autofill or correction.
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            data-1p-ignore
            data-lpignore="true"
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
          {error ?? 'Your recovery phrase stays on this device and is never saved. Only enter it on yap.pr.'}
        </p>
      </div>
      <Button type="submit" disabled={busy || !phrase.trim()} className="w-full" size="lg">
        {busy ? (
          <span className="flex items-center justify-center gap-2">
            <Spinner size="sm" className="border-white" />
            {phase.kind === 'finding' ? 'Finding your account' : 'Signing in'}
          </span>
        ) : 'Sign In'}
      </Button>
    </form>
  )
}
