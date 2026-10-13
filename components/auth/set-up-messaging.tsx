'use client'

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { ChatBubbleLeftRightIcon, DevicePhoneMobileIcon, KeyIcon } from '@heroicons/react/24/outline'
import { ModalTitle } from '@/components/ui/modal'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { logger } from '@/lib/logger'
import { sleep } from '@/lib/retry-utils'
import {
  addMessagingKeyWithLoginKey,
  addMessagingKeyWithMasterKey,
  adoptMessagingKey,
  anchorKeyState,
  draftMessagingKey,
  loginKeyIsMaster,
  messagingKeyHandOffUri,
  MessagingAlreadySetUpError,
  type MessagingKeyDraft,
} from '@/lib/services/messaging-key-service'
import { KeyExchangeQR } from './key-exchange-qr'

export type MessagingSetupContext = 'private-feed' | 'store' | 'generic'

const INTRO: Record<MessagingSetupContext, string> = {
  generic: 'Messages, store orders and private feeds are end-to-end encrypted. Set up messaging once to send and receive them.',
  store: 'Buyers send their shipping details privately. Set up messaging once so they can place orders.',
  'private-feed': 'Private feeds are encrypted. Set up messaging once to use them.',
}

/** How long the wallet has to approve before "Check again"; deliberately never shown as a countdown. */
const HAND_OFF_BUDGET_MS = 5 * 60_000
const HAND_OFF_POLL_MS = 3_000
/** After a MASTER-signed update: how long to wait for Platform to show the key as current. */
const CONFIRM_ATTEMPTS = 6
const CONFIRM_DELAY_MS = 2_000

type Phase =
  | { kind: 'loading' }
  | { kind: 'choose' }
  | { kind: 'wallet'; uri: string | null; expired: boolean }
  | { kind: 'master-key' }
  | { kind: 'working' }
  | { kind: 'failed'; message: string }

/**
 * Refusals that happen before anything is broadcast (identityService.addEncryptionKey's checks), so
 * there is nothing to wait for. Any other failure may be a broadcast whose answer was lost.
 */
const REFUSED_BEFORE_BROADCAST = /require a MASTER key|does not match any key|already set up|invalid (private )?key|checksum|not found/i

/** Consumer-grade wording for a failed MASTER-signed update. */
function masterKeyFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  if (/require a MASTER key/i.test(message)) return 'That key can\'t approve this. Enter your account\'s master key.'
  if (/does not match any key/i.test(message)) return 'That key isn\'t one of this account\'s keys.'
  if (/invalid (private )?key|checksum|wif/i.test(message)) return 'That doesn\'t look like a private key. Check it and try again.'
  return 'Couldn\'t set up messaging. Try again in a moment.'
}

/**
 * "Set up messaging" for a raw-key sign-in on an App Connect build whose
 * identity has no messaging key yet (lib/services/messaging-key-service.ts).
 * The one IdentityUpdate needs a MASTER signature: when the login key is the
 * MASTER key it signs here; otherwise the wallet approves a `dash-st:`
 * hand-off, or the user enters their master key. `onDone` gets the identity
 * and the adopted key's WIF once Platform shows it as the current key.
 * `onAlreadySetUp` runs instead when the account has another messaging key
 * (made elsewhere, or by another device meanwhile): it is never replaced here.
 */
