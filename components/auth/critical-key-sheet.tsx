'use client'

import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { FingerPrintIcon, KeyIcon } from '@heroicons/react/24/outline'
import { Modal, ModalTitle } from '@/components/ui/modal'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import {
  answerCriticalKeyRequest,
  cancelCriticalKeyRequest,
  currentCriticalKeyRequest,
  subscribeCriticalKeyRequests,
  type CriticalKeyRequest,
} from '@/lib/auth/critical-key'
import { criticalKeyFromPhrase, criticalKeyFromPrivateKey, looksLikeRecoveryPhrase, type CriticalKeyInput } from '@/lib/auth/critical-key-input'
import { recoveryPhraseOffered } from '@/lib/auth/recovery-phrase'
import { PasskeyVaultError, hasCriticalKeyPasskey, passkeysOffered, unlockCriticalKeyWithPasskey } from '@/lib/auth/passkey-vault'
import { getConfiguredNetwork, keyNetwork } from '@/lib/constants'
import { identityService } from '@/lib/services/identity-service'
import { logger } from '@/lib/logger'

const INPUT = 'w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-neutral-800 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-yappr-500'

const COPY = {
  moderation: {
    title: 'Confirm with your CRITICAL key',
    why: 'Moderation actions need your account\'s highest-level key. It stays on this tab only.',
  },
  token: {
    title: 'Confirm with your highest-security key',
    why: 'This needs your account\'s highest-security key. It stays on this tab only.',
  },
} as const

/**
 * The one sheet every action that needs the account's CRITICAL key asks with
 * (lib/auth/critical-key.ts): moderation, the starter claim, YAPP tips and
 * purchases. It opens once the action is confirmed and the session holds no
 * such key. The key (pasted as WIF or hex), a recovery phrase it is derived
 * from, or, for moderation, a passkey that holds it, is checked against the
 * account's keys read fresh before the action goes on. Closing the sheet stops
 * the action. Nothing typed here is stored; with "Keep for this tab" on, the
 * key is held in this tab's memory until sign-out.
 */
export function CriticalKeySheet() {
  const request = useSyncExternalStore(subscribeCriticalKeyRequests, currentCriticalKeyRequest, () => null)
  return request ? <CriticalKeyForm key={request.id} request={request} /> : null
}

