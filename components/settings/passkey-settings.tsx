'use client'

import { useCallback, useEffect, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { logger } from '@/lib/logger'
import { useAuth } from '@/contexts/auth-context'
import { usePasskeyPrompts, usePasskeysOffered } from '@/hooks/use-passkey-prompts'
import { hasAppConnectSession } from '@/lib/auth/signing-keys'
import { MAX_PASSKEY_NAME_LENGTH, setPasskeyName } from '@/lib/auth/passkey-device'
import { MAX_PASSKEYS } from '@/lib/auth/passkey-vault-policy'
import {
  listPasskeys,
  passkeyEligibility,
  removePasskeys,
  walletPasskeysPossible,
  type PasskeyEntryView,
  type PasskeyErrorCode,
} from '@/lib/auth/passkey-vault'
import { NOT_ELIGIBLE_COPY, formatPasskeyDate, lockOutCopy, passkeyLabel } from '@/components/auth/passkey-copy'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Modal, ModalTitle } from '@/components/ui/modal'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'

/**
 * Settings → Privacy & Security → Passkeys: the identity's passkeys, with
 * this device and any that need updating marked; add, update (after review),
 * rename (names stay in this browser) and remove. Shown only where passkeys
 * work.
 */
export function PasskeySettings() {
  const { user } = useAuth()
  const { open, revision } = usePasskeyPrompts()
  const offered = usePasskeysOffered()
  const [entries, setEntries] = useState<PasskeyEntryView[] | null>(null)
  const [eligibility, setEligibility] = useState<PasskeyErrorCode | null | undefined>(undefined)
  const [failed, setFailed] = useState(false)
  const [renaming, setRenaming] = useState<{ marker: string; name: string } | null>(null)
  const [removing, setRemoving] = useState<PasskeyEntryView | null>(null)

  const identityId = user?.identityId
  const wallet = identityId ? hasAppConnectSession(identityId) : false

  /** Reads the passkeys again; never rejects (a failure shows "Try again"). */
  const reload = useCallback(async () => {
    if (!identityId) return
    setFailed(false)
    try {
      const [list, check] = await Promise.all([listPasskeys(identityId), passkeyEligibility(identityId)])
      setEntries(list)
      setEligibility(check)
      // A failed session check is a read to retry, not a reason this session can't keep passkeys.
      if (check === 'failed') setFailed(true)
    } catch (error) {
      logger.warn('Passkeys: could not load them:', error)
      setFailed(true)
    }
  }, [identityId])

  useEffect(() => {
    if (offered) reload().catch(() => undefined)
    // `revision` changes whenever a dialog added, updated or removed passkeys.
  }, [offered, reload, revision])

  // A wallet sign-in on a build whose wallet keys cannot write passkeys has nothing to manage here.
  if (!identityId || !offered || (wallet && !walletPasskeysPossible())) return null

  const canAdd = eligibility === null && entries !== null && entries.length < MAX_PASSKEYS
  const saveName = () => {
    if (!renaming) return
    setPasskeyName(renaming.marker, renaming.name)
    setRenaming(null)
    reload().catch(() => undefined)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Passkeys</CardTitle>
        <CardDescription>
          Sign in on any device with Face ID, Touch ID, Windows Hello or your phone.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3" data-testid="passkey-settings">
        {entries === null && !failed && <Spinner size="sm" />}
        {failed && (
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm text-gray-600 dark:text-gray-400">Couldn&apos;t load your passkeys.</p>
            <Button variant="outline" size="sm" onClick={() => { reload().catch(() => undefined) }}>Try again</Button>
          </div>
        )}
        {failed && entries === null && (
          <button
            type="button"
            className="text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 underline underline-offset-4"
            onClick={() => open('review', identityId)}
          >
            Don&apos;t recognise a passkey? Remove all and start over
          </button>
        )}
        {entries?.length === 0 && <p className="text-sm text-gray-600 dark:text-gray-400">You haven&apos;t added a passkey yet.</p>}
        {entries?.map((entry) => (
          <div key={entry.entryId} className="rounded-xl ring-1 ring-gray-200 dark:ring-neutral-700 p-3 text-sm" data-testid="passkey-row">
            {renaming?.marker === entry.marker ? (
              <form className="flex items-center gap-2" onSubmit={(event) => { event.preventDefault(); saveName() }}>
                <input
                  aria-label="Passkey name"
                  autoFocus
                  maxLength={MAX_PASSKEY_NAME_LENGTH}
                  value={renaming.name}
                  onChange={(event) => setRenaming({ marker: entry.marker, name: event.target.value })}
                  className="flex-1 px-3 py-1.5 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-neutral-800 focus:outline-none focus:ring-2 focus:ring-yappr-500"
                />
                <Button type="submit" size="sm">Save</Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setRenaming(null)}>Cancel</Button>
              </form>
            ) : (
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="font-medium text-gray-900 dark:text-white">{passkeyLabel(entry)}</p>
                  {entry.name && <p className="text-gray-500">Added {formatPasskeyDate(entry.addedAt)}</p>}
                  <div className="flex flex-wrap gap-1.5 mt-1">
                    {entry.thisDevice && <span className="px-2 py-0.5 rounded-full text-xs bg-yappr-100 text-yappr-700 dark:bg-yappr-900/30 dark:text-yappr-300">This device</span>}
                    {entry.needsUpdate && <span className="px-2 py-0.5 rounded-full text-xs bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200">Needs update</span>}
                  </div>
                </div>
                <div className="flex gap-1 shrink-0">
                  <Button size="sm" variant="ghost" onClick={() => setRenaming({ marker: entry.marker, name: entry.name ?? '' })}>Rename</Button>
                  <Button size="sm" variant="ghost" onClick={() => setRemoving(entry)}>Remove</Button>
                </div>
              </div>
            )}
          </div>
        ))}
        {eligibility && NOT_ELIGIBLE_COPY[eligibility] && (
          <p className="text-sm text-gray-600 dark:text-gray-400">{NOT_ELIGIBLE_COPY[eligibility]}</p>
        )}
        <div className="flex flex-wrap gap-2 pt-1">
          {canAdd && <Button onClick={() => open('enrol', identityId)} data-testid="passkey-settings-add">Add a passkey</Button>}
          {eligibility === null && entries && entries.length > 0 && (
            <Button variant="outline" onClick={() => open('review', identityId)}>Update passkeys</Button>
          )}
        </div>
        {entries !== null && entries.length >= MAX_PASSKEYS && (
          <p className="text-sm text-gray-500">You can have up to {MAX_PASSKEYS} passkeys. Remove one to add another.</p>
        )}
        <p className="text-xs text-gray-500">
          Passkeys are an extra way in. Keep your Dash wallet or your key too: if you lose every passkey, you&apos;ll need it.
          Names stay on this device.
        </p>
      </CardContent>
      {removing && (
        <RemovePasskeyDialog
          identityId={identityId}
          entry={removing}
          wallet={wallet}
          onClose={() => setRemoving(null)}
          onRemoved={() => {
            setRemoving(null)
            reload().catch(() => undefined)
          }}
        />
      )}
    </Card>
  )
}

