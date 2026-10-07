'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import toast from 'react-hot-toast'
import { CheckCircleIcon, ExclamationTriangleIcon, FlagIcon, LockOpenIcon, ShieldExclamationIcon, TrashIcon, UserIcon } from '@heroicons/react/24/outline'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/contexts/auth-context'
import { useModeratorRemoveModal } from '@/hooks/use-moderator-remove-modal'
import { logger } from '@/lib/logger'
import {
  OPEN_REPORTS,
  REPORT_RESOLUTION_MAX_LENGTH,
  REPORT_STATUSES,
  groupReports,
  isReportGoneError,
  reportMatchesView,
  reportReasonLabel,
  reportStatusLabel,
  reportsNeedingResolution,
  resolutionFormStart,
  resolutionInputProblem,
  withdrawFailureMessage,
  type ReportRecord,
  type ReportStatus,
  type ReportTargetKind,
  type ReportView,
  type ReportedTarget,
} from '@/lib/reports'
import type { TargetKind } from '@/lib/contract-topology'
import { openReportedContent } from '@/lib/services/report-box-service'
import type { Post } from '@/lib/types'
import { dpnsService } from '@/lib/services/dpns-service'
import { moderationService, type ModerationResult } from '@/lib/services/moderation-service'
import { postService, replyToPost } from '@/lib/services/post-service'
import { replyService } from '@/lib/services/reply-service'
import { reportService, type ReportCursor } from '@/lib/services/report-service'
import { CharterReasonPicker, type SeatedReasonsState } from './charter-reason-picker'

/**
 * What a report's target is now: live (with the post to show), deleted by its
 * author (a v9 tombstone), removed by a moderator (a removal record says so),
 * or unknown (it could not be read, and no removal record explains why; on
 * v10, where an author's delete leaves nothing behind, that includes a target
 * its author deleted).
 */
type TargetState = { state: 'live'; post: Post } | { state: 'tombstoned'; post: Post } | { state: 'removed' } | { state: 'unknown' } | { state: 'profile' }

const keyOf = (target: { kind: ReportTargetKind; targetId: string }) => `${target.kind}:${target.targetId}`

/** What a row reports, in words. */
const nounOf = (kind: ReportTargetKind) => (kind === 'reply' ? 'reply' : kind === 'profile' ? 'profile' : 'post')

/** The reason a moderation cites for a row: the post or reply itself; a profile cites nothing. */
const citedDocuments = (group: ReportedTarget) =>
  group.kind === 'profile' ? [] : [{ documentTypeName: group.kind, documentId: group.targetId }]

/**
 * A reported private post or reply, opened read-only from a report's box
 * (v13): the moderator's encryption key on this device opens the reporter's
 * key to it. Nothing is decrypted until asked.
 */
function ReportedPrivateContent({ group, post, moderatorId }: { group: ReportedTarget; post: Post; moderatorId: string }) {
  const [opened, setOpened] = useState<{ text: string } | { error: string } | null>(null)
  const boxes = group.reports.flatMap((report) => (report.box ? [report.box] : []))
  if (boxes.length === 0) {
    return <p className="text-xs text-gray-500 dark:text-gray-400">No report carries the key to it: ask the reporters by email.</p>
  }
  const open = async () => {
    const { getEncryptionKeyBytes } = await import('@/lib/secure-storage')
    const key = getEncryptionKeyBytes(moderatorId)
    if (!key) {
      setOpened({ error: 'Your encryption key is not on this device. Add it in Settings, then try again.' })
      return
    }
    let failure = 'The reports\' keys do not open it'
    for (const box of boxes) {
      const result = await openReportedContent(box, post, key)
      if (result.kind === 'opened') {
        setOpened({ text: result.text })
        return
      }
      failure = result.reason
    }
    setOpened({ error: failure })
  }
  if (!opened) {
    return (
      <Button variant="outline" size="sm" onClick={() => { open().catch((error: unknown) => setOpened({ error: error instanceof Error ? error.message : 'Could not open it' })) }} className="gap-1">
        <LockOpenIcon className="h-4 w-4" /> Read the private {group.kind === 'reply' ? 'reply' : 'post'}
      </Button>
    )
  }
  return 'text' in opened ? (
    <p data-testid={`report-private-content-${group.targetId}`} className="text-sm p-3 rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950 whitespace-pre-wrap break-words">
      {opened.text}
    </p>
  ) : (
    <p role="alert" className="text-xs text-red-600 dark:text-red-400">{opened.error}</p>
  )
}
const shortId = (id: string) => `${id.slice(0, 8)}…`
const reportsNoun = (count: number) => `${count} report${count === 1 ? '' : 's'}`

