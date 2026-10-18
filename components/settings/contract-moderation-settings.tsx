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
import { ContractReportQueue } from '@/components/moderation/contract-report-queue'
import { ReportQueue } from '@/components/moderation/report-queue'
import { TeamActionsPanel } from '@/components/moderation/team-actions-panel'
import { barredAuthorsCanTombstone, contractTakesReports, deletesAreTombstones } from '@/lib/contract-topology'
import { moderatedContract, type ModeratedContractKey } from '@/lib/moderated-contracts'
import type { ReportTargetKind } from '@/lib/reports'
import { CREDITS_PER_DASH } from '@/lib/services/tip-service'
import { forgetModeratedReads } from '@/lib/moderation-refresh'
import {
  moderationServiceFor,
  postedOnLabel,
  type DocumentRemoval,
  type ModerationEntry,
  type ModerationResult,
  type ModerationStanding,
  type SeatedTeamSeats,
} from '@/lib/services/moderation-service'

const INPUT = 'w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-neutral-800 text-sm focus:outline-none focus:ring-2 focus:ring-yappr-500'
const SUSPENSION_DAYS = [1, 3, 7, 30] as const
const DAY_MS = 86_400_000

type Action = 'ban' | 'unban' | 'suspend' | 'unsuspend' | 'warn' | 'clearWarnings' | 'claim' | 'restore'

type KindedRemoval = DocumentRemoval & { kind: string }
const removalKey = (removal: KindedRemoval) => `${removal.kind}:${removal.documentId}`

const dayLabel = (days: number) => `${days} day${days === 1 ? '' : 's'}`

/** A document type a ban, suspension or warning may cite, and how its field is labelled. */
interface Citable {
  docType: string
  label: string
  placeholder: string
  /** The input's id (social keeps the ids its e2e suite reads). */
  inputId: string
}

/** What each contract's panel says and cites. */
interface PanelCopy {
  /** Who a ban or suspension bars from what. */
  barred: string
  /** What pays into the moderators pot. */
  potFunding: string
  removalsTitle: string
  /** Each kind's name in the removal list. */
  kindLabels: Readonly<Record<string, string>>
  citable: Citable[]
}

const PANEL_COPY: Record<ModeratedContractKey, PanelCopy> = {
  social: {
    barred: 'A banned identity cannot write anything to the social contract until unbanned; a suspended one until the suspension lapses.',
    potFunding: 'Every post and reply pays a small credit fee into this pot.',
    removalsTitle: 'Removed posts and replies',
    kindLabels: { post: 'Post', reply: 'Reply' },
    citable: [
      { docType: 'post', label: 'Posts this is about (optional, public)', placeholder: 'Post IDs, comma-separated', inputId: 'contract-moderation-cited' },
      { docType: 'reply', label: 'Replies this is about (optional, public; at most 16 posts and replies together)', placeholder: 'Reply IDs, comma-separated', inputId: 'contract-moderation-cited-replies' },
    ],
  },
  storefront: {
    barred: 'A banned identity cannot open or edit a store, list or change items, or leave reviews until unbanned; a suspended one until the suspension lapses.',
    potFunding: 'Every new store, listing and review pays a small credit fee into this pot.',
    removalsTitle: 'Removed stores, listings and reviews',
    kindLabels: { store: 'Store', storeItem: 'Listing', storeReview: 'Store review', itemReview: 'Item review' },
    citable: [
      { docType: 'store', label: 'Stores this is about (optional, public)', placeholder: 'Store IDs, comma-separated', inputId: 'storefront-moderation-cited-stores' },
      { docType: 'storeItem', label: 'Listings this is about (optional, public)', placeholder: 'Item IDs, comma-separated', inputId: 'storefront-moderation-cited-items' },
      { docType: 'storeReview', label: 'Store reviews this is about (optional, public)', placeholder: 'Review IDs, comma-separated', inputId: 'storefront-moderation-cited-store-reviews' },
      { docType: 'itemReview', label: 'Item reviews this is about (optional, public; at most 16 documents together)', placeholder: 'Review IDs, comma-separated', inputId: 'storefront-moderation-cited-item-reviews' },
    ],
  },
  blog: {
    barred: 'A banned identity cannot create or edit a blog, publish, or comment until unbanned; a suspended one until the suspension lapses.',
    potFunding: 'Every new blog, blog post and comment pays a small credit fee into this pot.',
    removalsTitle: 'Removed blogs, posts and comments',
    kindLabels: { blog: 'Blog', blogPost: 'Blog post', blogComment: 'Comment' },
    citable: [
      { docType: 'blog', label: 'Blogs this is about (optional, public)', placeholder: 'Blog IDs, comma-separated', inputId: 'blog-moderation-cited-blogs' },
      { docType: 'blogPost', label: 'Blog posts this is about (optional, public)', placeholder: 'Post IDs, comma-separated', inputId: 'blog-moderation-cited-posts' },
      { docType: 'blogComment', label: 'Comments this is about (optional, public; at most 16 documents together)', placeholder: 'Comment IDs, comma-separated', inputId: 'blog-moderation-cited-comments' },
    ],
  },
}

