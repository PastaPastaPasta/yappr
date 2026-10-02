'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import toast from 'react-hot-toast'
import { ArrowPathIcon, CheckIcon, UserGroupIcon } from '@heroicons/react/24/outline'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/contexts/auth-context'
import { logger } from '@/lib/logger'
import { dpnsService } from '@/lib/services/dpns-service'
import { authorDeletesLeaveHoles } from '@/lib/contract-topology'
import { countedSigners, moderationService, teamCanApprove, type SeatedTeamSeats, type TeamAction, type TeamActionTargetState } from '@/lib/services/moderation-service'
import type { SeatedReasonsState } from './charter-reason-picker'

const shortId = (id: string) => `${id.slice(0, 8)}…`
/** How many active actions the panel shows (and reads signers and document liveness for), newest first. */
const ACTIVE_SHOWN = 20
/** How many closed actions the panel shows, from one page read. */
const CLOSED_SHOWN = 10
/** One page of closed actions: their ids are hashes, so more pages would not make the sample any more recent. */
const CLOSED_READ = 100

interface TeamActionsState {
  /** The newest {@link ACTIVE_SHOWN} active actions. */
  active: TeamAction[]
  /** Active actions read in all (more may exist when `activeTruncated`). */
  activeTotal: number
  activeTruncated: boolean
  closed: TeamAction[]
  /** Closed actions exist beyond the page read: the list is a sample, not the latest. */
  closedSample: boolean
  /** Who approved each shown active action, by action id; absent when the read failed. */
  signers: ReadonlyMap<string, string[]>
  /**
   * Shown active actions that can never run, by action id: their document is
   * proved gone, or it changed after the proposal (on v11 its author's
   * tombstone), which Drive refuses every approval of (41211). Neither lapses.
   */
  dead: ReadonlyMap<string, Exclude<TeamActionTargetState, 'live'>>
  seated: SeatedTeamSeats | null
}

/** The shown actions that can never run; an action whose document could not be read is not claimed dead. */
async function deadActions(actions: readonly TeamAction[]): Promise<Map<string, Exclude<TeamActionTargetState, 'live'>>> {
  const dead = new Map<string, Exclude<TeamActionTargetState, 'live'>>()
  for (const [actionId, state] of await moderationService.readTeamActionTargets(actions)) {
    if (state !== 'live') dead.set(actionId, state)
  }
  return dead
}

/**
 * The seated team's queue of settled deletions (v11): a member proposes the
 * removal of a post or reply past its week (from the post menu), and the
 * others approve it here until the leader and enough members agree, when it
 * runs. An active action shows its approvals against what its rule needs
 * (`min(approvals, seats)`), who signed, the document and the reason; a
 * member who has not signed may approve. A team removal is never undone
 * (41209), so there is no restore here. Recently closed actions follow.
 * Renders nothing where no type is deleted by the team.
 */