function CriticalKeyForm({ request }: { request: CriticalKeyRequest }) {
  const { identityId, use, prompt } = request
  // Uncontrolled: the key or phrase is read from the field when it is checked and cleared from it once used,
  // never copied into React state.
  const field = useRef<HTMLInputElement>(null)
  const [hasText, setHasText] = useState(false)
  /** Masked as text where CSS can (a password field would be offered for saving), else a password field. */
  const [cssMasking, setCssMasking] = useState(true)
  useEffect(() => setCssMasking(typeof CSS !== 'undefined' && CSS.supports('-webkit-text-security', 'disc')), [])
  const [keep, setKeep] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'key' | 'passkey' | null>(null)
  const [passkey, setPasskey] = useState(false)
  // Another key than the CRITICAL one (a MASTER key, say): the caller's words and check; never kept, no phrase or passkey.
  const phraseAllowed = !prompt && recoveryPhraseOffered(getConfiguredNetwork())
  const copy = prompt ? { title: prompt.title, why: prompt.why } : COPY[use]

  // A passkey's CRITICAL key moderates, but never signs a token transition (docs/PASSKEY_VAULT.md, V2).
  useEffect(() => {
    if (prompt || use !== 'moderation' || !passkeysOffered()) return
    let cancelled = false
    hasCriticalKeyPasskey(identityId)
      .then((found) => { if (!cancelled) setPasskey(found) })
      .catch(() => { /* hasCriticalKeyPasskey answers false on failure */ })
    return () => { cancelled = true }
  }, [identityId, use, prompt])

  const clearField = () => {
    if (field.current) field.current.value = ''
    setHasText(false)
  }

  const cancel = () => {
    clearField()
    cancelCriticalKeyRequest(request)
  }

  const check = async (typed: string): Promise<CriticalKeyInput> => {
    const network = keyNetwork()
    // Read fresh: a key disabled moments ago must not sign.
    const identity = await identityService.getIdentity(identityId, { fresh: true })
    if (!identity) return { ok: false, error: 'Your account couldn\'t be read. Try again in a moment.' }
    if (!looksLikeRecoveryPhrase(typed)) return criticalKeyFromPrivateKey(typed, identity.publicKeys, network)
    if (!phraseAllowed) return { ok: false, error: 'Paste your private key instead.' }
    const { openRecoveryPhrase, PhraseSignInError } = await import('@/lib/auth/recovery-phrase-sign-in')
    try {
      const wallet = await openRecoveryPhrase(typed)
      return await criticalKeyFromPhrase(wallet, identity.publicKeys, network, (hash) => identityService.getIdentityIdByPublicKeyHash(hash))
    } catch (failure) {
      if (failure instanceof PhraseSignInError) return { ok: false, error: failure.message }
      throw failure
    }
  }

  const submit = async () => {
    const typed = field.current?.value.trim() ?? ''
    if (!typed || busy) return
    setBusy('key')
    setError(null)
    try {
      if (prompt) {
        const problem = await prompt.check(typed)
        if (problem) {
          setError(problem)
          return
        }
        clearField()
        answerCriticalKeyRequest(request, { wif: typed, source: 'typed', keep: false })
        return
      }
      const result = await check(typed)
      if (!result.ok) {
        setError(result.error)
        return
      }
      clearField()
      answerCriticalKeyRequest(request, { wif: result.wif, source: looksLikeRecoveryPhrase(typed) ? 'phrase' : 'typed', keep })
    } catch (failure) {
      logger.warn('Step-up key check failed:', failure instanceof Error ? failure.name : 'unknown')
      setError('That couldn\'t be checked right now. Try again in a moment.')
    } finally {
      setBusy(null)
    }
  }

  const openPasskey = async () => {
    if (busy) return
    setBusy('passkey')
    setError(null)
    try {
      const wif = await unlockCriticalKeyWithPasskey(identityId)
      clearField()
      answerCriticalKeyRequest(request, { wif, source: 'passkey', keep })
    } catch (failure) {
      if (failure instanceof PasskeyVaultError && failure.code === 'cancelled') return
      setError(failure instanceof PasskeyVaultError && failure.code === 'not-eligible'
        ? 'That passkey doesn\'t hold this account\'s CRITICAL key.'
        : 'That passkey couldn\'t be used. Try again, or paste the key.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <Modal open onOpenChange={(open) => { if (!open && !busy) cancel() }} className="w-[420px] max-w-[90vw]">
      <ModalTitle>
        <KeyIcon className="h-6 w-6 text-amber-600" />
        {copy.title}
      </ModalTitle>
      <Dialog.Description className="text-sm text-gray-600 dark:text-gray-400 mb-4" data-testid="critical-key-why">
        {copy.why}
      </Dialog.Description>
      {/* No <form>: a form that goes away once submitted reads to browsers as a sign-in whose password they offer to save. */}
      <div>
        <label htmlFor="critical-key-input" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          {prompt ? prompt.label : phraseAllowed ? 'Private key or recovery phrase' : 'Private key'}
        </label>
        <input
          ref={field}
          id="critical-key-input"
          data-testid="critical-key-input"
          type={cssMasking ? 'text' : 'password'}
          onInput={(event) => { setHasText(event.currentTarget.value.trim().length > 0); setError(null) }}
          onKeyDown={(event) => { if (event.key === 'Enter') submit().catch(() => { /* reported inside */ }) }}
          style={cssMasking ? { WebkitTextSecurity: 'disc' } as CSSProperties : undefined}
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          data-1p-ignore
          data-lpignore="true"
          data-bwignore
          data-form-type="other"
          disabled={busy !== null}
          className={`${INPUT} [&::-webkit-credentials-auto-fill-button]:!hidden`}
        />
        {error && <p role="alert" className="mt-2 text-sm text-red-500" data-testid="critical-key-error">{error}</p>}
        {!prompt && (
          <div className="mt-4 flex items-center justify-between gap-3">
            <label htmlFor="critical-key-keep" className="text-sm text-gray-700 dark:text-gray-300">
              Keep for this tab
              <span className="block text-xs text-gray-500">Off: used for this action only.</span>
            </label>
            <Switch id="critical-key-keep" data-testid="critical-key-keep" checked={keep} onCheckedChange={setKeep} disabled={busy !== null} />
          </div>
        )}
        <div className="mt-5 flex flex-col gap-3">
          <Button type="button" data-testid="critical-key-continue" disabled={!hasText || busy !== null} onClick={() => { submit().catch(() => { /* reported inside */ }) }} className="w-full">
            {busy === 'key' ? 'Checking…' : 'Continue'}
          </Button>
          {passkey && (
            <Button type="button" variant="outline" data-testid="critical-key-passkey" disabled={busy !== null} onClick={() => { openPasskey().catch(() => { /* reported inside */ }) }} className="w-full gap-2">
              <FingerPrintIcon className="h-4 w-4" />
              {busy === 'passkey' ? 'Opening your passkey…' : 'Use a passkey'}
            </Button>
          )}
          <Button type="button" variant="outline" data-testid="critical-key-cancel" disabled={busy !== null} onClick={cancel} className="w-full">Cancel</Button>
        </div>
      </div>
    </Modal>
  )
}
