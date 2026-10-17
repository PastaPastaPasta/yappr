'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { CheckCircleIcon, KeyIcon } from '@heroicons/react/24/outline'
import { logger } from '@/lib/logger'
import { useAuth } from '@/contexts/auth-context'
import { usePasskeyPrompts } from '@/hooks/use-passkey-prompts'
import { useUsernameModal } from '@/hooks/use-username-modal'
import { hasAppConnectSession } from '@/lib/auth/signing-keys'
import { markPasskeyOfferMade, passkeyOfferMade, passkeysHere } from '@/lib/auth/passkey-device'
import {
  PasskeyVaultError,
  finishPasskeyEnrolment,
  listPasskeys,
  passkeySaved,
  pendingEnrolmentFor,
  passkeyEligibility,
  passkeysOffered,
  removeAllPasskeys,
  removePasskeys,
  startPasskeyEnrolment,
  updatePasskeys,
  type PasskeyEntryView,
  type PendingPasskey,
} from '@/lib/auth/passkey-vault'
import { Modal, ModalTitle } from '@/components/ui/modal'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { enrolErrorCopy, lockOutCopy, passkeyDetails, passkeyLabel } from './passkey-copy'

/** Resolves once the username prompt (opened by a sign-in without a Dash username) is closed. */
function usernamePromptClosed(): Promise<void> {
  if (!useUsernameModal.getState().isOpen) return Promise.resolve()
  return new Promise((resolve) => {
    const unsubscribe = useUsernameModal.subscribe((state) => {
      if (state.isOpen) return
      unsubscribe()
      resolve()
    })
  })
}

/** The after-sign-in check retries a failed read this often, waiting a little longer each time. */
const CHECK_ATTEMPTS = 4
const CHECK_RETRY_MS = 5_000

function InlineError({ children }: { children: React.ReactNode }) {
  return <p role="alert" className="text-sm text-red-600 dark:text-red-400 mb-4">{children}</p>
}

/**
 * The passkey dialogs, mounted once. After a sign-in (not a restored session)
 * it checks the identity's passkeys: when one no longer signs in it asks the
 * user to review and update them; otherwise, after a wallet or key sign-in
 * on a device that has never been offered one, it offers a passkey, once.
 */
export function PasskeyPrompts() {
  const { user } = useAuth()
  const { controller } = useAuth()
  const { signedIn, dialog, open, close } = usePasskeyPrompts()
  const signedInUser = user?.identityId
  /** The sign-in last checked: each is checked once, whatever else re-renders. */
  const checkedAt = useRef<number | null>(null)

  // Signing out (by hand, or after the wallet revoked) ends that session's checks and dialogs:
  // a check still reading sees its sign-in gone, and no dialog survives to the next sign-in.
  useEffect(() => {
    if (!signedInUser) usePasskeyPrompts.getState().reset()
  }, [signedInUser])

  useEffect(() => {
    if (!signedIn || signedInUser !== signedIn.identityId || checkedAt.current === signedIn.at || !passkeysOffered()) return
    checkedAt.current = signedIn.at
    const { identityId, method } = signedIn
    // The controller's epoch moves the moment a sign-out starts, before React sees the user go.
    const stillThisSignIn = () => usePasskeyPrompts.getState().signedIn?.at === signedIn.at && controller.sessionEpoch() === signedIn.epoch
    /** The passkeys and the session check; a read that failed is retried a few times before the check gives up. */
    const read = async () => {
      for (let attempt = 1; ; attempt += 1) {
        try {
          const [entries, eligibility] = await Promise.all([listPasskeys(identityId), passkeyEligibility(identityId)])
          if (eligibility !== 'failed' || attempt >= CHECK_ATTEMPTS) return { entries, eligibility }
        } catch (error) {
          if (attempt >= CHECK_ATTEMPTS) throw error
        }
        await new Promise((resolve) => setTimeout(resolve, CHECK_RETRY_MS * attempt))
        if (!stillThisSignIn()) return null
      }
    }
    const check = async () => {
      const result = await read()
      if (!result) return
      // A sign-in that asks for a username shows that first: the passkey dialog waits until it closes.
      await usernamePromptClosed()
      const { entries, eligibility } = result
      // Another sign-in (or a sign-out) since this one: its own check decides.
      if (eligibility !== null || !stillThisSignIn()) return
      if (entries.some((entry) => entry.needsUpdate)) {
        open('review', identityId)
        return
      }
      if ((method === 'key' || method === 'wallet') && passkeysHere(identityId).length === 0 && !passkeyOfferMade()) {
        markPasskeyOfferMade()
        open('offer', identityId)
      }
    }
    check().catch((error: unknown) => logger.warn('Passkeys: the after-sign-in check failed:', error))
  }, [controller, open, signedIn, signedInUser])

  // A dialog for an identity that is no longer signed in here has nothing to do.
  if (!dialog || !user || user.identityId !== dialog.identityId) return null
  if (dialog.kind === 'review') return <ReviewDialog identityId={dialog.identityId} onClose={close} />
  return <EnrolDialog identityId={dialog.identityId} username={user.dpnsUsername} offer={dialog.kind === 'offer'} onClose={close} />
}