/** The views a moderator can switch between where reports are resolved (v10). */
const RESOLVED_VIEWS: ReadonlyArray<{ label: string; view: ReportView }> = [
  { label: 'Open', view: OPEN_REPORTS },
  ...REPORT_STATUSES.map((status) => ({ label: status.label, view: { kind: 'status' as const, status: status.code } })),
]

const sameView = (a: ReportView, b: ReportView) => JSON.stringify(a) === JSON.stringify(b)

/** The resolution form open on one row (v10). */
interface ResolveForm {
  key: string
  /** Null until chosen, where the row's reports were resolved differently. */
  status: ReportStatus | null
  note: string
}

/** A row being worked on, and how far along. */
interface Progress {
  key: string
  verb: 'Dismissing' | 'Purging' | 'Resolving'
  done: number
  total: number
}

interface ReportQueueProps {
  /** The seated team's charter reasons (read once by the panel): a seated team's dismissal must cite one (41203). */
  seatedReasons: SeatedReasonsState
  /** Hands the author and the reported post (or profile) to the panel's ban/suspend/warn form. */
  onModerateAuthor: (authorId: string, kind: ReportTargetKind, targetId: string) => void
}

/**
 * The moderators' queue of reported posts and replies, newest report first,
 * one row per target. From a row a moderator opens the post, removes it (the
 * usual reasoned removal), or takes the author to the ban/warn form.
 *
 * On v9 the moderator then dismisses every report on it, which deletes each
 * report as a moderator: one transition and one public removal record per
 * report, citing the post. A removed target keeps its reports until they are
 * cleared the same way. Reports filed by an identity the network protects from
 * moderation (the team, and a protected owner) cannot be dismissed; the
 * moderator's own are withdrawn instead, and the others stay until their
 * authors withdraw them.
 *
 * On v10 the moderator resolves them instead: a status and an optional note
 * written onto each report, which stays (its reporter sees the outcome) until
 * its 90-day ttl. Every report can be resolved, a protected reporter's too.
 * The queue lists the open reports, or those resolved with one status, or
 * those this moderator resolved. Spam reports can still be purged outright,
 * which leaves no removal record.
 */
