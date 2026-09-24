'use client'

import { useCallback, useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { ArrowUturnLeftIcon, BanknotesIcon, ClockIcon, ExclamationTriangleIcon, NoSymbolIcon } from '@heroicons/react/24/outline'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/contexts/auth-context'
import { logger } from '@/lib/logger'
import { CharterReasonPicker, useSeatedReasons } from '@/components/moderation/charter-reason-picker'
import { ElectionStatusPanel } from '@/components/moderation/election-status-panel'
import { CREDITS_PER_DASH } from '@/lib/services/tip-service'
import {
  moderationService,
  type DocumentRemoval,
  type FeePotState,
  type ModerationEntry,
  type ModerationResult,
  type ModerationStanding,
} from '@/lib/services/moderation-service'

const INPUT = 'w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-neutral-800 text-sm focus:outline-none focus:ring-2 focus:ring-yappr-500'
const SUSPENSION_DAYS = [1, 3, 7, 30] as const
const DAY_MS = 86_400_000

type Action = 'ban' | 'unban' | 'suspend' | 'unsuspend' | 'warn' | 'clearWarnings' | 'claim' | 'restore'

type KindedRemoval = DocumentRemoval & { kind: 'post' | 'reply' }
const removalKey = (removal: KindedRemoval) => `${removal.kind}:${removal.documentId}`

const dayLabel = (days: number) => `${days} day${days === 1 ? '' : 's'}`

/**
 * Contract moderation for the social contract's moderation team (its owner
 * and appointed moderators, or on an elected contract the interim until a team
 * is seated and the seated team after; `useIsModerator` follows that switch,
 * so an owner whose contract seats a team loses this panel, and with it the
 * interim's pot claim that would be refused 41113): ban/unban, suspend/unsuspend with a recorded
 * reason, the lists, the removal records, and the moderators fee pot with
 * its once-per-epoch claim. Where the contract keeps a warning list, warn and
 * clear warnings too; a removal this device snapshotted can be restored within
 * its week. Removing a post or reply lives on the post menu, where the
 * moderator sees what they are removing.
 */
export function ContractModerationSettings() {
  const { user } = useAuth()
  const [targetId, setTargetId] = useState('')
  const [reason, setReason] = useState('')
  /** Post and reply ids the ban, suspension or warning is about (`reason.documents`, at most 16 together). */
  const [citedPosts, setCitedPosts] = useState('')
  const [citedReplies, setCitedReplies] = useState('')
  const [days, setDays] = useState<number>(7)
  /** The action in flight, and for a per-row action the row it is on. */
  const [busy, setBusy] = useState<{ action: Action; id?: string } | null>(null)
  const [banned, setBanned] = useState<ModerationEntry[]>([])
  const [suspended, setSuspended] = useState<ModerationEntry[]>([])
  const [warned, setWarned] = useState<ModerationEntry[]>([])
  const [removals, setRemovals] = useState<KindedRemoval[]>([])
  /** Removal ids this device can undo, worked out once per refresh rather than on every render. */
  const [restorable, setRestorable] = useState<ReadonlySet<string>>(new Set())
  const canWarn = moderationService.canWarn()
  /** Seated elected team: every ban, suspension and warning must cite one of its charter's reasons. */
  const seatedReasons = useSeatedReasons()
  const [reasonDocumentId, setReasonDocumentId] = useState('')
  const [pot, setPot] = useState<FeePotState | null>(null)
  /** The last status check: the proved standing, or the read failure (never a clean record in its place). */
  const [standing, setStanding] = useState<{ identityId: string; standing: ModerationStanding | null; error: string | null } | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [bans, suspensions, warnings, removedPosts, removedReplies, pots] = await Promise.all([
        moderationService.listEntries('banlist'),
        moderationService.listEntries('suspensions'),
        moderationService.listEntries('warnings'),
        moderationService.listRemovals('post'),
        moderationService.listRemovals('reply'),
        moderationService.getFeePots(),
      ])
      setBanned(bans.entries)
      setSuspended(suspensions.entries)
      setWarned(warnings.entries)
      const all: KindedRemoval[] = [
        ...removedPosts.removals.map((removal) => ({ ...removal, kind: 'post' as const })),
        ...removedReplies.removals.map((removal) => ({ ...removal, kind: 'reply' as const })),
      ].sort((a, b) => b.removedAt - a.removedAt)
      setRemovals(all)
      setRestorable(new Set(all.filter((removal) => moderationService.canRestore(removal.kind, removal)).map(removalKey)))
      setPot(pots?.moderators ?? null)
    } catch (error) {
      logger.error('ContractModerationSettings: refresh failed', error)
      toast.error('Could not load the moderation lists')
    }
  }, [])

  useEffect(() => {
    refresh().catch(() => { /* reported inside */ })
  }, [refresh])

  const restore = async (removal: KindedRemoval) => {
    if (!user || busy) return
    setBusy({ action: 'restore', id: removalKey(removal) })
    const result = await moderationService.restoreDocument(user.identityId, removal.kind, removal.documentId)
    setBusy(null)
    if (result.errorCode === 'MAYBE_APPLIED') {
      toast(`This ${removal.kind} may have been restored — the network did not confirm in time. Check again before retrying.`, { duration: 8000 })
      refresh().catch(() => { /* reported inside */ })
      return
    }
    if (!result.success) {
      toast.error(result.error || 'Restore failed')
      return
    }
    toast.success(`${removal.kind === 'reply' ? 'Reply' : 'Post'} restored`)
    refresh().catch(() => { /* reported inside */ })
  }

  const run = async (action: Exclude<Action, 'restore'>) => {
    if (!user) return
    const id = targetId.trim()
    if (action !== 'claim' && !id) {
      toast.error('Enter the identity ID to moderate')
      return
    }
    setBusy({ action })
    const me = user.identityId
    const cite = (ids: string, documentTypeName: 'post' | 'reply') =>
      ids.split(/[\s,]+/).filter(Boolean).map((documentId) => ({ documentTypeName, documentId }))
    const bound = action === 'ban' || action === 'suspend' || action === 'warn'
    if (bound && seatedReasons.required && !reasonDocumentId) {
      setBusy(null)
      toast.error('Choose the charter reason this action is taken on')
      return
    }
    const why = {
      text: reason.trim(),
      documents: [...cite(citedPosts, 'post'), ...cite(citedReplies, 'reply')],
      ...(seatedReasons.required && reasonDocumentId ? { reasonDocumentId } : {}),
    }
    let result: ModerationResult
    let succeeded: string
    switch (action) {
      case 'ban':
        result = await moderationService.ban(me, id, why)
        succeeded = 'Identity banned'
        break
      case 'unban':
        result = await moderationService.unban(me, id)
        succeeded = 'Identity unbanned'
        break
      case 'suspend':
        result = await moderationService.suspend(me, id, Date.now() + days * DAY_MS, why)
        succeeded = `Identity suspended for ${dayLabel(days)}`
        break
      case 'unsuspend':
        result = await moderationService.unsuspend(me, id)
        succeeded = 'Suspension lifted'
        break
      case 'warn':
        result = await moderationService.warn(me, id, why)
        succeeded = 'Warning recorded'
        break
      case 'clearWarnings':
        result = await moderationService.clearWarnings(me, id)
        succeeded = 'Warnings cleared'
        break
      case 'claim':
        result = await moderationService.claimModeratorsPot(me)
        succeeded = 'Moderators pot paid out to the team'
        break
    }
    setBusy(null)
    if (result.errorCode === 'MAYBE_APPLIED') {
      toast(result.error ?? 'This may have been applied. Check again before retrying.', { duration: 8000 })
      refresh().catch(() => { /* reported inside */ })
      if (id) lookUp(id).catch(() => { /* reported inside */ })
      return
    }
    if (!result.success) {
      toast.error(result.error || 'Action failed')
      return
    }
    toast.success(succeeded)
    refresh().catch(() => { /* reported inside */ })
    if (id) lookUp(id).catch(() => { /* reported inside */ })
  }

  /** The entered identity's standing on every list the contract keeps, warnings included. */
  const lookUp = async (identityId: string) => {
    const id = identityId.trim()
    if (!id) return
    try {
      setStanding({ identityId: id, standing: await moderationService.readStanding(id), error: null })
    } catch (error) {
      logger.warn('ContractModerationSettings: status check failed', error)
      setStanding({ identityId: id, standing: null, error: 'Could not read this identity\'s moderation status.' })
    }
  }

  return (
    <div className="space-y-4">
      <ElectionStatusPanel />
      <Card>
        <CardHeader>
          <CardTitle>Contract Moderation</CardTitle>
          <CardDescription>
            A banned identity cannot write anything to the social contract until unbanned; a suspended one until the
            suspension lapses. Both refusals are recorded with your reason, which anyone can read. Only deletes,
            transfers and purchases still go through for them.
            {canWarn && ' A warning bars nothing: it is a public, reasoned note, and at most 16 accumulate until cleared.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <label htmlFor="contract-moderation-target" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Identity ID</label>
            <input id="contract-moderation-target" type="text" value={targetId} onChange={(e) => setTargetId(e.target.value)}
              placeholder="Base58 identity ID to moderate" className={`${INPUT} font-mono`} />
          </div>
          <div>
            <label htmlFor="contract-moderation-reason" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Reason (public, recorded on-chain)</label>
            <input id="contract-moderation-reason" type="text" value={reason} maxLength={1024} onChange={(e) => setReason(e.target.value)}
              placeholder="Why" className={INPUT} />
          </div>
          {seatedReasons.required && (
            <CharterReasonPicker id="contract-moderation-charter-reason" reasons={seatedReasons.reasons} value={reasonDocumentId} onChange={setReasonDocumentId} />
          )}
          <div>
            <label htmlFor="contract-moderation-cited" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Posts this is about (optional, public)</label>
            <input id="contract-moderation-cited" type="text" value={citedPosts} onChange={(e) => setCitedPosts(e.target.value)}
              placeholder="Post IDs, comma-separated" className={`${INPUT} font-mono`} />
          </div>
          <div>
            <label htmlFor="contract-moderation-cited-replies" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Replies this is about (optional, public; at most 16 posts and replies together)</label>
            <input id="contract-moderation-cited-replies" type="text" value={citedReplies} onChange={(e) => setCitedReplies(e.target.value)}
              placeholder="Reply IDs, comma-separated" className={`${INPUT} font-mono`} />
          </div>
          <div>
            <label htmlFor="contract-moderation-days" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Suspension length</label>
            <select id="contract-moderation-days" value={days} onChange={(e) => setDays(Number(e.target.value))} className={INPUT}>
              {SUSPENSION_DAYS.map((d) => <option key={d} value={d}>{dayLabel(d)}</option>)}
            </select>
          </div>
          {standing && standing.identityId === targetId.trim() && (standing.standing
            ? <StandingSummary standing={standing.standing} />
            : (
              <div role="alert" className="flex items-center justify-between gap-2 text-sm rounded-lg border border-red-300 dark:border-red-800 p-3 text-red-600 dark:text-red-400">
                <span>{standing.error}</span>
                <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => { lookUp(standing.identityId).catch(() => { /* reported inside */ }) }}>
                  Retry
                </Button>
              </div>
            ))}
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={busy !== null || !targetId.trim()} onClick={() => { lookUp(targetId).catch(() => { /* reported inside */ }) }}>
              Check status
            </Button>
            <Button variant="destructive" disabled={busy !== null} onClick={() => run('ban')} className="gap-2">
              <NoSymbolIcon className="h-4 w-4" /> {busy?.action === 'ban' ? 'Banning…' : 'Ban'}
            </Button>
            <Button variant="outline" disabled={busy !== null} onClick={() => run('unban')} className="gap-2">
              <ArrowUturnLeftIcon className="h-4 w-4" /> {busy?.action === 'unban' ? 'Unbanning…' : 'Unban'}
            </Button>
            <Button variant="outline" disabled={busy !== null} onClick={() => run('suspend')} className="gap-2">
              <ClockIcon className="h-4 w-4" /> {busy?.action === 'suspend' ? 'Suspending…' : 'Suspend'}
            </Button>
            <Button variant="outline" disabled={busy !== null} onClick={() => run('unsuspend')} className="gap-2">
              <ArrowUturnLeftIcon className="h-4 w-4" /> {busy?.action === 'unsuspend' ? 'Lifting…' : 'Unsuspend'}
            </Button>
            {canWarn && (
              <>
                <Button variant="outline" disabled={busy !== null} onClick={() => run('warn')} className="gap-2">
                  <ExclamationTriangleIcon className="h-4 w-4" /> {busy?.action === 'warn' ? 'Warning…' : 'Warn'}
                </Button>
                <Button variant="outline" disabled={busy !== null} onClick={() => run('clearWarnings')} className="gap-2">
                  <ArrowUturnLeftIcon className="h-4 w-4" /> {busy?.action === 'clearWarnings' ? 'Clearing…' : 'Clear warnings'}
                </Button>
              </>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Moderators Pot</CardTitle>
          <CardDescription>
            Every post and reply pays a small credit fee into this pot. Any moderator may pay it out, once per epoch;
            {seatedReasons.required
              ? ' it is split by the seated charter\'s reward split (leader, equal and per-action shares).'
              : ' it is split equally across the whole moderation team.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm">
            <p className="font-semibold">{pot ? `${(Number(pot.credits) / CREDITS_PER_DASH).toFixed(6)} DASH` : '—'}</p>
            <p className="text-gray-500 dark:text-gray-400">
              {pot?.lastClaimEpoch == null
                ? 'Never claimed'
                : `Last claimed in epoch ${pot.lastClaimEpoch}${pot.lastClaimantId ? ` by ${pot.lastClaimantId.slice(0, 8)}…` : ''}`}
            </p>
          </div>
          <Button variant="outline" disabled={busy !== null || !pot || pot.credits === BigInt(0)} onClick={() => run('claim')} className="gap-2">
            <BanknotesIcon className="h-4 w-4" /> {busy?.action === 'claim' ? 'Claiming…' : 'Claim for the team'}
          </Button>
        </CardContent>
      </Card>

      <EntryList title="Banned identities" empty="Nobody is banned." entries={banned}
        render={(entry) => <>{entry.identityId}{entry.reason ? ` — ${entry.reason}` : ''}</>}
        onPick={(entry) => setTargetId(entry.identityId)} />
      <EntryList title="Suspended identities" empty="Nobody is suspended." entries={suspended}
        render={(entry) => <>{entry.identityId} until {entry.until ? new Date(entry.until).toLocaleString() : '?'}{entry.reason ? ` — ${entry.reason}` : ''}</>}
        onPick={(entry) => setTargetId(entry.identityId)} />
      {canWarn && (
        <EntryList title="Warned identities" empty="Nobody carries a warning." entries={warned}
          render={(entry) => <>{entry.identityId} — {entry.warnings?.length ?? 1} warning{(entry.warnings?.length ?? 1) === 1 ? '' : 's'}{entry.reason ? `, latest: ${entry.reason}` : ''}</>}
          onPick={(entry) => setTargetId(entry.identityId)} />
      )}
      <EntryList title="Removed posts and replies" empty="Nothing has been removed." entries={removals}
        render={(removal) => <>{removal.documentId} by {removal.moderatorId.slice(0, 8)}… on {new Date(removal.removedAt).toLocaleDateString()}{removal.reason ? ` — ${removal.reason}` : ''}{removal.restoredAt !== null ? ' (restored)' : ''}</>}
        onPick={(removal) => setTargetId(removal.documentOwnerId)}
        action={(removal) => restorable.has(removalKey(removal)) && (
          <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => restore(removal)} className="shrink-0">
            {busy?.action === 'restore' && busy.id === removalKey(removal) ? 'Restoring…' : 'Restore'}
          </Button>
        )} />
    </div>
  )
}

/** What the chain says about one identity: banned, suspended until, and each warning with its reason. */
function StandingSummary({ standing }: { standing: ModerationStanding }) {
  const clean = !standing.banned && standing.suspendedUntil === null && standing.warnings.length === 0
  return (
    <div className="text-sm rounded-lg border border-gray-200 dark:border-gray-700 p-3 space-y-1">
      {clean && <p className="text-gray-500 dark:text-gray-400">In good standing.</p>}
      {standing.banned && <p>Banned{standing.banReason ? `: ${standing.banReason}` : ''}</p>}
      {standing.suspendedUntil !== null && (
        <p>Suspended until {new Date(standing.suspendedUntil).toLocaleString()}{standing.suspensionReason ? `: ${standing.suspensionReason}` : ''}</p>
      )}
      {standing.warnings.length > 0 && (
        <div>
          <p>{standing.warnings.length} warning{standing.warnings.length === 1 ? '' : 's'}:</p>
          <ul className="list-disc pl-5">
            {standing.warnings.map((warning, index) => (
              <li key={index}>
                {new Date(warning.warnedAt).toLocaleDateString()}{warning.reason ? ` — ${warning.reason}` : ''}
                {warning.documents.length > 0 && ` (${warning.documents.length} document${warning.documents.length === 1 ? '' : 's'} cited)`}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

interface EntryListProps<T> {
  title: string
  empty: string
  entries: T[]
  render: (entry: T) => React.ReactNode
  /** Fills the identity field from a row, so "unban this one" is one click. */
  onPick: (entry: T) => void
  /** An optional per-row control beside the entry (restore a removal). */
  action?: (entry: T) => React.ReactNode
}

function EntryList<T>({ title, empty, entries, render, onPick, action }: EntryListProps<T>) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {entries.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">{empty}</p>
        ) : (
          <ul className="space-y-1 text-sm font-mono break-all">
            {entries.map((entry, index) => (
              <li key={index} className="flex items-start justify-between gap-2">
                <button type="button" className="text-left hover:underline" onClick={() => onPick(entry)}>
                  {render(entry)}
                </button>
                {action?.(entry)}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