/** The removal records a contract's panel lists: social's posts and replies, every recorded type elsewhere. */
function removalKinds(contract: ModeratedContractKey): string[] {
  if (contract === 'social') return ['post', 'reply']
  const declared = moderatedContract(contract)
  return declared.deletableTypes().filter((type) => declared.keepsRecord(type))
}

/** A document a moderator came to the panel to act on: its author goes in the identity field and it is cited. */
export interface ModerationCitation {
  authorId: string
  docType: string
  documentId: string
}

/**
 * What the ban panel adds about a barred author's own posts and replies: on
 * v9/v11 a delete there is a tombstone, an edit the bar refuses; v12 lets that
 * tombstone through (`retractedWhen`), so it goes as any delete does.
 */
function barredOwnDeleteNote(): string {
  if (!deletesAreTombstones()) return '.'
  if (barredAuthorsCanTombstone()) return ', and taking down their own posts and replies (blanking them is the one edit still allowed).'
  return ': a post or reply is deleted by blanking it, which is an edit, so they cannot take those down.'
}

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
 *
 * The same panel serves the storefront and blog contracts (`contract`), each
 * with its own team, lists, removals and pot: their content is removed from
 * the moderator menu beside a store, listing, review, blog, post or comment,
 * whose "Moderate the author" lands here with `citation` filled in.
 */