export function ReportQueue({ seatedReasons, onModerateAuthor }: ReportQueueProps) {
  const { user } = useAuth()
  const { open: openModeratorRemoveModal } = useModeratorRemoveModal()
  const resolving = moderationService.canResolveReports()
  const [view, setView] = useState<ReportView>(OPEN_REPORTS)
  const [reports, setReports] = useState<ReportRecord[]>([])
  const [next, setNext] = useState<ReportCursor | undefined>()
  const [targets, setTargets] = useState<ReadonlyMap<string, TargetState>>(new Map())
  const [names, setNames] = useState<ReadonlyMap<string, string | null>>(new Map())
  /** Reporters no moderator may act on (the team, and a protected owner): their reports cannot be dismissed. */
  const [protectedIds, setProtectedIds] = useState<ReadonlySet<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [reasonDocumentId, setReasonDocumentId] = useState('')
  const [dismissing, setDismissing] = useState<Progress | null>(null)
  const [resolveForm, setResolveForm] = useState<ResolveForm | null>(null)
  /** The reports already shown, for telling a new page's reports from repeats. */
  const shownRef = useRef<readonly ReportRecord[]>([])
  useEffect(() => {
    shownRef.current = reports
  }, [reports])
  /** The view the latest load was for: a page for a view since left is dropped. */
  const viewRef = useRef<ReportView>(view)

  /** Resolves what the page's targets are now, and the usernames of their authors, reporters and moderators. */
  const hydrate = useCallback(async (page: readonly ReportRecord[]) => {
    const groups = groupReports(page)
    const ids = (kind: ReportTargetKind) => groups.filter((group) => group.kind === kind).map((group) => group.targetId)
    const people = page.flatMap((report) => [report.reporterId, report.targetOwnerId, ...(report.moderatedBy ? [report.moderatedBy] : [])])
    const [posts, replies, usernames] = await Promise.all([
      postService.getPostsByIds(ids('post')),
      replyService.getRepliesByIds(ids('reply')),
      dpnsService.resolveUsernamesBatch(people),
    ])
    const found = new Map<string, Post>([
      ...posts.map((post) => [keyOf({ kind: 'post', targetId: post.id }), post] as const),
      ...replies.map((reply) => [keyOf({ kind: 'reply', targetId: reply.id }), replyToPost(reply)] as const),
    ])
    // Those reads answer "nothing" on a failure too, so a missing target is
    // only removed when its removal record says so.
    const missing = (kind: TargetKind) => ids(kind).filter((id) => !found.has(keyOf({ kind, targetId: id })))
    const [removedPosts, removedReplies] = await Promise.all([
      moderationService.getRemovals('post', missing('post')),
      moderationService.getRemovals('reply', missing('reply')),
    ])
    const removed = (group: ReportedTarget) => {
      const removal = (group.kind === 'post' ? removedPosts : removedReplies).get(group.targetId)
      return removal !== undefined && removal.restoredAt === null
    }
    setTargets((previous) => {
      const next = new Map(previous)
      for (const group of groups) {
        const key = keyOf(group)
        // A removal seen here stands: a cached read may still hold the post.
        if (previous.get(key)?.state === 'removed') continue
        if (group.kind === 'profile') {
          next.set(key, { state: 'profile' })
          continue
        }
        const post = found.get(key)
        next.set(key, post ? { state: post.deleted ? 'tombstoned' : 'live', post } : removed(group) ? { state: 'removed' } : { state: 'unknown' })
      }
      return next
    })
    setNames((previous) => new Map([...previous, ...usernames]))
  }, [])

  const load = useCallback(async (requested: ReportView, cursor?: ReportCursor) => {
    viewRef.current = requested
    setLoading(true)
    setFailed(false)
    try {
      const [page, protectedNow] = await Promise.all([reportService.listView(requested, cursor), moderationService.getProtectedIdentities()])
      if (!sameView(viewRef.current, requested)) return
      setProtectedIds(protectedNow)
      const known = new Set(shownRef.current.map((report) => report.id))
      const fresh = cursor ? page.reports.filter((report) => !known.has(report.id)) : page.reports
      setReports((previous) => {
        if (!cursor) return page.reports
        const have = new Set(previous.map((report) => report.id))
        return [...previous, ...page.reports.filter((report) => !have.has(report.id))]
      })
      // A page resumed at the cursor's block time can hold only reports already
      // shown; stop there rather than offer the same page again.
      setNext(cursor && fresh.length === 0 ? undefined : page.next)
      if (!cursor) setTargets(new Map())
      await hydrate(page.reports)
    } catch (error) {
      if (!sameView(viewRef.current, requested)) return
      logger.error('ReportQueue: could not load reports', error)
      setFailed(true)
    } finally {
      if (sameView(viewRef.current, requested)) setLoading(false)
    }
  }, [hydrate])

  useEffect(() => {
    load(view).catch(() => { /* reported inside */ })
  }, [load, view])

  const switchView = (to: ReportView) => {
    if (sameView(to, view) || dismissing) return
    setReports([])
    setNext(undefined)
    setResolveForm(null)
    setView(to)
  }

  // A report resolved here since the page was read leaves a view it no longer matches.
  const shown = useMemo(() => reports.filter((report) => reportMatchesView(report, view)), [reports, view])
  const groups = useMemo(() => groupReports(shown), [shown])
  // Live targets first: the ones still waiting on a decision.
  const ordered = useMemo(() => {
    const pending = (group: ReportedTarget) => ['live', 'profile'].includes(targets.get(keyOf(group))?.state ?? 'live')
    return [...groups.filter(pending), ...groups.filter((group) => !pending(group))]
  }, [groups, targets])

  const nameOf = (id: string) => {
    const name = names.get(id)
    return name ? `@${name}` : shortId(id)
  }

  const dropReports = (ids: readonly string[]) => {
    const gone = new Set(ids)
    setReports((previous) => previous.filter((report) => !gone.has(report.id)))
  }

  /** False, with a toast, while a seated team's charter reason is unknown or not chosen (41203). */
  const charterReasonReady = (action: string) => {
    if (seatedReasons.loading || seatedReasons.failed) {
      toast.error(seatedReasons.failed ? 'Could not read the elected team\'s charter; reload and try again' : 'Still reading the elected team\'s charter')
      return false
    }
    if (seatedReasons.required && !reasonDocumentId) {
      toast.error(`Choose the charter reason ${action} are taken on`)
      return false
    }
    return true
  }

  /**
   * Every report on the row's target as the chain has it now, matched to what
   * the moderator saw: reports withdrawn or deleted elsewhere go, and new ones
   * are shown for review instead of being acted on unseen. Null when the row
   * cannot be acted on (the read failed, nothing is left, or there is more to
   * review); the reason has been told.
   */
  const rereadTarget = async (group: ReportedTarget, noun: string, verb: string): Promise<{ all: ReportRecord[]; protectedNow: Set<string> } | null> => {
    const key = keyOf(group)
    let all: ReportRecord[]
    let protectedNow: Set<string>
    try {
      [all, protectedNow] = await Promise.all([
        reportService.listForTarget(group.kind, group.targetId),
        moderationService.getProtectedIdentities(),
      ])
    } catch (error) {
      logger.error('ReportQueue: could not read the target\'s reports', error)
      toast.error(`Could not read the reports on this ${noun}; try again`)
      return null
    }
    setProtectedIds(protectedNow)
    setReports((previous) => [...previous.filter((report) => keyOf(report) !== key), ...all])
    const inView = all.filter((report) => reportMatchesView(report, view))
    if (inView.length === 0) {
      toast('These reports are already gone.')
      return null
    }
    const seen = new Set(group.reports.map((report) => report.id))
    const fresh = inView.filter((report) => !seen.has(report.id))
    if (fresh.length > 0) {
      toast(`${fresh.length} more report${fresh.length === 1 ? '' : 's'} on this ${noun} that ${fresh.length === 1 ? 'wasn\'t' : 'weren\'t'} shown. Review ${fresh.length === 1 ? 'it' : 'them'}, then ${verb} again.`, { duration: 8000 })
      return null
    }
    return { all: inView, protectedNow }
  }

  /**
   * Deletes every report on a target the moderator has seen: a dismissal on
   * v9, a purge (no removal record) on v10. The moderator's own reports are
   * withdrawn (a moderator is protected from moderation, 41102), and other
   * protected reporters' reports are left.
   */
  const dismiss = async (group: ReportedTarget) => {
    if (!user || dismissing || loading) return
    if (!charterReasonReady(resolving ? 'purges' : 'dismissals')) return
    const key = keyOf(group)
    const state = targets.get(key)?.state
    if (state === undefined || state === 'unknown') return
    const noun = nounOf(group.kind)
    const verb = resolving ? 'Purging' : 'Dismissing'
    const done = resolving ? 'purged' : 'dismissed'
    setDismissing({ key, verb, done: 0, total: group.reports.length })
    const read = await rereadTarget(group, noun, resolving ? 'purge' : 'dismiss')
    if (!read) {
      setDismissing(null)
      return
    }
    const { all, protectedNow } = read
    const own = all.filter((report) => report.reporterId === user.identityId)
    const dismissable = all.filter((report) => report.reporterId !== user.identityId && !protectedNow.has(report.reporterId))
    const kept = all.length - own.length - dismissable.length
    const keptNote = kept > 0
      ? ` ${kept} report${kept === 1 ? '' : 's'} by moderators stay${kept === 1 ? 's' : ''}: moderators are protected from moderation, so only their authors can withdraw them.`
      : ''
    const total = own.length + dismissable.length
    if (total === 0) {
      setDismissing(null)
      toast(keptNote.trim(), { duration: 8000 })
      return
    }
    setDismissing({ key, verb, done: 0, total })
    const step = () => setDismissing((progress) => (progress ? { ...progress, done: progress.done + 1 } : progress))
    const gone: string[] = []
    for (const report of own) {
      const withdrawn = await reportService.withdrawReport(user.identityId, report.id)
      if (!withdrawn.success && !isReportGoneError(withdrawn.error)) {
        setDismissing(null)
        dropReports(gone)
        toast.error(withdrawFailureMessage(withdrawn.error))
        return
      }
      gone.push(report.id)
      step()
    }
    const result: ModerationResult & { dismissed: string[] } = dismissable.length === 0
      ? { success: true, dismissed: [] }
      : await moderationService.dismissReports(user.identityId, dismissable.map((report) => report.id), {
        text: resolving
          ? 'Report purged'
          : state === 'removed'
            ? `Report handled: the ${noun} was removed`
            : state === 'tombstoned' ? `Report handled: its author deleted the ${noun}` : 'Report reviewed: no action taken',
        documents: citedDocuments(group),
        ...(seatedReasons.required && reasonDocumentId ? { reasonDocumentId } : {}),
      }, step)
    setDismissing(null)
    gone.push(...result.dismissed)
    dropReports(gone)
    if (result.errorCode === 'MAYBE_APPLIED') {
      toast(`${gone.length} of ${total} reports ${done}; the network did not confirm the next in time. Reload the queue before retrying.`, { duration: 8000 })
      return
    }
    if (!result.success) {
      toast.error(`${gone.length > 0 ? `${gone.length} of ${total} reports ${done}. ` : ''}${result.error || (resolving ? 'Purge failed' : 'Dismissal failed')}`)
      return
    }
    toast.success(`${reportsNoun(total)} ${done}.${keptNote}`, { duration: kept > 0 ? 8000 : 4000 })
  }

  const openResolveForm = (group: ReportedTarget) => {
    const { status, note } = resolutionFormStart(group.reports, targets.get(keyOf(group))?.state === 'removed')
    setResolveForm({ key: keyOf(group), status, note })
  }

  /**
   * Resolves every report on a target the moderator has seen (v10), with the
   * status and note in the row's form. Each report stays, now handled; the
   * ones already reading exactly this way are skipped.
   */
  const resolve = async (group: ReportedTarget, form: ResolveForm) => {
    if (!user || dismissing || loading) return
    const { status } = form
    const problem = resolutionInputProblem(status, form.note)
    if (problem || status === null) {
      toast.error(problem ?? 'Choose how the report was resolved')
      return
    }
    if (!charterReasonReady('resolutions')) return
    const key = keyOf(group)
    const noun = nounOf(group.kind)
    setDismissing({ key, verb: 'Resolving', done: 0, total: group.reports.length })
    const read = await rereadTarget(group, noun, 'resolve')
    if (!read) {
      setDismissing(null)
      return
    }
    const note = form.note.trim() || null
    const pending = reportsNeedingResolution(read.all, status, note)
    if (pending.length === 0) {
      setDismissing(null)
      setResolveForm(null)
      toast('These reports already read that way.')
      return
    }
    setDismissing({ key, verb: 'Resolving', done: 0, total: pending.length })
    const step = () => setDismissing((progress) => (progress ? { ...progress, done: progress.done + 1 } : progress))
    const result = await moderationService.resolveReports(user.identityId, pending, { status, note: form.note }, {
      text: `Report resolved: ${reportStatusLabel(status).toLowerCase()}`,
      documents: citedDocuments(group),
      ...(seatedReasons.required && reasonDocumentId ? { reasonDocumentId } : {}),
    }, step)
    setDismissing(null)
    const resolvedIds = new Set(result.resolved)
    const byOthers = new Set(result.alreadyResolved)
    const goneIds = new Set(result.gone)
    const now = Date.now()
    // The ones refused as unchanged were written meanwhile, most likely by
    // another moderator: who and when is unknown until the queue is read again.
    setReports((previous) => previous
      .filter((report) => !goneIds.has(report.id))
      .map((report) => (resolvedIds.has(report.id)
        ? { ...report, status, resolution: note, ...(byOthers.has(report.id) ? { moderatedBy: null, moderatedAt: null } : { moderatedBy: user.identityId, moderatedAt: now }) }
        : report)))
    const count = result.resolved.length
    if (result.errorCode === 'MAYBE_APPLIED') {
      toast(`${count} of ${pending.length} reports resolved; the network did not confirm the next in time. Reload the queue before retrying.`, { duration: 8000 })
      return
    }
    if (!result.success) {
      toast.error(`${count > 0 ? `${count} of ${pending.length} reports resolved. ` : ''}${result.error || 'Resolving failed'}`)
      return
    }
    setResolveForm(null)
    const goneNote = result.gone.length > 0 ? ` ${reportsNoun(result.gone.length)} had been withdrawn or had expired.` : ''
    const othersNote = byOthers.size > 0 ? ` ${reportsNoun(byOthers.size)} had already been resolved this way meanwhile.` : ''
    toast.success(`${reportsNoun(count)} resolved: ${reportStatusLabel(status).toLowerCase()}.${othersNote}${goneNote}`)
  }

  const remove = (group: ReportedTarget, post: Post) => {
    openModeratorRemoveModal(post, () => {
      // The by-id reads cache for two minutes; the next page must not bring it back.
      if (group.kind === 'post') postService.clearCache(group.targetId)
      else replyService.clearCache(group.targetId)
      setTargets((previous) => new Map(previous).set(keyOf(group), { state: 'removed' }))
      setResolveForm((form) => (form?.key === keyOf(group) ? { ...form, status: 2 } : form))
    })
  }

  const myView: ReportView | null = user ? { kind: 'moderatedBy', moderatorId: user.identityId } : null
  const views = resolving ? [...RESOLVED_VIEWS, ...(myView ? [{ label: 'Resolved by me', view: myView }] : [])] : []
  const viewingOpen = view.kind === 'open'

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><FlagIcon className="h-5 w-5" /> Reports</CardTitle>
        <CardDescription>
          {resolving ? (
            <>
              Posts and replies readers reported, newest report first. Resolving marks every report on the post with how
              it was handled and an optional note, one moderation transition each; the reports stay, so their reporters
              see the outcome. Reports expire on their own 90 days after they were filed.
            </>
          ) : (
            <>
              Posts and replies readers reported, newest report first. Dismissing deletes every report on the post, one
              moderation transition each, and leaves a public removal record per report. Reports expire on their own 90 days
              after they were filed.
            </>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {views.length > 0 && (
          <div role="tablist" aria-label="Which reports" className="flex flex-wrap gap-1">
            {views.map(({ label, view: option }) => (
              <Button
                key={label}
                role="tab"
                aria-selected={sameView(option, view)}
                variant={sameView(option, view) ? 'default' : 'outline'}
                size="sm"
                disabled={dismissing !== null}
                onClick={() => switchView(option)}
              >
                {label}
              </Button>
            ))}
          </div>
        )}
        {(seatedReasons.required || seatedReasons.failed) && (
          <CharterReasonPicker id="report-queue-charter-reason" state={seatedReasons} value={reasonDocumentId} onChange={setReasonDocumentId} />
        )}
        {failed && (
          <div role="alert" className="flex items-center justify-between gap-2 text-sm rounded-lg border border-red-300 dark:border-red-800 p-3 text-red-600 dark:text-red-400">
            <span>Could not load the reports.</span>
            <Button variant="outline" size="sm" onClick={() => { load(view).catch(() => { /* reported inside */ }) }}>Retry</Button>
          </div>
        )}
        {!failed && !loading && ordered.length === 0 && (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {next
              ? 'None among the latest reports. Load older reports to look further back.'
              : viewingOpen ? 'No reports. Nothing is waiting for review.' : 'No reports resolved this way.'}
          </p>
        )}
        <ul className="space-y-3">
          {ordered.map((group) => {
            const key = keyOf(group)
            const target = targets.get(key)
            const noun = nounOf(group.kind)
            const busy = dismissing?.key === key
            const count = group.reports.length
            const form = resolveForm?.key === key ? resolveForm : null
            // From the row as it is now: a reread can add reports while the form is open.
            const differ = form ? resolutionFormStart(group.reports, false) : null
            return (
              <li key={key} data-testid={`report-row-${group.targetId}`} className="rounded-lg border border-gray-200 dark:border-gray-800 p-3 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span className="font-medium flex items-center gap-1">
                    {group.urgent && (
                      <span data-testid={`report-urgent-${group.targetId}`} className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-red-600 text-white">
                        <ExclamationTriangleIcon className="h-3 w-3" /> Urgent
                      </span>
                    )}
                    {noun === 'profile' ? 'Profile of' : noun === 'reply' ? 'Reply by' : 'Post by'} {nameOf(group.targetOwnerId)} · {count} report{count === 1 ? '' : 's'}
                    {next ? ' loaded' : ''}
                  </span>
                  <span className="text-gray-500 dark:text-gray-400">latest {new Date(group.latestAt).toLocaleString()}</span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {group.reasonCounts.map(({ code, count: times }) => (
                    <span key={code} className="text-xs px-2 py-0.5 rounded-full bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300">
                      {reportReasonLabel(code)}{times > 1 ? ` ×${times}` : ''}
                    </span>
                  ))}
                </div>
                {target === undefined ? (
                  <p className="text-sm text-gray-500 dark:text-gray-400">Loading the {noun}…</p>
                ) : target.state === 'removed' ? (
                  <p className="text-sm italic text-gray-500 dark:text-gray-400">
                    {resolving
                      ? `This ${noun} has been removed. Resolve its reports as content removed.`
                      : `This ${noun} has been removed. Its reports are handled; clear them when convenient.`}
                  </p>
                ) : target.state === 'unknown' ? (
                  <p className="text-sm text-red-600 dark:text-red-400">
                    {resolving
                      ? `Could not load this ${noun}: its author may have deleted it, or the read failed. Reload the queue to try again.`
                      : `Could not load this ${noun}. Reload the queue to try again.`}
                  </p>
                ) : target.state === 'tombstoned' ? (
                  <p className="text-sm italic text-gray-500 dark:text-gray-400">Its author deleted this {noun}.</p>
                ) : target.state === 'profile' ? (
                  <Link href={`/user?id=${group.targetId}`} className="block text-sm p-3 bg-gray-50 dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-700">
                    Open {nameOf(group.targetId)}&apos;s profile
                  </Link>
                ) : (
                  <Link href={`/post?id=${group.targetId}`} className="block text-sm p-3 bg-gray-50 dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-700">
                    <span className="line-clamp-4 whitespace-pre-wrap break-words">
                      {target.post.encryptedContent ? `Private ${noun}: its content is encrypted to the author's followers.` : target.post.content || '(no text)'}
                    </span>
                    {(target.post.media?.length ?? 0) > 0 && <span className="block mt-1 text-xs text-gray-500">+ media</span>}
                  </Link>
                )}
                {target?.state === 'live' && target.post.encryptedContent && user && (
                  <ReportedPrivateContent group={group} post={target.post} moderatorId={user.identityId} />
                )}
                <details className="text-sm">
                  <summary className="cursor-pointer text-gray-600 dark:text-gray-400">What reporters said</summary>
                  <ul className="mt-2 space-y-2">
                    {group.reports.map((report) => (
                      <li key={report.id} className="border-l-2 border-gray-200 dark:border-gray-700 pl-2">
                        <span className="font-medium">{reportReasonLabel(report.reason)}</span>
                        <span className="text-gray-500 dark:text-gray-400">
                          {' · '}{nameOf(report.reporterId)} · {new Date(report.createdAt).toLocaleDateString()}
                          {report.reporterId === user?.identityId
                            ? resolving ? ' · yours' : ' · yours: dismissing withdraws it'
                            : protectedIds.has(report.reporterId) && !resolving ? ' · by a moderator: only they can withdraw it' : ''}
                        </span>
                        {report.note && <p className="whitespace-pre-wrap break-words">{report.note}</p>}
                        {report.status !== null && (
                          <p className="text-xs text-gray-500 dark:text-gray-400" data-testid={`report-resolution-${report.id}`}>
                            Resolved: <span className="font-medium">{reportStatusLabel(report.status)}</span>
                            {report.moderatedBy ? ` by ${nameOf(report.moderatedBy)}` : ''}
                            {report.moderatedAt ? ` · ${new Date(report.moderatedAt).toLocaleString()}` : ''}
                            {report.resolution && <span className="block whitespace-pre-wrap break-words text-gray-700 dark:text-gray-300">{report.resolution}</span>}
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                </details>
                {form && (
                  <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-3 space-y-2" data-testid={`report-resolve-form-${group.targetId}`}>
                    <fieldset disabled={dismissing !== null}>
                      <legend className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">How were these reports resolved?</legend>
                      {differ?.statusesDiffer && (
                        <p className="text-xs text-amber-700 dark:text-amber-400 mb-1">These reports were resolved differently. The outcome chosen here applies to all of them.</p>
                      )}
                      {REPORT_STATUSES.map((option) => (
                        <label key={option.code} className="flex items-start gap-2 py-1 text-sm cursor-pointer">
                          <input
                            type="radio"
                            name={`report-status-${key}`}
                            value={option.code}
                            checked={form.status === option.code}
                            onChange={() => setResolveForm({ ...form, status: option.code })}
                            className="mt-1 accent-yappr-500"
                          />
                          <span>
                            <span className="block font-medium">{option.label}</span>
                            <span className="block text-xs text-gray-500 dark:text-gray-400">{option.hint}</span>
                          </span>
                        </label>
                      ))}
                    </fieldset>
                    <label htmlFor={`report-resolution-${key}`} className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                      Note for the reporters (optional, public)
                    </label>
                    <textarea
                      id={`report-resolution-${key}`}
                      value={form.note}
                      maxLength={REPORT_RESOLUTION_MAX_LENGTH}
                      rows={2}
                      disabled={dismissing !== null}
                      onChange={(e) => setResolveForm({ ...form, note: e.target.value })}
                      className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-neutral-800 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-yappr-500"
                    />
                    {differ?.notesDiffer && (
                      <p className="text-xs text-amber-700 dark:text-amber-400">
                        These reports carry different notes. The note written here replaces all of them; left empty, it removes them.
                      </p>
                    )}
                    <p className="text-xs text-gray-500 dark:text-gray-400 text-right">{form.note.length}/{REPORT_RESOLUTION_MAX_LENGTH}</p>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        disabled={dismissing !== null || resolutionInputProblem(form.status, form.note) !== null}
                        onClick={() => { resolve(group, form).catch(() => { /* reported inside */ }) }}
                        className="gap-1"
                      >
                        <CheckCircleIcon className="h-4 w-4" />
                        {busy && dismissing?.verb === 'Resolving' ? `Resolving ${dismissing.done} of ${dismissing.total}…` : `Resolve ${reportsNoun(count)}`}
                      </Button>
                      <Button variant="outline" size="sm" disabled={dismissing !== null} onClick={() => setResolveForm(null)}>Cancel</Button>
                    </div>
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  {target?.state === 'live' && !protectedIds.has(group.targetOwnerId) && (
                    <Button variant="destructive" size="sm" disabled={dismissing !== null} onClick={() => remove(group, target.post)} className="gap-1">
                      <ShieldExclamationIcon className="h-4 w-4" /> Remove {noun}
                    </Button>
                  )}
                  {/* A protected author (a moderator, or an ownerProtected owner) is moderated by nobody: 41102, paid. */}
                  {!protectedIds.has(group.targetOwnerId) && (
                    <Button variant="outline" size="sm" disabled={dismissing !== null} onClick={() => onModerateAuthor(group.targetOwnerId, group.kind, group.targetId)} className="gap-1">
                      <UserIcon className="h-4 w-4" /> Warn, suspend or ban the author
                    </Button>
                  )}
                  {resolving ? (
                    <>
                      {!form && (
                        <Button variant="outline" size="sm" disabled={dismissing !== null || loading || target === undefined} onClick={() => openResolveForm(group)} className="gap-1">
                          <CheckCircleIcon className="h-4 w-4" /> {viewingOpen ? 'Resolve reports' : 'Change resolution'}
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        title="Delete these reports outright, for spam reports: no record is kept and their reporters see nothing"
                        disabled={dismissing !== null || loading || target === undefined || target.state === 'unknown'}
                        onClick={() => { dismiss(group).catch(() => { /* reported inside */ }) }}
                        className="gap-1"
                      >
                        <TrashIcon className="h-4 w-4" />
                        {busy && dismissing?.verb === 'Purging' ? `Purging ${dismissing.done} of ${dismissing.total}…` : 'Purge as spam'}
                      </Button>
                    </>
                  ) : (
                    <Button variant="outline" size="sm" disabled={dismissing !== null || loading || target === undefined || target.state === 'unknown'} onClick={() => { dismiss(group).catch(() => { /* reported inside */ }) }} className="gap-1">
                      <CheckCircleIcon className="h-4 w-4" />
                      {busy && dismissing
                        ? `Dismissing ${dismissing.done} of ${dismissing.total}…`
                        : target?.state === 'live' ? 'Dismiss reports' : 'Clear reports'}
                    </Button>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
        {loading && <p className="text-sm text-gray-500 dark:text-gray-400">Loading reports…</p>}
        {!loading && next && (
          <Button variant="outline" size="sm" disabled={dismissing !== null} onClick={() => { load(view, next).catch(() => { /* reported inside */ }) }}>
            Load older reports
          </Button>
        )}
      </CardContent>
    </Card>
  )
}
