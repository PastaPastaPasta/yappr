'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { CheckCircleIcon, KeyIcon } from '@heroicons/react/24/outline'
import { logger } from '@/lib/logger'
import { useAuth } from '@/contexts/auth-context'
import { usePasskeyPrompts } from '@/hooks/use-passkey-prompts'
import { hasAppConnectSession } from '@/lib/auth/signing-keys'
import { markPasskeyOfferMade, passkeyOfferMade, passkeysHere } from '@/lib/auth/passkey-device'
import {
  finishPasskeyEnrolment,
  listPasskeys,
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
import { enrolErrorCopy, formatPasskeyDate, passkeyLabel } from './passkey-copy'

/** Fired on `window` after passkeys were added, updated or removed, so lists re-read them. */
export const PASSKEYS_CHANGED_EVENT = 'yappr-passkeys-changed'

function announceChange(): void {
  window.dispatchEvent(new Event(PASSKEYS_CHANGED_EVENT))
}

/**
 * The passkey dialogs, mounted once. After a sign-in (not a restored session)
 * it checks the identity's passkeys: when one no longer signs in it asks the
 * user to review and update them; otherwise, after a wallet or key sign-in
 * on a device that has never been offered one, it offers a passkey, once.
 */
export function PasskeyPrompts() {
  const { user } = useAuth()
  const signedIn = usePasskeyPrompts((state) => state.signedIn)
  const { offer, enrol, review, openOffer, openReview, close } = usePasskeyPrompts()
  const signedInUser = user?.identityId
  /** The sign-in last checked: each is checked once, whatever else re-renders. */
  const checkedAt = useRef<number | null>(null)

  useEffect(() => {
    if (!signedIn || signedInUser !== signedIn.identityId || checkedAt.current === signedIn.at || !passkeysOffered()) return
    checkedAt.current = signedIn.at
    const { identityId, method } = signedIn
    const check = async () => {
      const [entries, eligibility] = await Promise.all([listPasskeys(identityId), passkeyEligibility(identityId)])
      // Another sign-in (or a sign-out) since this one: its own check decides.
      if (eligibility !== null || usePasskeyPrompts.getState().signedIn?.at !== signedIn.at) return
      if (entries.some((entry) => entry.needsUpdate)) {
        openReview(identityId)
        return
      }
      if (method !== 'passkey' && passkeysHere(identityId).length === 0 && !passkeyOfferMade()) {
        markPasskeyOfferMade()
        openOffer(identityId)
      }
    }
    check().catch((error: unknown) => logger.warn('Passkeys: the after-sign-in check failed:', error))
  }, [openOffer, openReview, signedIn, signedInUser])

  const identityId = offer ?? enrol ?? review
  // A dialog for an identity that is no longer signed in here has nothing to do.
  if (!identityId || user?.identityId !== identityId) return null

  return (
    <>
      {(offer || enrol) && <EnrolDialog identityId={identityId} username={user.dpnsUsername} offer={Boolean(offer)} onClose={close} />}
      {review && <ReviewDialog identityId={identityId} onClose={close} />}
    </>
  )
}

type EnrolStep =
  | { kind: 'intro' }
  | { kind: 'creating' }
  | { kind: 'confirm'; pending: PendingPasskey }
  | { kind: 'saving' }
  | { kind: 'done' }
  | { kind: 'error'; message: string }

function EnrolDialog({ identityId, username, offer, onClose }: { identityId: string; username?: string; offer: boolean; onClose: () => void }) {
  const [step, setStep] = useState<EnrolStep>({ kind: 'intro' })
  const busy = step.kind === 'creating' || step.kind === 'saving'

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
        announceChange()
        setStep({ kind: 'done' })
      })
      .catch((error: unknown) => fail(error, { kind: 'confirm', pending }))
  }, [fail])

  return (
    <Modal open onOpenChange={(open) => { if (!open && !busy) onClose() }} className="w-[440px] max-w-[92vw]">
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
          {step.kind === 'confirm' ? (
            <p className="text-sm text-gray-700 dark:text-gray-300 mb-5">Almost done. Confirm your passkey once more.</p>
          ) : (
            <p className="text-sm text-gray-500 mb-5">Saving it costs less than 3¢ from your balance.</p>
          )}
          {step.kind === 'error' && <p role="alert" className="text-sm text-red-600 dark:text-red-400 mb-4">{step.message}</p>}
          <div className="flex flex-col gap-3">
            {step.kind === 'confirm' ? (
              <Button className="w-full" onClick={() => confirm(step.pending)} data-testid="passkey-confirm">Confirm</Button>
            ) : (
              <Button className="w-full gap-2" onClick={create} disabled={busy} data-testid="passkey-add">
                {busy && <Spinner size="sm" />}
                {step.kind === 'saving' ? 'Saving…' : step.kind === 'creating' ? 'Waiting for your passkey…' : 'Add a passkey'}
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
 * The mandatory review before passkeys are updated (owner decision V1): any
 * signed-in device can re-seal every passkey, so the user sees every one,
 * picks which to update, and can remove them all and start over if one is
 * not theirs.
 */
function ReviewDialog({ identityId, onClose }: { identityId: string; onClose: () => void }) {
  const openEnrol = usePasskeyPrompts((state) => state.openEnrol)
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
        setChecked(new Set(list.filter((entry) => entry.needsUpdate).map((entry) => entry.entryId)))
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
    const ids = [...checked]
    setStep({ kind: 'working' })
    updatePasskeys(identityId, ids)
      .then(({ failed }) => {
        announceChange()
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
  }, [checked, entries, identityId, onClose])

  const remove = useCallback((all: boolean, ids: string[]) => {
    setStep({ kind: 'working' })
    const removal = all ? removeAllPasskeys(identityId) : removePasskeys(identityId, ids)
    removal
      .then(({ failed }) => {
        announceChange()
        if (failed > 0) setStep({ kind: 'error', message: 'Some passkeys couldn\'t be removed. Please try again.' })
        else if (all) setStep({ kind: 'started-over' })
        else onClose()
      })
      .catch((error: unknown) => {
        logger.warn('Passkeys: removing failed:', error)
        setStep({ kind: 'error', message: 'Your passkeys couldn\'t be removed. Please try again.' })
      })
  }, [identityId, onClose])

  const working = step.kind === 'working'

  return (
    <Modal open onOpenChange={(open) => { if (!open && !working) onClose() }} className="w-[480px] max-w-[94vw]">
      <ModalTitle><KeyIcon className="h-6 w-6 text-yappr-500" />Update your passkeys</ModalTitle>
      {step.kind === 'started-over' ? (
        <>
          <Dialog.Description className="text-gray-600 dark:text-gray-400 mb-5">
            Your passkeys were removed. Add a new one for this device to keep signing in with a passkey.
          </Dialog.Description>
          <div className="flex flex-col gap-3">
            <Button className="w-full" onClick={() => openEnrol(identityId)}>Add a passkey</Button>
            <Button variant="outline" className="w-full" onClick={onClose}>Not now</Button>
          </div>
        </>
      ) : step.kind === 'start-over' ? (
        <>
          <Dialog.Description className="text-gray-600 dark:text-gray-400 mb-3">
            Remove every passkey, including any you don&apos;t recognise? None of them will sign you in to Yappr any more. You can add yours again straight after.
          </Dialog.Description>
          <p className="text-sm text-gray-500 mb-5">
            {wallet
              ? 'If you think someone else signed in as you, also turn off Yappr in your Dash wallet. Copies saved earlier stay on the network until you do.'
              : 'If you think someone else has your key, also change it in your Dash wallet. Copies saved earlier stay on the network until you do.'}
          </p>
          <div className="flex flex-col gap-3">
            <Button className="w-full bg-red-600 hover:bg-red-700 text-white" onClick={() => remove(true, [])}>Remove all passkeys</Button>
            <Button variant="outline" className="w-full" onClick={() => setStep({ kind: 'list' })}>Back</Button>
          </div>
        </>
      ) : step.kind === 'leftover' ? (
        <>
          <Dialog.Description className="text-gray-600 dark:text-gray-400 mb-5">
            {step.ids.length === 1 ? 'One passkey wasn\'t updated and can\'t sign you in. Remove it?' : `${step.ids.length} passkeys weren't updated and can't sign you in. Remove them?`}
          </Dialog.Description>
          <div className="flex flex-col gap-3">
            <Button className="w-full" onClick={() => remove(false, step.ids)}>Remove</Button>
            <Button variant="outline" className="w-full" onClick={onClose}>Keep</Button>
          </div>
        </>
      ) : (
        <>
          <Dialog.Description className="text-gray-600 dark:text-gray-400 mb-4">
            Your sign-in changed, so some passkeys need updating to keep signing you in. Check that you recognise each one.
          </Dialog.Description>
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
                      <span className="block text-gray-500">
                        {entry.name ? `Added ${formatPasskeyDate(entry.addedAt)}` : null}
                        {entry.name && (entry.thisDevice || entry.needsUpdate) ? ' · ' : null}
                        {entry.thisDevice ? 'This device' : null}
                        {entry.thisDevice && entry.needsUpdate ? ' · ' : null}
                        {entry.needsUpdate ? 'Needs update' : null}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          {step.kind === 'error' && <p role="alert" className="text-sm text-red-600 dark:text-red-400 mb-4">{step.message}</p>}
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
              disabled={working || !entries || entries.length === 0}
            >
              Don&apos;t recognise one? Remove all and start over
            </button>
          </div>
        </>
      )}
    </Modal>
  )
}