export function TeamActionsPanel({ seatedReasons, onChanged }: { seatedReasons: SeatedReasonsState; onChanged?: () => void }) {
  const { user } = useAuth()
  const enabled = moderationService.teamDeletesSettled()
  const [state, setState] = useState<TeamActionsState | null>(null)
  const [names, setNames] = useState<ReadonlyMap<string, string | null>>(new Map())
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [approving, setApproving] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setFailed(false)
    try {
      const [active, closed, seated] = await Promise.all([
        moderationService.listTeamActions('active'),
        moderationService.listTeamActions('closed', { max: CLOSED_READ }),
        moderationService.getSeatedTeam(),
      ])
      const shown = [...active.actions].sort((a, b) => b.proposedAt - a.proposedAt).slice(0, ACTIVE_SHOWN)
      // The exact approvals of an active action are its signers still on the
      // team; `approvalCount` alone may count a member who left. Read only for
      // the rows shown.
      const [signerPairs, dead] = await Promise.all([
        Promise.all(shown.map(async (action) => {
          try {
            return [action.actionId, await moderationService.teamActionSigners(action.actionId, 'active')] as const
          } catch (error) {
            logger.warn('TeamActionsPanel: signers read failed', error)
            return null
          }
        })),
        deadActions(shown),
      ])
      const signers = new Map(signerPairs.filter((pair) => pair !== null))
      const recentClosed = [...closed.actions].sort((a, b) => b.proposedAt - a.proposedAt).slice(0, CLOSED_SHOWN)
      setState({
        active: shown,
        activeTotal: active.actions.length,
        activeTruncated: active.truncated,
        closed: recentClosed,
        closedSample: closed.truncated,
        signers,
        dead,
        seated,
      })
      const people = [...shown, ...recentClosed].map((action) => action.proposerId)
        .concat([...signers.values()].flat(), seated ? [seated.leaderId, ...seated.members] : [])
      dpnsService.resolveUsernamesBatch(people)
        .then((resolved) => setNames((previous) => new Map([...previous, ...resolved])))
        .catch((error: unknown) => logger.warn('TeamActionsPanel: username lookup failed', error))
    } catch (error) {
      logger.error('TeamActionsPanel: team actions read failed', error)
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (enabled) refresh().catch(() => { /* reported inside */ })
  }, [enabled, refresh])

  if (!enabled) return null

  const nameOf = (id: string) => {
    const name = names.get(id)
    return name ? `@${name}` : shortId(id)
  }
  const reasonLabel = (action: TeamAction) => {
    const charter = action.reasonDocumentId ? seatedReasons.reasons.find((reason) => reason.id === action.reasonDocumentId) : undefined
    const parts = [charter ? `${charter.code} (${charter.label})` : null, action.reason || null].filter(Boolean)
    return parts.length > 0 ? parts.join(' — ') : 'no reason given'
  }
  const seated = state?.seated ?? null
  const me = user?.identityId
  const onTeam = !!me && !!seated && (seated.leaderId === me || seated.members.includes(me))

  const approve = async (action: TeamAction) => {
    if (!me || approving) return
    setApproving(action.actionId)
    const result = await moderationService.approveTeamAction(me, action.actionId)
    setApproving(null)
    if (result.errorCode === 'MAYBE_APPLIED') {
      toast(result.error ?? 'Your approval may have gone through. Check again before retrying.', { duration: 8000 })
    } else if (result.errorCode === 'DOCUMENT_GONE' || result.errorCode === 'TEAM_ACTION_DOCUMENT_CHANGED') {
      toast.error(result.error ?? 'This proposal can no longer run')
      const state: Exclude<TeamActionTargetState, 'live'> = result.errorCode === 'DOCUMENT_GONE' ? 'gone' : 'changed'
      setState((previous) => previous && { ...previous, dead: new Map([...previous.dead, [action.actionId, state]]) })
      return
    } else if (!result.success) {
      toast.error(result.error || 'Approval failed')
    } else {
      toast.success(result.status === 'closed'
        ? `Approved: the team removed the ${action.documentTypeName}. A team removal cannot be undone.`
        : 'Approved')
      // A removal that ran shows in the removal records and the pot counts.
      if (result.status === 'closed') onChanged?.()
    }
    refresh().catch(() => { /* reported inside */ })
  }

  return (
    <Card data-testid="team-actions">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><UserGroupIcon className="h-5 w-5" /> Team removals</CardTitle>
        <CardDescription>
          A week after it was written a post or reply settles: no moderator removes it alone. A member of the seated team
          proposes its removal from the post menu, and it runs once the leader and enough members approve it here. A team
          removal cannot be undone.
          {seated && ` The team is the leader and ${seated.members.length} member${seated.members.length === 1 ? '' : 's'}${seated.seats === null ? '' : `, with ${seated.seats} seat${seated.seats === 1 ? '' : 's'}`}.`}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="flex items-center justify-between gap-2">
          <p className="font-semibold">
            Waiting for approval{state ? ` (${state.activeTotal}${state.activeTruncated ? '+' : ''})` : ''}
          </p>
          <Button variant="outline" size="sm" onClick={() => { refresh().catch(() => { /* reported inside */ }) }} disabled={loading} className="gap-1">
            <ArrowPathIcon className="h-4 w-4" /> {loading ? 'Loading…' : 'Refresh'}
          </Button>
        </div>
        {failed && (
          <div role="alert" className="flex items-center justify-between gap-2 rounded-lg border border-red-300 dark:border-red-800 p-3 text-red-600 dark:text-red-400">
            <span>Could not load the team actions.</span>
            <Button variant="outline" size="sm" onClick={() => { refresh().catch(() => { /* reported inside */ }) }}>Retry</Button>
          </div>
        )}
        {state && seated && state.active.some((action) => action.neededApprovals !== null && !teamCanApprove(action.neededApprovals, seated)) && (
          <p role="alert" data-testid="team-actions-unreachable" className="rounded-lg border border-red-300 dark:border-red-800 p-3 text-red-600 dark:text-red-400">
            The team has fewer people than a team removal needs approvals, so these proposals cannot run. The team must add
            a member before it can remove settled posts.
          </p>
        )}
        {state && state.active.length === 0 && <p className="text-gray-500 dark:text-gray-400">No team removal is waiting for approval.</p>}
        {state && state.active.length > 0 && (
          <ul className="space-y-3">
            {state.active.map((action) => {
              const signed = state.signers.get(action.actionId)
              const counted = signed ? countedSigners(signed, seated) : null
              const have = counted ? counted.length : action.approvalCount
              const leaderSigned = !!seated && !!counted?.includes(seated.leaderId)
              const mine = !!me && (action.proposerId === me || !!signed?.includes(me))
              const deadAs = state.dead.get(action.actionId)
              const dead = deadAs !== undefined
              return (
                <li key={action.actionId} data-testid={`team-action-${action.actionId}`} className={`rounded-lg border border-gray-200 dark:border-gray-800 p-3 space-y-1${dead ? ' opacity-60' : ''}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">
                      Remove {action.documentTypeName}{' '}
                      <Link href={`/post?id=${encodeURIComponent(action.documentId)}`} className="font-mono text-yappr-500 hover:underline">{shortId(action.documentId)}</Link>
                    </span>
                    <span className="font-semibold" data-testid={`team-action-approvals-${action.actionId}`}>
                      {have} of {action.neededApprovals ?? '?'} approvals{counted ? '' : ' (at most)'}
                      {action.leaderRequired && !leaderSigned && ', the leader\'s still needed'}
                    </span>
                  </div>
                  <p className="text-gray-500 dark:text-gray-400">
                    Proposed by {nameOf(action.proposerId)} · {new Date(action.proposedAt).toLocaleString()}
                    {action.leaderRequired && leaderSigned && ' · the leader approved'}
                  </p>
                  <p>Reason: {reasonLabel(action)}</p>
                  {deadAs === 'gone' && (
                    <p data-testid={`team-action-gone-${action.actionId}`} className="italic text-gray-500 dark:text-gray-400">
                      Its {action.documentTypeName} is already gone (another proposal removed it{authorDeletesLeaveHoles() ? ', or its author deleted it' : ''}), so this proposal can never run.
                    </p>
                  )}
                  {deadAs === 'changed' && (
                    <p data-testid={`team-action-changed-${action.actionId}`} className="italic text-gray-500 dark:text-gray-400">
                      Its {action.documentTypeName} changed after this proposal (its author deleted or re-saved it), so this proposal can
                      never run. If its author deleted it, nothing is left to remove; otherwise the change restarted its window, in which
                      one moderator removes it alone, and after that it can be proposed again.
                    </p>
                  )}
                  {signed && (
                    <p className="text-gray-500 dark:text-gray-400">
                      Signed by {signed.length === 0 ? 'nobody' : signed.map((id) => `${nameOf(id)}${seated?.leaderId === id ? ' (leader)' : ''}${counted?.includes(id) ? '' : ' (left the team)'}`).join(', ')}
                    </p>
                  )}
                  {onTeam && !dead && (
                    <div className="pt-1">
                      {mine ? (
                        <span className="inline-flex items-center gap-1 text-green-600 dark:text-green-400"><CheckIcon className="h-4 w-4" /> You approved</span>
                      ) : (
                        <Button size="sm" variant="destructive" disabled={approving !== null || signed === undefined} onClick={() => { approve(action).catch(() => { /* reported inside */ }) }}>
                          {approving === action.actionId ? 'Approving…' : 'Approve removal'}
                        </Button>
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
        {state && state.activeTotal > state.active.length && (
          <p className="text-gray-500 dark:text-gray-400">
            Showing the {state.active.length} newest of {state.activeTotal}{state.activeTruncated ? '+' : ''} proposals.
          </p>
        )}
        {state && state.closed.length > 0 && (
          <section>
            <p className="font-semibold mb-1">{state.closedSample ? 'Carried out (a sample: the team has more than one page)' : 'Recently carried out'}</p>
            <ul className="space-y-1 text-gray-600 dark:text-gray-400">
              {state.closed.map((action) => (
                <li key={action.actionId} data-testid={`team-action-closed-${action.actionId}`}>
                  {action.documentTypeName} <span className="font-mono">{shortId(action.documentId)}</span> removed with {action.approvalCount} approval{action.approvalCount === 1 ? '' : 's'}
                  {' · '}proposed by {nameOf(action.proposerId)} {new Date(action.proposedAt).toLocaleDateString()} · {reasonLabel(action)}
                </li>
              ))}
            </ul>
          </section>
        )}
      </CardContent>
    </Card>
  )
}
