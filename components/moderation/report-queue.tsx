'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import toast from 'react-hot-toast'
import { CheckCircleIcon, FlagIcon, ShieldExclamationIcon, UserIcon } from '@heroicons/react/24/outline'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/contexts/auth-context'
import { useModeratorRemoveModal } from '@/hooks/use-moderator-remove-modal'
import { logger } from '@/lib/logger'
import { groupReports, isReportGoneError, reportReasonLabel, withdrawFailureMessage, type ReportRecord, type ReportedTarget } from '@/lib/reports'
import type { TargetKind } from '@/lib/contract-topology'
import type { Post } from '@/lib/types'
import { dpnsService } from '@/lib/services/dpns-service'
import { moderationService, type ModerationResult } from '@/lib/services/moderation-service'
import { postService, replyToPost } from '@/lib/services/post-service'
import { replyService } from '@/lib/services/reply-service'
import { reportService, type ReportCursor } from '@/lib/services/report-service'
import { CharterReasonPicker, type SeatedReasonsState } from './charter-reason-picker'

/**
 * What a report's target is now: live (with the post to show), deleted by its
 * author, removed by a moderator (a removal record says so), or unknown (it
 * could not be read, and no removal record explains why).
 */
type TargetState = { state: 'live'; post: Post } | { state: 'tombstoned'; post: Post } | { state: 'removed' } | { state: 'unknown' }

const keyOf = (target: { kind: TargetKind; targetId: string }) => `${target.kind}:${target.targetId}`
const shortId = (id: string) => `${id.slice(0, 8)}…`

interface ReportQueueProps {
  /** The seated team's charter reasons (read once by the panel): a seated team's dismissal must cite one (41203). */
  seatedReasons: SeatedReasonsState
  /** Hands the author and the reported post to the panel's ban/suspend/warn form. */
  onModerateAuthor: (authorId: string, kind: TargetKind, targetId: string) => void
}

/**
 * The moderators' queue of reported posts and replies, newest report first,
 * one row per target. From a row a moderator opens the post, removes it (the
 * usual reasoned removal), takes the author to the ban/warn form, or dismisses
 * every report on it, which deletes each report as a moderator: one
 * transition and one public removal record per report, citing the post.
 * A removed target keeps its reports until they are cleared the same way.
 * Reports filed by an identity the network protects from moderation (the
 * team, and a protected owner) cannot be dismissed; the moderator's own are
 * withdrawn instead, and the others stay until their authors withdraw them.
 */