type EnrolStep =
  | { kind: 'intro' }
  | { kind: 'creating' }
  | { kind: 'confirm'; pending: PendingPasskey }
  | { kind: 'saving' }
  /** Sent but not confirmed: only checking again is offered, never another passkey. */
  | { kind: 'pending'; pending: PendingPasskey; checking: boolean }
  | { kind: 'done' }
  | { kind: 'error'; message: string }

const ENROL_BUTTON: Partial<Record<EnrolStep['kind'], string>> = { creating: 'Waiting for your passkey…', saving: 'Saving…' }

function EnrolDialog({ identityId, username, offer, onClose }: { identityId: string; username?: string; offer: boolean; onClose: () => void }) {
  const changed = usePasskeyPrompts((state) => state.changed)
  const [step, setStep] = useState<EnrolStep>(() => {
    // An enrolment still settling resumes with only "Check again" (lib/auth/passkey-vault.ts retires it).
    const pending = pendingEnrolmentFor(identityId)
    return pending ? { kind: 'pending', pending, checking: false } : { kind: 'intro' }
  })
  const busy = step.kind === 'creating' || step.kind === 'saving' || (step.kind === 'pending' && step.checking)

  const fail = useCallback((error: unknown, back: EnrolStep) => {
    logger.warn('Passkeys: adding a passkey stopped:', error)
    const message = enrolErrorCopy(error)
    setStep(message ? { kind: 'error', message } : back)
  }, [])

  const create = useCallback(() => {
    setStep({ kind: 'creating' })
    startPasskeyEnrolment({ identityId, username })
      .then((pending) => setStep({ kind: 'confirm', pending }))
      .catch((error: unknown) => fail(error, { kind: 'intro' }))
  }, [fail, identityId, username])

  const confirm = useCallback((pending: PendingPasskey) => {
    setStep({ kind: 'saving' })
    finishPasskeyEnrolment(pending)
      .then(() => {
        changed()
        setStep({ kind: 'done' })
      })
      .catch((error: unknown) => {
        if (error instanceof PasskeyVaultError && error.code === 'pending') {
          // Kept past this dialog (the vault module holds it): reopening resumes it, and Settings may show the entry once it lands.
          changed()
          setStep({ kind: 'pending', pending, checking: false })
          return
        }
        fail(error, { kind: 'confirm', pending })
      })
  }, [changed, fail])

  const checkAgain = useCallback((pending: PendingPasskey) => {
    setStep({ kind: 'pending', pending, checking: true })
    passkeySaved(pending)
      .then((saved) => {
        changed()
        setStep(saved ? { kind: 'done' } : { kind: 'pending', pending, checking: false })
      })
      .catch((error: unknown) => {
        logger.warn('Passkeys: checking a saved passkey failed:', error)
        setStep({ kind: 'pending', pending, checking: false })
      })
  }, [changed])

  return (
    <Modal open onOpenChange={(next) => { if (!next && !busy) onClose() }} className="w-[440px] max-w-[92vw]">
      {step.kind === 'done' ? (
        <>
          <ModalTitle><CheckCircleIcon className="h-6 w-6 text-green-500" />Passkey added</ModalTitle>
          <Dialog.Description className="text-gray-600 dark:text-gray-400 mb-5">
            Next time, choose <strong>Sign in with a passkey</strong>.
          </Dialog.Description>
          <Button className="w-full" onClick={onClose}>Done</Button>
        </>
      ) : (
        <>
          <ModalTitle><KeyIcon className="h-6 w-6 text-yappr-500" />{offer ? 'Sign in faster with a passkey' : 'Add a passkey'}</ModalTitle>
          <Dialog.Description className="text-gray-600 dark:text-gray-400 mb-3">
            Use Face ID, Touch ID, Windows Hello or your phone to sign in to Yappr on any device. Your sign-in is saved encrypted, and only your passkey can open it.
          </Dialog.Description>
          {step.kind === 'pending' ? (
            <p className="text-sm text-gray-700 dark:text-gray-300 mb-5">{enrolErrorCopy(new PasskeyVaultError('pending'))}</p>
          ) : step.kind === 'confirm' ? (
            <p className="text-sm text-gray-700 dark:text-gray-300 mb-5">Almost done. Confirm your passkey once more.</p>
          ) : (
            <p className="text-sm text-gray-500 mb-5">Saving it costs less than 3¢ from your balance.</p>
          )}
          {step.kind === 'error' && <InlineError>{step.message}</InlineError>}
          <div className="flex flex-col gap-3">
            {step.kind === 'pending' ? (
              <Button className="w-full gap-2" onClick={() => checkAgain(step.pending)} disabled={busy}>
                {busy && <Spinner size="sm" />}
                Check again
              </Button>
            ) : step.kind === 'confirm' ? (
              <Button className="w-full" onClick={() => confirm(step.pending)} data-testid="passkey-confirm">Confirm</Button>
            ) : (
              <Button className="w-full gap-2" onClick={create} disabled={busy} data-testid="passkey-add">
                {busy && <Spinner size="sm" />}
                {ENROL_BUTTON[step.kind] ?? 'Add a passkey'}
              </Button>
            )}
            <Button variant="outline" className="w-full" onClick={onClose} disabled={busy}>Not now</Button>
          </div>
        </>
      )}
    </Modal>
  )
}