export function SetUpMessaging({
  identityId,
  context,
  onDone,
  onAlreadySetUp,
  onCancel,
}: {
  identityId: string
  context: MessagingSetupContext
  onDone: (identityId: string, encryptionKeyWif: string) => void
  onAlreadySetUp: () => void
  onCancel: () => void
}) {
  const masterKeyInputId = useId()
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })
  const [draft, setDraft] = useState<MessagingKeyDraft | null>(null)
  const [masterKey, setMasterKey] = useState('')
  const [masterKeyError, setMasterKeyError] = useState<string | null>(null)
  const [handOffAttempt, setHandOffAttempt] = useState(0)
  /** Bumped by "Try again" after a failed load, to run the account checks again. */
  const [loadAttempt, setLoadAttempt] = useState(0)
  /** Whether the session's login key is the MASTER key, which signs the update here. */
  const [loginIsMaster, setLoginIsMaster] = useState(false)
  const finishedRef = useRef(false)
  const aliveRef = useRef(true)
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone
  const onAlreadySetUpRef = useRef(onAlreadySetUp)
  onAlreadySetUpRef.current = onAlreadySetUp

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  // Only while this dialog is open: if it closed first, the next opening finds the key current and adopts it.
  const finish = useCallback((ready: MessagingKeyDraft) => {
    if (finishedRef.current || !aliveRef.current) return
    finishedRef.current = true
    onDoneRef.current(ready.identityId, adoptMessagingKey(ready))
  }, [])

  const alreadySetUp = useCallback(() => {
    if (finishedRef.current || !aliveRef.current) return
    finishedRef.current = true
    onAlreadySetUpRef.current()
  }, [])

  // Draft the key for this identity, and finish at once when it is already the current key
  // (a wallet that approved after this dialog closed last time).
  useEffect(() => {
    let cancelled = false
    finishedRef.current = false
    setPhase({ kind: 'loading' })
    let next: MessagingKeyDraft
    try {
      next = draftMessagingKey(identityId)
    } catch (error) {
      setPhase({ kind: 'failed', message: error instanceof Error ? error.message : 'Couldn\'t set up messaging.' })
      return
    }
    setDraft(next)
    Promise.all([anchorKeyState(next), loginKeyIsMaster(identityId)])
      .then(([state, master]) => {
        if (cancelled) return
        setLoginIsMaster(master)
        if (state === 'this-key') finish(next)
        else if (state === 'other-key') alreadySetUp()
        else setPhase({ kind: 'choose' })
      })
      .catch((error) => {
        logger.warn('Messaging setup: could not read the account:', error)
        if (!cancelled) setPhase({ kind: 'failed', message: 'Couldn\'t reach Dash Platform. Check your connection and try again.' })
      })
    return () => {
      cancelled = true
    }
  }, [identityId, finish, alreadySetUp, loadAttempt])

  // The wallet hand-off: build the request, then watch for the key to become current.
  const walletActive = phase.kind === 'wallet' && !phase.expired
  useEffect(() => {
    if (!walletActive || !draft) return
    let cancelled = false
    let checking = false
    const started = Date.now()
    messagingKeyHandOffUri(draft)
      .then((uri) => {
        if (!cancelled) setPhase({ kind: 'wallet', uri, expired: false })
      })
      .catch((error) => {
        if (cancelled) return
        if (error instanceof MessagingAlreadySetUpError) {
          alreadySetUp()
          return
        }
        logger.warn('Messaging setup: could not build the wallet request:', error)
        setPhase({ kind: 'failed', message: 'Couldn\'t prepare the request for your wallet. Try again in a moment.' })
      })
    const timer = setInterval(() => {
      if (Date.now() - started > HAND_OFF_BUDGET_MS) {
        clearInterval(timer)
        setPhase((current) => current.kind === 'wallet' ? { ...current, expired: true } : current)
        return
      }
      if (checking) return
      checking = true
      anchorKeyState(draft)
        .then((state) => {
          if (cancelled) return
          if (state === 'this-key') finish(draft)
          // Another device set up messaging meanwhile: approving this request would replace its key.
          else if (state === 'other-key') alreadySetUp()
        })
        .catch((error) => logger.debug('Messaging setup: check failed, will retry:', error))
        .finally(() => {
          checking = false
        })
    }, HAND_OFF_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [walletActive, draft, handOffAttempt, finish, alreadySetUp])

  /** A MASTER-signed update (`add`), then wait for Platform to show the key as current. */
  const signWithMaster = useCallback(async (ready: MessagingKeyDraft, add: () => Promise<void>, fromMasterKeyForm: boolean) => {
    setPhase({ kind: 'working' })
    setMasterKeyError(null)
    let failure: unknown = null
    try {
      await add()
    } catch (error) {
      failure = error
    }
    // A broadcast whose answer timed out may still land, so only a refusal before broadcast skips the wait.
    const refused = failure !== null && REFUSED_BEFORE_BROADCAST.test(failure instanceof Error ? failure.message : '')
    const attempts = refused ? 1 : CONFIRM_ATTEMPTS
    for (let attempt = 0; attempt < attempts && aliveRef.current; attempt++) {
      if (attempt > 0) await sleep(CONFIRM_DELAY_MS)
      const state = await anchorKeyState(ready).catch(() => null)
      if (state === 'this-key') {
        finish(ready)
        return
      }
      if (state === 'other-key') {
        alreadySetUp()
        return
      }
    }
    if (!aliveRef.current) return
    logger.warn('Messaging setup: the master-signed update did not land:', failure)
    if (failure && fromMasterKeyForm) {
      setMasterKeyError(masterKeyFailure(failure))
      setPhase({ kind: 'master-key' })
    } else if (failure) {
      setPhase({ kind: 'failed', message: masterKeyFailure(failure) })
    } else {
      setPhase({ kind: 'failed', message: 'Your change was sent but hasn\'t shown up yet. Try again in a minute.' })
    }
  }, [finish, alreadySetUp])

  const signWithLoginKey = () => {
    if (!draft) return
    signWithMaster(draft, () => addMessagingKeyWithLoginKey(draft), false)
      .catch((error) => logger.error('Messaging setup failed:', error))
  }

  const submitMasterKey = (wif: string) => {
    if (!draft) return
    signWithMaster(draft, () => addMessagingKeyWithMasterKey(draft, wif), true)
      .catch((error) => logger.error('Messaging setup failed:', error))
  }

  const startWallet = () => {
    setMasterKey('')
    setMasterKeyError(null)
    setHandOffAttempt((n) => n + 1)
    setPhase({ kind: 'wallet', uri: null, expired: false })
  }

  const trimmedMasterKey = masterKey.trim()
  const title = (
    <ModalTitle>
      <ChatBubbleLeftRightIcon className="h-6 w-6 text-yappr-500" />
      Set up messaging
    </ModalTitle>
  )

  switch (phase.kind) {
    case 'loading':
    case 'working':
      return (
        <>
          {title}
          <div role="status" className="flex flex-col items-center justify-center py-8 gap-4">
            <Spinner size="lg" />
            <p className="text-gray-600 dark:text-gray-400 text-center">
              {phase.kind === 'working' ? 'Setting up messaging…' : 'Checking your account…'}
            </p>
          </div>
        </>
      )

    case 'failed':
      return (
        <>
          {title}
          <Dialog.Description className="text-gray-600 dark:text-gray-400 mb-6">{phase.message}</Dialog.Description>
          <div className="flex flex-col gap-3">
            {draft && (
              <Button onClick={() => setLoadAttempt((n) => n + 1)} className="w-full">Try again</Button>
            )}
            <Button onClick={onCancel} variant="outline" className="w-full">Close</Button>
          </div>
        </>
      )

    case 'choose':
      return (
        <>
          {title}
          <Dialog.Description className="text-gray-600 dark:text-gray-400 mb-4">{INTRO[context]}</Dialog.Description>
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
            This adds a messaging key to your Dash account. It can only encrypt messages to you: it can&apos;t spend your
            credits or post for you.
          </p>
          <div className="flex flex-col gap-3">
            {loginIsMaster ? (
              <Button onClick={signWithLoginKey} className="w-full">
                <ChatBubbleLeftRightIcon className="h-4 w-4 mr-2" />
                Set up messaging
              </Button>
            ) : (
              <>
                <Button onClick={startWallet} className="w-full">
                  <DevicePhoneMobileIcon className="h-4 w-4 mr-2" />
                  Approve in your wallet
                </Button>
                <Button onClick={() => setPhase({ kind: 'master-key' })} variant="outline" className="w-full">
                  <KeyIcon className="h-4 w-4 mr-2" />
                  Use your master key instead
                </Button>
              </>
            )}
            <Button onClick={onCancel} variant="ghost" className="w-full">Not now</Button>
          </div>
        </>
      )

    case 'wallet':
      return (
        <>
          {title}
          <Dialog.Description className="text-gray-600 dark:text-gray-400 mb-4">
            Approve adding a messaging key to your account in your Dash wallet.
          </Dialog.Description>
          {phase.expired ? (
            <div className="flex flex-col items-center gap-4 py-4">
              <p className="text-sm text-gray-600 dark:text-gray-400 text-center">No answer from your wallet yet.</p>
              <Button onClick={startWallet} className="w-full">Check again</Button>
            </div>
          ) : phase.uri ? (
            <>
              <KeyExchangeQR uri={phase.uri} size={200} />
              <p role="status" className="mt-4 flex items-center justify-center gap-2 text-sm text-gray-500 dark:text-gray-400">
                <Spinner size="xs" />
                Waiting for your wallet…
              </p>
            </>
          ) : (
            <div role="status" className="flex justify-center py-8"><Spinner size="lg" /></div>
          )}
          <div className="mt-4 flex flex-col gap-2">
            <Button onClick={() => setPhase({ kind: 'master-key' })} variant="ghost" className="w-full text-sm">
              Use your master key instead
            </Button>
            <Button onClick={onCancel} variant="outline" className="w-full">Cancel</Button>
          </div>
        </>
      )

    case 'master-key':
      return (
        <>
          {title}
          <Dialog.Description className="text-gray-600 dark:text-gray-400 mb-4">
            Enter your account&apos;s master key to approve this one change. It isn&apos;t saved.
          </Dialog.Description>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              if (trimmedMasterKey) submitMasterKey(trimmedMasterKey)
            }}
            className="space-y-4"
          >
            <div className="space-y-2">
              <label htmlFor={masterKeyInputId} className="text-sm font-medium">Master key</label>
              <Input
                id={masterKeyInputId}
                type="password"
                autoComplete="off"
                placeholder="WIF or hex"
                value={masterKey}
                onChange={(event) => {
                  setMasterKey(event.target.value)
                  setMasterKeyError(null)
                }}
                className="font-mono text-sm"
                autoFocus
              />
              {masterKeyError && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{masterKeyError}</p>}
            </div>
            <div className="flex flex-col gap-3">
              <Button type="submit" disabled={!trimmedMasterKey} className="w-full">Set up messaging</Button>
              <Button type="button" onClick={startWallet} variant="ghost" className="w-full text-sm">
                Approve in your wallet instead
              </Button>
              <Button type="button" onClick={onCancel} variant="outline" className="w-full">Cancel</Button>
            </div>
          </form>
        </>
      )
  }
}