export function ContractModerationSettings({ contract = 'social', citation }: { contract?: ModeratedContractKey; citation?: ModerationCitation }) {
  const { user } = useAuth()
  const service = moderationServiceFor(contract)
  const copy = PANEL_COPY[contract]
  const social = contract === 'social'
  /** A removal kind as the list names it ("Post", "Listing", "Comment"). */
  const kindLabel = (kind: string) => copy.kindLabels[kind] ?? kind
  /** Element ids, unique per contract's panel. */
  const fieldId = (name: string) => (social ? `contract-moderation-${name}` : `${contract}-moderation-${name}`)
  const [targetId, setTargetId] = useState(citation?.authorId ?? '')
  const [reason, setReason] = useState('')
  /** Ids of the documents the ban, suspension or warning is about, per type (`reason.documents`, at most 16 together). */
  const [cited, setCited] = useState<Readonly<Record<string, string>>>(citation ? { [citation.docType]: citation.documentId } : {})
  const [days, setDays] = useState<number>(7)
  /** The action in flight, and for a per-row action the row it is on. */
  const [busy, setBusy] = useState<{ action: Action; id?: string } | null>(null)
  const [banned, setBanned] = useState<ModerationEntry[]>([])
  const [suspended, setSuspended] = useState<ModerationEntry[]>([])
  const [warned, setWarned] = useState<ModerationEntry[]>([])
  const [removals, setRemovals] = useState<KindedRemoval[]>([])
  /** Removal ids this device can undo, worked out once per refresh rather than on every render. */
  const [restorable, setRestorable] = useState<ReadonlySet<string>>(new Set())
  const canWarn = service.canWarn()
  /** Seated elected team: every ban, suspension and warning must cite one of its charter's reasons. */
  // The panel renders only for the moderation team; it reads on mount.
  const seatedReasons = useSeatedReasons(true, contract)
  const [reasonDocumentId, setReasonDocumentId] = useState('')
  const [potStatus, setPotStatus] = useState(() => service.moderatorsPotStatus())
  const { pot, pending: claimPending } = potStatus
  /** v11: counted actions per seated member since the last payout (what the action share splits by); null when not kept or unread. */
  const [actionCounts, setActionCounts] = useState<ReadonlyMap<string, number> | null>(null)
  /** v11: the seated team and its seats, for the pot panel; null while none is seated. */
  const [seatedTeam, setSeatedTeam] = useState<SeatedTeamSeats | null>(null)
  /** The last status check: the proved standing, or the read failure (never a clean record in its place). */
  const [standing, setStanding] = useState<{ identityId: string; standing: ModerationStanding | null; error: string | null } | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [bans, suspensions, warnings, removedByKind] = await Promise.all([
        service.listEntries('banlist'),
        service.listEntries('suspensions'),
        service.listEntries('warnings'),
        Promise.all(removalKinds(contract).map(async (kind) =>
          (await service.listRemovals(kind)).removals.map((removal): KindedRemoval => ({ ...removal, kind })))),
        service.getFeePots(),
      ])
      setBanned(bans.entries)
      setSuspended(suspensions.entries)
      setWarned(warnings.entries)
      const all = removedByKind.flat().sort((a, b) => b.removedAt - a.removedAt)
      setRemovals(all)
      setRestorable(new Set(all.filter((removal) => service.canRestore(removal.kind, removal)).map(removalKey)))
      await service.reconcileModeratorsPot()
      setPotStatus(service.moderatorsPotStatus())
    } catch (error) {
      logger.error('ContractModerationSettings: refresh failed', error)
      toast.error('Could not load the moderation lists')
    }
    // The team's seats and per-member counts (v11) are extras of the pot
    // panel: a failure leaves them out, never the lists above.
    if (!service.contract.countsActions()) return
    const [counts, seated] = await Promise.all([
      service.getActionCounts(),
      service.getSeatedTeam().catch((error: unknown) => {
        logger.warn('ContractModerationSettings: seated team read failed', error)
        return null
      }),
    ])
    setActionCounts(counts)
    setSeatedTeam(seated)
  }, [contract, service])

  useEffect(() => {
    refresh().catch(() => { /* reported inside */ })
  }, [refresh])

  const restore = async (removal: KindedRemoval) => {
    if (!user || busy) return
    setBusy({ action: 'restore', id: removalKey(removal) })
    const result = await service.restoreDocument(user.identityId, removal.kind, removal.documentId)
    setBusy(null)
    const what = kindLabel(removal.kind)
    if (result.errorCode === 'MAYBE_APPLIED') {
      toast(`This ${what.toLowerCase()} may have been restored — the network did not confirm in time. Check again before retrying.`, { duration: 8000 })
      refresh().catch(() => { /* reported inside */ })
      return
    }
    if (!result.success) {
      toast.error(result.error || 'Restore failed')
      return
    }
    toast.success(`${what} restored`)
    // A restored document shows and counts again: drop the cached reads that left it out.
    forgetModeratedReads(contract)
    refresh().catch(() => { /* reported inside */ })
  }

  const run = async (action: Exclude<Action, 'restore'>) => {
    if (!user || busy || (action === 'claim' && service.moderatorsPotStatus().pending)) return
    const id = targetId.trim()
    if (action !== 'claim' && !id) {
      toast.error('Enter the identity ID to moderate')
      return
    }
    setBusy({ action })
    const me = user.identityId
    const bound = action === 'ban' || action === 'suspend' || action === 'warn'
    if (bound && (seatedReasons.loading || seatedReasons.failed)) {
      setBusy(null)
      toast.error(seatedReasons.failed ? 'Could not read the elected team\'s charter; reload and try again' : 'Still reading the elected team\'s charter')
      return
    }
    if (bound && seatedReasons.required && !reasonDocumentId) {
      setBusy(null)
      toast.error('Choose the charter reason this action is taken on')
      return
    }
    const why = {
      text: reason.trim(),
      documents: copy.citable.flatMap(({ docType }) =>
        (cited[docType] ?? '').split(/[\s,]+/).filter(Boolean).map((documentId) => ({ documentTypeName: docType, documentId }))),
      ...(seatedReasons.required && reasonDocumentId ? { reasonDocumentId } : {}),
    }
    let result: ModerationResult
    let succeeded: string
    switch (action) {
      case 'ban':
        result = await service.ban(me, id, why)
        succeeded = 'Identity banned'
        break
      case 'unban':
        result = await service.unban(me, id)
        succeeded = 'Identity unbanned'
        break
      case 'suspend':
        result = await service.suspend(me, id, Date.now() + days * DAY_MS, why)
        succeeded = `Identity suspended for ${dayLabel(days)}`
        break
      case 'unsuspend':
        result = await service.unsuspend(me, id)
        succeeded = 'Suspension lifted'
        break
      case 'warn':
        result = await service.warn(me, id, why)
        succeeded = 'Warning recorded'
        break
      case 'clearWarnings':
        result = await service.clearWarnings(me, id)
        succeeded = 'Warnings cleared'
        break
      case 'claim': {
        const claimed = await service.claimModeratorsPot(me)
        result = claimed
        if (claimed.success) {
          setPotStatus(service.moderatorsPotStatus())
        }
        succeeded = 'Moderators pot paid out to the team'
        break
      }
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
    // The cited reason belonged to that action; the next one picks its own.
    setReasonDocumentId('')
    refresh().catch(() => { /* reported inside */ })
    if (id) lookUp(id).catch(() => { /* reported inside */ })
  }

  /** From a report: the author goes in the identity field and the reported post or reply is cited. */
  const moderateAuthor = (authorId: string, kind: ReportTargetKind, documentId: string) => {
    setTargetId(authorId)
    setCited({ [kind]: documentId })
    const field = document.getElementById(fieldId('target'))
    field?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    field?.focus({ preventScroll: true })
    lookUp(authorId).catch(() => { /* reported inside */ })
  }

  /** The entered identity's standing on every list the contract keeps, warnings included. */
  const lookUp = useCallback(async (identityId: string) => {
    const id = identityId.trim()
    if (!id) return
    try {
      setStanding({ identityId: id, standing: await service.readStanding(id), error: null })
    } catch (error) {
      logger.warn('ContractModerationSettings: status check failed', error)
      setStanding({ identityId: id, standing: null, error: 'Could not read this identity\'s moderation status.' })
    }
  }, [service])

  // Arrived from a document's moderator menu: show where its author stands.
  const citedAuthor = citation?.authorId
  useEffect(() => {
    if (citedAuthor) lookUp(citedAuthor).catch(() => { /* reported inside */ })
  }, [citedAuthor, lookUp])

  return (
    <div className="space-y-4">
      <ElectionStatusPanel contract={contract} />
      {social && contractTakesReports() && <ReportQueue seatedReasons={seatedReasons} onModerateAuthor={moderateAuthor} />}
      {contract !== 'social' && moderatedContract(contract).reportsResolved() && <ContractReportQueue contract={contract} seatedReasons={seatedReasons} />}
      <TeamActionsPanel contract={contract} seatedReasons={seatedReasons} onChanged={() => { refresh().catch(() => { /* reported inside */ }) }} />
      <Card>
        <CardHeader>
          <CardTitle>{social ? 'Contract Moderation' : `${moderatedContract(contract).label} Moderation`}</CardTitle>
          <CardDescription>
            {copy.barred} Both refusals are recorded with your reason, which anyone can read.
            {social && <> Only deleting their own documents (an unlike, an unfollow) still goes through for them{barredOwnDeleteNote()}</>}
            {canWarn && ' A warning bars nothing: it is a public, reasoned note, and at most 16 accumulate until cleared.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <label htmlFor={fieldId('target')} className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Identity ID</label>
            <input id={fieldId('target')} type="text" value={targetId} onChange={(e) => setTargetId(e.target.value)}
              placeholder="Base58 identity ID to moderate" className={`${INPUT} font-mono`} />
          </div>
          <div>
            <label htmlFor={fieldId('reason')} className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Reason (public, recorded on-chain)</label>
            <input id={fieldId('reason')} type="text" value={reason} maxLength={1024} onChange={(e) => setReason(e.target.value)}
              placeholder="Why" className={INPUT} />
          </div>
          {(seatedReasons.required || seatedReasons.failed) && (
            <CharterReasonPicker id={fieldId('charter-reason')} state={seatedReasons} value={reasonDocumentId} onChange={setReasonDocumentId} />
          )}
          {copy.citable.map(({ docType, label, placeholder, inputId }) => (
            <div key={docType}>
              <label htmlFor={inputId} className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{label}</label>
              <input id={inputId} type="text" value={cited[docType] ?? ''} onChange={(e) => setCited((previous) => ({ ...previous, [docType]: e.target.value }))}
                placeholder={placeholder} className={`${INPUT} font-mono`} />
            </div>
          ))}
          <div>
            <label htmlFor={fieldId('days')} className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Suspension length</label>
            <select id={fieldId('days')} value={days} onChange={(e) => setDays(Number(e.target.value))} className={INPUT}>
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
            {copy.potFunding} Any moderator may pay it out, once per epoch;
            {seatedReasons.required
              ? ' it is split by the seated charter\'s reward split (leader, equal and per-action shares).'
              : ' it is split equally across the whole moderation team.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm">
            <p className="font-semibold">{pot ? `${(Number(pot.credits) / CREDITS_PER_DASH).toFixed(6)} DASH` : '—'}</p>
            <p className="text-gray-500 dark:text-gray-400">
              {claimPending ? 'Updating payout status…' : pot?.lastClaimEpoch == null
                ? 'Never claimed'
                : `Last claimed in epoch ${pot.lastClaimEpoch}${pot.lastClaimantId ? ` by ${pot.lastClaimantId.slice(0, 8)}…` : ''}`}
            </p>
          </div>
          <Button variant="outline" disabled={busy !== null || claimPending || !pot || pot.credits === BigInt(0)} onClick={() => run('claim')} className="gap-2">
            <BanknotesIcon className="h-4 w-4" /> {busy?.action === 'claim' ? 'Claiming…' : 'Claim for the team'}
          </Button>
          {claimPending && <Button variant="outline" size="sm" onClick={() => refresh()} disabled={busy !== null}>Refresh payout</Button>}
          {seatedTeam && <TeamCounts team={seatedTeam} counts={actionCounts} />}
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
      <EntryList title={copy.removalsTitle} empty="Nothing has been removed." entries={removals}
        render={(removal) => (
          <>
            {!social && `${kindLabel(removal.kind)} `}
            {removal.documentId} by {removal.moderatorId.slice(0, 8)}… on {new Date(removal.removedAt).toLocaleDateString()}
            {removal.kept.tags ? ` · ${removal.kept.tags.map((tag) => `#${tag}`).join(' ')}` : ''}
            {removal.kept.createdAt !== undefined ? ` · posted ${postedOnLabel(removal.kept.createdAt)}` : ''}
            {removal.reason ? ` — ${removal.reason}` : ''}{removal.restoredAt !== null ? ' (restored)' : ''}
          </>
        )}
        onPick={(removal) => setTargetId(removal.documentOwnerId)}
        action={(removal) => restorable.has(removalKey(removal)) && (
          <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => restore(removal)} className="shrink-0">
            {busy?.action === 'restore' && busy.id === removalKey(removal) ? 'Restoring…' : 'Restore'}
          </Button>
        )} />
    </div>
  )
}

/**
 * The seated team beside its pot (v11): its seats, and the counted actions
 * (bans, suspensions, warnings, deletions) each member signed since the pot
 * was last paid out, which the action share of a claim splits by. Counts are
 * left out when the node keeps or serves none.
 */
function TeamCounts({ team, counts }: { team: SeatedTeamSeats; counts: ReadonlyMap<string, number> | null }) {
  const members = [team.leaderId, ...team.members]
  return (
    <div data-testid="moderators-pot-counts" className="w-full text-sm border-t border-gray-200 dark:border-gray-800 pt-3">
      <p className="text-gray-500 dark:text-gray-400">
        The seated team is {members.length} {members.length === 1 ? 'person' : 'people'}
        {team.electedMembers.length > 0 ? ` (${team.electedMembers.length} elected)` : ''}
        {team.seats !== null ? `, with ${team.seats} seat${team.seats === 1 ? '' : 's'}` : ''}.
        {counts && ' Actions each member signed since the last payout:'}
      </p>
      {counts && (
        <ul className="mt-1 font-mono text-xs space-y-0.5">
          {members.map((id) => (
            <li key={id} className="flex justify-between gap-2">
              <span className="break-all">{id}{id === team.leaderId ? ' (leader)' : ''}</span>
              <span>{counts.get(id) ?? 0}</span>
            </li>
          ))}
        </ul>
      )}
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