type ReviewStep =
  | { kind: 'list' }
  | { kind: 'working' }
  | { kind: 'leftover'; ids: string[] }
  | { kind: 'start-over' }
  | { kind: 'started-over' }
  | { kind: 'error'; message: string }

/**
 * The mandatory review before passkeys are updated (owner decision V1). Any
 * signed-in device can re-seal every passkey, and anyone who once held this
 * identity's keys can plant an entry that looks like a passkey from another
 * device. So only this device's passkeys start ticked; another device's must
 * be ticked by hand, and the user is steered to "Remove all and start over"
 * when one is not theirs.
 */
function ReviewDialog({ identityId, onClose }: { identityId: string; onClose: () => void }) {
  const { open, changed } = usePasskeyPrompts()
  const [entries, setEntries] = useState<PasskeyEntryView[] | null>(null)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [step, setStep] = useState<ReviewStep>({ kind: 'list' })
  const wallet = hasAppConnectSession(identityId)

  useEffect(() => {
    let cancelled = false
    listPasskeys(identityId)
      .then((list) => {
        if (cancelled) return
        setEntries(list)
        setChecked(new Set(list.filter((entry) => entry.needsUpdate && entry.thisDevice).map((entry) => entry.entryId)))
      })
      .catch((error: unknown) => {
        logger.warn('Passkeys: could not read them for the review:', error)
        if (!cancelled) setStep({ kind: 'error', message: 'Your passkeys couldn\'t be loaded. Please try again later.' })
      })
    return () => { cancelled = true }
  }, [identityId])

  const toggle = (entryId: string) => setChecked((current) => {
    const next = new Set(current)
    if (next.has(entryId)) next.delete(entryId)
    else next.add(entryId)
    return next
  })

  const update = useCallback(() => {
    if (!entries) return
    setStep({ kind: 'working' })
    updatePasskeys(identityId, [...checked])
      .then(({ failed }) => {
        changed()
        if (failed > 0) {
          setStep({ kind: 'error', message: 'Some passkeys couldn\'t be updated. Please try again.' })
          return
        }
        const leftover = entries.filter((entry) => !checked.has(entry.entryId) && entry.needsUpdate).map((entry) => entry.entryId)
        if (leftover.length > 0) setStep({ kind: 'leftover', ids: leftover })
        else onClose()
      })
      .catch((error: unknown) => {
        logger.warn('Passkeys: updating failed:', error)
        setStep({ kind: 'error', message: enrolErrorCopy(error) ?? 'Your passkeys couldn\'t be updated. Please try again.' })
      })
  }, [changed, checked, entries, identityId, onClose])

  const remove = useCallback((ids: string[] | 'all') => {
    setStep({ kind: 'working' })
    const removal = ids === 'all' ? removeAllPasskeys(identityId) : removePasskeys(identityId, ids)
    removal
      .then(({ failed }) => {
        changed()
        if (failed > 0) setStep({ kind: 'error', message: 'Some passkeys couldn\'t be removed. Please try again.' })
        else if (ids === 'all') setStep({ kind: 'started-over' })
        else onClose()
      })
      .catch((error: unknown) => {
        logger.warn('Passkeys: removing failed:', error)
        setStep({ kind: 'error', message: 'Your passkeys couldn\'t be removed. Please try again.' })
      })
  }, [changed, identityId, onClose])

  const working = step.kind === 'working'

  const body = (() => {
    switch (step.kind) {
      case 'started-over':
        return (
          <>
            <Dialog.Description className="text-gray-600 dark:text-gray-400 mb-5">
              Your passkeys were removed. Add a new one for this device to keep signing in with a passkey.
            </Dialog.Description>
            <div className="flex flex-col gap-3">
              <Button className="w-full" onClick={() => open('enrol', identityId)}>Add a passkey</Button>
              <Button variant="outline" className="w-full" onClick={onClose}>Not now</Button>
            </div>
          </>
        )
      case 'start-over':
        return (
          <>
            <Dialog.Description className="text-gray-600 dark:text-gray-400 mb-3">
              Remove every passkey, including any you don&apos;t recognise? None of them will sign you in to Yappr any more. You can add yours again straight after.
            </Dialog.Description>
            <p className="text-sm text-gray-500 mb-5">{lockOutCopy(wallet)}</p>
            <div className="flex flex-col gap-3">
              <Button variant="destructive" className="w-full" onClick={() => remove('all')}>Remove all passkeys</Button>
              <Button variant="outline" className="w-full" onClick={() => setStep({ kind: 'list' })}>Back</Button>
            </div>
          </>
        )
      case 'leftover':
        return (
          <>
            <Dialog.Description className="text-gray-600 dark:text-gray-400 mb-5">
              {step.ids.length === 1 ? 'One passkey wasn\'t updated and can\'t sign you in. Remove it?' : `${step.ids.length} passkeys weren't updated and can't sign you in. Remove them?`}
            </Dialog.Description>
            <div className="flex flex-col gap-3">
              <Button className="w-full" onClick={() => remove(step.ids)}>Remove</Button>
              <Button variant="outline" className="w-full" onClick={onClose}>Keep</Button>
            </div>
          </>
        )
      default:
        return (
          <>
            <Dialog.Description className="text-gray-600 dark:text-gray-400 mb-2">
              Your sign-in changed, so some passkeys need updating to keep signing you in. Tick only the passkeys you recognise.
            </Dialog.Description>
            <p className="text-sm text-gray-500 mb-4">
              If you turned Yappr off or changed your key because someone else had access, don&apos;t update: remove them all and start over.
            </p>
            {entries === null && step.kind !== 'error' && <div className="py-4 flex justify-center"><Spinner size="sm" /></div>}
            {entries && (
              <ul className="space-y-2 mb-4" data-testid="passkey-review-list">
                {entries.map((entry) => (
                  <li key={entry.entryId}>
                    <label className="flex items-start gap-3 rounded-xl ring-1 ring-gray-200 dark:ring-neutral-700 p-3 cursor-pointer">
                      <input
                        type="checkbox"
                        className="mt-1 h-4 w-4 accent-yappr-500"
                        checked={checked.has(entry.entryId)}
                        onChange={() => toggle(entry.entryId)}
                        disabled={working}
                      />
                      <span className="flex-1 text-sm">
                        <span className="font-medium text-gray-900 dark:text-white">{passkeyLabel(entry)}</span>
                        <span className="block text-gray-500">{passkeyDetails(entry)}</span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
            {step.kind === 'error' && <InlineError>{step.message}</InlineError>}
            <div className="flex flex-col gap-3">
              <Button className="w-full gap-2" onClick={update} disabled={working || !entries || checked.size === 0} data-testid="passkey-update">
                {working && <Spinner size="sm" />}
                {checked.size === 1 ? 'Update 1 passkey' : `Update ${checked.size} passkeys`}
              </Button>
              <Button variant="outline" className="w-full" onClick={onClose} disabled={working}>Later</Button>
              <button
                type="button"
                className="text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 underline underline-offset-4 disabled:opacity-50"
                onClick={() => setStep({ kind: 'start-over' })}
                // Reachable even when the list could not be read (say, a flood of planted entries): removal reads in rounds.
                disabled={working || entries?.length === 0}
              >
                Don&apos;t recognise one? Remove all and start over
              </button>
            </div>
          </>
        )
    }
  })()

  return (
    <Modal open onOpenChange={(next) => { if (!next && !working) onClose() }} className="w-[480px] max-w-[94vw] max-h-[90vh] overflow-y-auto">
      <ModalTitle><KeyIcon className="h-6 w-6 text-yappr-500" />Update your passkeys</ModalTitle>
      {body}
    </Modal>
  )
}