function RemovePasskeyDialog({ identityId, entry, wallet, onClose, onRemoved }: {
  identityId: string
  entry: PasskeyEntryView
  wallet: boolean
  onClose: () => void
  onRemoved: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const remove = () => {
    setBusy(true)
    setError(null)
    removePasskeys(identityId, [entry.entryId])
      .then(({ failed }) => {
        if (failed > 0) setError('This passkey couldn\'t be removed. Please try again.')
        else onRemoved()
      })
      .catch(() => setError('This passkey couldn\'t be removed. Please try again.'))
      .finally(() => setBusy(false))
  }

  return (
    <Modal open onOpenChange={(next) => { if (!next && !busy) onClose() }} className="w-[440px] max-w-[92vw]">
      <ModalTitle>Remove this passkey?</ModalTitle>
      <Dialog.Description className="text-gray-600 dark:text-gray-400 mb-3">
        It won&apos;t sign you in to Yappr any more. You can also delete it from your passwords app.
      </Dialog.Description>
      <p className="text-sm text-gray-500 mb-5">{lockOutCopy(wallet)}</p>
      {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400 mb-4">{error}</p>}
      <div className="flex flex-col gap-3">
        <Button variant="destructive" className="w-full gap-2" onClick={remove} disabled={busy} data-testid="passkey-remove-confirm">
          {busy && <Spinner size="sm" />}
          Remove passkey
        </Button>
        <Button variant="outline" className="w-full" onClick={onClose} disabled={busy}>Cancel</Button>
      </div>
    </Modal>
  )
}