export function ReportQueue({ seatedReasons, onModerateAuthor }: ReportQueueProps) {
  const { user } = useAuth()
  const { open: openModeratorRemoveModal } = useModeratorRemoveModal()
  const [reports, setReports] = useState<ReportRecord[]>([])
  const [next, setNext] = useState<ReportCursor | undefined>()
  const [targets, setTargets] = useState<ReadonlyMap<string, TargetState>>(new Map())
  const [names, setNames] = useState<ReadonlyMap<string, string | null>>(new Map())
  /** Reporters no moderator may act on (the team, and a protected owner): their reports cannot be dismissed. */
  const [protectedIds, setProtectedIds] = useState<ReadonlySet<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [reasonDocumentId, setReasonDocumentId] = useState('')
  /** The row being dismissed, and how far along. */
  const [dismissing, setDismissing] = useState<{ key: string; done: number; total: number } | null>(null)
  /** The reports already shown, for telling a new page's reports from repeats. */
  const shownRef = useRef<readonly ReportRecord[]>([])
  useEffect(() => {
    shownRef.current = reports
  }, [reports])

  /** Resolves what the page's targets are now, and the usernames of their authors and reporters. */
  const hydrate = useCallback(async (page: readonly ReportRecord[]) => {
    const groups = groupReports(page)
    const ids = (kind: TargetKind) => groups.filter((group) => group.kind === kind).map((group) => group.targetId)
    const [posts, replies, usernames] = await Promise.all([
      postService.getPostsByIds(ids('post')),
      replyService.getRepliesByIds(ids('reply')),
      dpnsService.resolveUsernamesBatch(page.flatMap((report) => [report.reporterId, report.targetOwnerId])),
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
        const post = found.get(key)
        next.set(key, post ? { state: post.deleted ? 'tombstoned' : 'live', post } : removed(group) ? { state: 'removed' } : { state: 'unknown' })
      }
      return next
    })
    setNames((previous) => new Map([...previous, ...usernames]))
  }, [])

  const load = useCallback(async (cursor?: ReportCursor) => {
    setLoading(true)
    setFailed(false)
    try {
      const [page, protectedNow] = await Promise.all([reportService.listRecent(cursor), moderationService.getProtectedIdentities()])
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
      logger.error('ReportQueue: could not load reports', error)
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }, [hydrate])

  useEffect(() => {
    load().catch(() => { /* reported inside */ })
  }, [load])

  const groups = useMemo(() => groupReports(reports), [reports])
  // Live targets first: the ones still waiting on a decision.
  const ordered = useMemo(() => {
    const pending = (group: ReportedTarget) => (targets.get(keyOf(group))?.state ?? 'live') === 'live'
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

  /**
   * Dismisses every report on a target the moderator has seen. The row is
   * first matched to the chain: reports withdrawn or dismissed elsewhere go,
   * and new ones are shown for review instead of being dismissed unseen. The
   * moderator's own reports are withdrawn (a moderator is protected from
   * moderation, 41102), and other protected reporters' reports are left.
   */
  const dismiss = async (group: ReportedTarget) => {
    if (!user || dismissing || loading) return
    if (seatedReasons.loading || seatedReasons.failed) {
      toast.error(seatedReasons.failed ? 'Could not read the elected team\'s charter; reload and try again' : 'Still reading the elected team\'s charter')
      return
    }
    if (seatedReasons.required && !reasonDocumentId) {
      toast.error('Choose the charter reason dismissals are taken on')
      return
    }
    const key = keyOf(group)
    const state = targets.get(key)?.state
    if (state === undefined || state === 'unknown') return
    const noun = group.kind === 'reply' ? 'reply' : 'post'
    setDismissing({ key, done: 0, total: group.reports.length })
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
      setDismissing(null)
      return
    }
    setProtectedIds(protectedNow)
    setReports((previous) => [...previous.filter((report) => keyOf(report) !== key), ...all])
    if (all.length === 0) {
      setDismissing(null)
      toast('These reports are already gone.')
      return
    }
    const shown = new Set(group.reports.map((report) => report.id))
    const fresh = all.filter((report) => !shown.has(report.id))
    if (fresh.length > 0) {
      setDismissing(null)
      toast(`${fresh.length} new report${fresh.length === 1 ? '' : 's'} came in on this ${noun}. Review ${fresh.length === 1 ? 'it' : 'them'}, then dismiss again.`, { duration: 8000 })
      return
    }
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
    setDismissing({ key, done: 0, total })
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
        text: state === 'removed'
          ? `Report handled: the ${noun} was removed`
          : state === 'tombstoned' ? `Report handled: its author deleted the ${noun}` : 'Report reviewed: no action taken',
        documents: [{ documentTypeName: group.kind, documentId: group.targetId }],
        ...(seatedReasons.required && reasonDocumentId ? { reasonDocumentId } : {}),
      }, step)
    setDismissing(null)
    gone.push(...result.dismissed)
    dropReports(gone)
    if (result.errorCode === 'MAYBE_APPLIED') {
      toast(`${gone.length} of ${total} reports dismissed; the network did not confirm the next in time. Reload the queue before retrying.`, { duration: 8000 })
      return
    }
    if (!result.success) {
      toast.error(`${gone.length > 0 ? `${gone.length} of ${total} reports dismissed. ` : ''}${result.error || 'Dismissal failed'}`)
      return
    }
    toast.success(`${total} report${total === 1 ? '' : 's'} dismissed.${keptNote}`, { duration: kept > 0 ? 8000 : 4000 })
  }

  const remove = (group: ReportedTarget, post: Post) => {
    openModeratorRemoveModal(post, () => {
      // The by-id reads cache for two minutes; the next page must not bring it back.
      if (group.kind === 'post') postService.clearCache(group.targetId)
      else replyService.clearCache(group.targetId)
      setTargets((previous) => new Map(previous).set(keyOf(group), { state: 'removed' }))
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><FlagIcon className="h-5 w-5" /> Reports</CardTitle>
        <CardDescription>
          Posts and replies readers reported, newest report first. Dismissing deletes every report on the post, one
          moderation transition each, and leaves a public removal record per report; the reporters are not refunded.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {(seatedReasons.required || seatedReasons.failed) && (
          <CharterReasonPicker id="report-queue-charter-reason" state={seatedReasons} value={reasonDocumentId} onChange={setReasonDocumentId} />
        )}
        {failed && (
          <div role="alert" className="flex items-center justify-between gap-2 text-sm rounded-lg border border-red-300 dark:border-red-800 p-3 text-red-600 dark:text-red-400">
            <span>Could not load the reports.</span>
            <Button variant="outline" size="sm" onClick={() => { load().catch(() => { /* reported inside */ }) }}>Retry</Button>
          </div>
        )}
        {!failed && !loading && ordered.length === 0 && (
          <p className="text-sm text-gray-500 dark:text-gray-400">No reports. Nothing is waiting for review.</p>
        )}
        <ul className="space-y-3">
          {ordered.map((group) => {
            const key = keyOf(group)
            const target = targets.get(key)
            const noun = group.kind === 'reply' ? 'reply' : 'post'
            const busy = dismissing?.key === key
            const count = group.reports.length
            return (
              <li key={key} data-testid={`report-row-${group.targetId}`} className="rounded-lg border border-gray-200 dark:border-gray-800 p-3 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span className="font-medium">
                    {noun === 'reply' ? 'Reply' : 'Post'} by {nameOf(group.targetOwnerId)} · {count} report{count === 1 ? '' : 's'}
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
                  <p className="text-sm italic text-gray-500 dark:text-gray-400">This {noun} has been removed. Its reports are handled; clear them when convenient.</p>
                ) : target.state === 'unknown' ? (
                  <p className="text-sm text-red-600 dark:text-red-400">Could not load this {noun}. Reload the queue to try again.</p>
                ) : target.state === 'tombstoned' ? (
                  <p className="text-sm italic text-gray-500 dark:text-gray-400">Its author deleted this {noun}.</p>
                ) : (
                  <Link href={`/post?id=${group.targetId}`} className="block text-sm p-3 bg-gray-50 dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-700">
                    <span className="line-clamp-4 whitespace-pre-wrap break-words">
                      {target.post.encryptedContent ? `Private ${noun}: its content is encrypted to the author's followers.` : target.post.content || '(no text)'}
                    </span>
                    {(target.post.media?.length ?? 0) > 0 && <span className="block mt-1 text-xs text-gray-500">+ media</span>}
                  </Link>
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
                            ? ' · yours: dismissing withdraws it'
                            : protectedIds.has(report.reporterId) ? ' · by a moderator: only they can withdraw it' : ''}
                        </span>
                        {report.note && <p className="whitespace-pre-wrap break-words">{report.note}</p>}
                      </li>
                    ))}
                  </ul>
                </details>
                <div className="flex flex-wrap gap-2">
                  {target?.state === 'live' && (
                    <Button variant="destructive" size="sm" disabled={dismissing !== null} onClick={() => remove(group, target.post)} className="gap-1">
                      <ShieldExclamationIcon className="h-4 w-4" /> Remove {noun}
                    </Button>
                  )}
                  <Button variant="outline" size="sm" disabled={dismissing !== null} onClick={() => onModerateAuthor(group.targetOwnerId, group.kind, group.targetId)} className="gap-1">
                    <UserIcon className="h-4 w-4" /> Warn, suspend or ban the author
                  </Button>
                  <Button variant="outline" size="sm" disabled={dismissing !== null || loading || target === undefined || target.state === 'unknown'} onClick={() => { dismiss(group).catch(() => { /* reported inside */ }) }} className="gap-1">
                    <CheckCircleIcon className="h-4 w-4" />
                    {busy && dismissing
                      ? `Dismissing ${dismissing.done} of ${dismissing.total}…`
                      : target?.state === 'live' ? 'Dismiss reports' : 'Clear reports'}
                  </Button>
                </div>
              </li>
            )
          })}
        </ul>
        {loading && <p className="text-sm text-gray-500 dark:text-gray-400">Loading reports…</p>}
        {!loading && next && (
          <Button variant="outline" size="sm" disabled={dismissing !== null} onClick={() => { load(next).catch(() => { /* reported inside */ }) }}>
            Load older reports
          </Button>
        )}
      </CardContent>
    </Card>
  )
}
