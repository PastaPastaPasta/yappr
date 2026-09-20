'use client'

import { useCallback, useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { ArrowUturnLeftIcon, BanknotesIcon, ClockIcon, NoSymbolIcon } from '@heroicons/react/24/outline'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/contexts/auth-context'
import { logger } from '@/lib/logger'
import { CREDITS_PER_DASH } from '@/lib/services/tip-service'
import {
  moderationService,
  type DocumentRemoval,
  type FeePotState,
  type ModerationEntry,
} from '@/lib/services/moderation-service'

const INPUT = 'w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-neutral-800 text-sm focus:outline-none focus:ring-2 focus:ring-yappr-500'
const SUSPENSION_DAYS = [1, 3, 7, 30] as const

type Action = 'ban' | 'unban' | 'suspend' | 'unsuspend' | 'claim'

/**
 * Contract moderation for the social contract's moderation team (its owner
 * and appointed moderators): ban/unban, suspend/unsuspend with a recorded
 * reason, the two lists, the removal records, and the moderators fee pot
 * with its once-per-epoch claim. Removing a post or reply lives on the post
 * menu, where the moderator sees what they are removing.
 */
export function ContractModerationSettings() {
  const { user } = useAuth()
  const [targetId, setTargetId] = useState('')
  const [reason, setReason] = useState('')
  const [days, setDays] = useState<number>(7)
  const [busy, setBusy] = useState<Action | null>(null)
  const [banned, setBanned] = useState<ModerationEntry[]>([])
  const [suspended, setSuspended] = useState<ModerationEntry[]>([])
  const [removals, setRemovals] = useState<DocumentRemoval[]>([])
  const [pot, setPot] = useState<FeePotState | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [bans, suspensions, removedPosts, removedReplies, pots] = await Promise.all([
        moderationService.listEntries('banlist'),
        moderationService.listEntries('suspensions'),
        moderationService.listRemovals('post'),
        moderationService.listRemovals('reply'),
        moderationService.getFeePots(),
      ])
      setBanned(bans.entries)
      setSuspended(suspensions.entries)
      setRemovals([...removedPosts.removals, ...removedReplies.removals].sort((a, b) => b.removedAt - a.removedAt))
      setPot(pots?.moderators ?? null)
    } catch (error) {
      logger.error('ContractModerationSettings: refresh failed', error)
      toast.error('Could not load the moderation lists')
    }
  }, [])

  useEffect(() => {
    refresh().catch(() => { /* reported inside */ })
  }, [refresh])

  const run = async (action: Action) => {
    if (!user) return
    const id = targetId.trim()
    if (action !== 'claim' && !id) {
      toast.error('Enter the identity ID to moderate')
      return
    }
    setBusy(action)
    const me = user.identityId
    const text = reason.trim()
    const result = action === 'ban' ? await moderationService.ban(me, id, text)
      : action === 'unban' ? await moderationService.unban(me, id)
      : action === 'suspend' ? await moderationService.suspend(me, id, Date.now() + days * 86_400_000, text)
      : action === 'unsuspend' ? await moderationService.unsuspend(me, id)
      : await moderationService.claimModeratorsPot(me)
    setBusy(null)
    if (!result.success) {
      toast.error(result.error || 'Action failed')
      return
    }
    toast.success(
      action === 'ban' ? 'Identity banned'
        : action === 'unban' ? 'Identity unbanned'
        : action === 'suspend' ? `Identity suspended for ${days} day${days === 1 ? '' : 's'}`
        : action === 'unsuspend' ? 'Suspension lifted'
        : 'Moderators pot paid out to the team'
    )
    refresh().catch(() => { /* reported inside */ })
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Contract Moderation</CardTitle>
          <CardDescription>
            A banned identity cannot write anything to the social contract until unbanned; a suspended one until the
            suspension lapses. Both refusals are recorded with your reason, which anyone can read. Only deletes,
            transfers and purchases still go through for them.
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
          <div>
            <label htmlFor="contract-moderation-days" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Suspension length</label>
            <select id="contract-moderation-days" value={days} onChange={(e) => setDays(Number(e.target.value))} className={INPUT}>
              {SUSPENSION_DAYS.map((d) => <option key={d} value={d}>{d} day{d === 1 ? '' : 's'}</option>)}
            </select>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="destructive" disabled={busy !== null} onClick={() => run('ban')} className="gap-2">
              <NoSymbolIcon className="h-4 w-4" /> {busy === 'ban' ? 'Banning…' : 'Ban'}
            </Button>
            <Button variant="outline" disabled={busy !== null} onClick={() => run('unban')} className="gap-2">
              <ArrowUturnLeftIcon className="h-4 w-4" /> {busy === 'unban' ? 'Unbanning…' : 'Unban'}
            </Button>
            <Button variant="outline" disabled={busy !== null} onClick={() => run('suspend')} className="gap-2">
              <ClockIcon className="h-4 w-4" /> {busy === 'suspend' ? 'Suspending…' : 'Suspend'}
            </Button>
            <Button variant="outline" disabled={busy !== null} onClick={() => run('unsuspend')} className="gap-2">
              <ArrowUturnLeftIcon className="h-4 w-4" /> {busy === 'unsuspend' ? 'Lifting…' : 'Unsuspend'}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Moderators Pot</CardTitle>
          <CardDescription>
            Every post and reply pays a small credit fee into this pot. Any moderator may pay it out, once per epoch;
            it is split equally across the whole moderation team.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm">
            <p className="font-semibold">{pot ? `${(Number(pot.credits) / CREDITS_PER_DASH).toFixed(6)} DASH` : '—'}</p>
            <p className="text-gray-500 dark:text-gray-400">
              {pot?.lastClaimEpoch === null || pot?.lastClaimEpoch === undefined
                ? 'Never claimed'
                : `Last claimed in epoch ${pot.lastClaimEpoch}${pot.lastClaimantId ? ` by ${pot.lastClaimantId.slice(0, 8)}…` : ''}`}
            </p>
          </div>
          <Button variant="outline" disabled={busy !== null || !pot || pot.credits === BigInt(0)} onClick={() => run('claim')} className="gap-2">
            <BanknotesIcon className="h-4 w-4" /> {busy === 'claim' ? 'Claiming…' : 'Claim for the team'}
          </Button>
        </CardContent>
      </Card>

      <EntryList title="Banned identities" empty="Nobody is banned." entries={banned}
        render={(entry) => <>{entry.identityId}{entry.reason ? ` — ${entry.reason}` : ''}</>} onPick={setTargetId} />
      <EntryList title="Suspended identities" empty="Nobody is suspended." entries={suspended}
        render={(entry) => <>{entry.identityId} until {entry.until ? new Date(entry.until).toLocaleString() : '?'}{entry.reason ? ` — ${entry.reason}` : ''}</>}
        onPick={setTargetId} />
      <EntryList title="Removed posts and replies" empty="Nothing has been removed." entries={removals}
        render={(removal) => <>{removal.documentId} by {removal.moderatorId.slice(0, 8)}… on {new Date(removal.removedAt).toLocaleDateString()}{removal.reason ? ` — ${removal.reason}` : ''}</>}
        onPick={(removal) => setTargetId(removal.documentOwnerId)} pick={(removal) => removal} />
    </div>
  )
}

interface EntryListProps<T> {
  title: string
  empty: string
  entries: T[]
  render: (entry: T) => React.ReactNode
  /** Fills the identity field from a row, so "unban this one" is one click. */
  onPick: (value: T extends ModerationEntry ? string : T) => void
  pick?: (entry: T) => T
}

function EntryList<T extends ModerationEntry | DocumentRemoval>({ title, empty, entries, render, onPick, pick }: EntryListProps<T>) {
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
              <li key={index}>
                <button type="button" className="text-left hover:underline"
                  onClick={() => onPick((pick ? pick(entry) : (entry as ModerationEntry).identityId) as T extends ModerationEntry ? string : T)}>
                  {render(entry)}
                </button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
