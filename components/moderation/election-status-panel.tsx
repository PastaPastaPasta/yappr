'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowPathIcon, ScaleIcon } from '@heroicons/react/24/outline'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { useSdk } from '@/contexts/sdk-context'
import { logger } from '@/lib/logger'
import { electedModeration, isV10 } from '@/lib/contract-topology'
import { createElectionStatusLoader } from '@/lib/election-status-loader'
import { electionView, moderationElectionService, type ElectionStatus } from '@/lib/services/moderation-election-service'

const short = (id: string) => (id.length > 14 ? `${id.slice(0, 6)}…${id.slice(-6)}` : id)
const when = (ms: number | null) => (ms === null ? 'unknown' : new Date(ms).toLocaleString())
const hours = (seconds: number) => `${Math.round(seconds / 3600)} h`
/** Who moderates before a team is seated, as the panel says it. */
function interimText(interim: string): string {
  switch (interim) {
    case 'contractOwner':
      return 'the contract owner moderates'
    case 'notYetUsable':
      return 'nobody moderates, and posts, replies, reports and profile changes stay closed'
    default:
      return `the interim (${interim}) applies`
  }
}

/** A window as people say it: days from a day up (mainnet's floor), hours below. */
const duration = (seconds: number) => (seconds >= 86_400 ? `${Math.round(seconds / 86_400)} days` : hours(seconds))

/**
 * The election of the contract's moderation team (v9, elected moderation):
 * the declaration, every filed proposal, the contest for the seat with its
 * vote tallies and end time, and — once a charter is seated — the team, its
 * leader and members and the reasons it may cite. Read-only and public:
 * anyone can watch the election. Renders nothing off an elected contract.
 */
export function ElectionStatusPanel() {
  // A stable, frozen object (electedModeration memoises it); the effect below
  // keys on the boolean anyway, so it runs once per mount, never per render.
  const declaration = electedModeration()
  const elected = declaration !== null
  // A panel mounts (and its effect runs) before SdkProvider has called
  // initialize(), so a read on mount fails with "SDK not configured".
  const { isReady: sdkReady, error: sdkError } = useSdk()
  // One loader per mounted panel: concurrent loads share a single read.
  const loader = useMemo(() => createElectionStatusLoader(() => moderationElectionService.getStatus()), [])
  const [status, setStatus] = useState<ElectionStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    setFailed(false)
    try {
      setStatus(await loader.load())
    } catch (error) {
      logger.error('ElectionStatusPanel: status read failed', error)
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }, [loader])

  useEffect(() => {
    if (elected && sdkReady) refresh().catch(() => { /* reported inside */ })
  }, [elected, sdkReady, refresh])

  if (!declaration) return null

  const contest = status?.contest ?? null
  const seated = status?.seated ?? null
  // Never claims "none" for a part that failed to read: an unknown phase says so.
  // An SDK that never came up reads as a failure (with Retry), not "Loading" forever.
  const { phase, error, emptyStateKnown } = electionView(status, failed || (!status && !sdkReady && sdkError !== null))

  return (
    <Card data-testid="election-status">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><ScaleIcon className="h-5 w-5" /> Moderation election</CardTitle>
        <CardDescription>
          Masternodes elect this contract&apos;s moderation team. Until a team is seated,{' '}
          {interimText(declaration.interim)}.
          Applicants join for {duration(declaration.joinWindowSeconds)}, then masternodes vote for {duration(declaration.voteWindowSeconds)};{' '}
          {declaration.seatContestable
            ? `the seat becomes contestable once challenges ship${declaration.challengeCoolDownSeconds ? `, with ${duration(declaration.challengeCoolDownSeconds)} of protection after each seat change` : ''}`
            : 'the first seated team keeps the seat'};
          the leader may add up to {declaration.maxAddedModerators} members.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="flex items-center justify-between gap-2">
          <p>
            Status: <span data-testid="election-phase" className="font-semibold">{phase}</span>
            {status && <span className="text-gray-500"> · target contract <code>{short(status.targetContractId)}</code></span>}
          </p>
          <Button variant="outline" size="sm" onClick={() => refresh()} disabled={loading} className="gap-1">
            <ArrowPathIcon className="h-4 w-4" /> {loading ? 'Loading…' : 'Refresh'}
          </Button>
        </div>
        {error && (
          <div role="alert" data-testid="election-read-error" className="flex items-center justify-between gap-2 rounded border border-red-300 dark:border-red-800 p-2 text-red-600 dark:text-red-400">
            <span>{error}</span>
            <Button variant="outline" size="sm" onClick={() => refresh()} disabled={loading}>Retry</Button>
          </div>
        )}

        {seated && (
          <section data-testid="election-seated-team">
            <h4 className="font-semibold mb-1">Seated team</h4>
            <p>Leader: <code>{seated.leaderId}</code></p>
            <p>Members ({seated.members.length}):</p>
            <ul className="list-disc ml-5">
              {seated.members.length === 0 ? <li>none besides the leader</li> : seated.members.map((id) => <li key={id}><code>{id}</code></li>)}
            </ul>
            <p className="mt-1">Charter <code>{short(seated.electedCharterId)}</code>, proposal <code>{short(seated.submittedCharterId)}</code></p>
            {status && status.seatedReasons.length > 0 && (
              <p className="mt-1">Reasons the team may cite: {status.seatedReasons.map((reason) => `${reason.code} (${reason.label})`).join(', ')}</p>
            )}
          </section>
        )}

        {contest && (
          <section data-testid="election-contest">
            <h4 className="font-semibold mb-1">Contest for the seat</h4>
            <p>
              Voting ends: <span data-testid="election-ends">{when(contest.endsAtMs)}</span>
              {contest.endsAtMs === null && !contest.winner && isV10() && (
                <span className="text-gray-500">
                  {' '}(at most {hours(declaration.joinWindowSeconds + declaration.voteWindowSeconds)} after the first charter entered)
                </span>
              )}
            </p>
            {contest.winner && (
              <p>Outcome: {contest.winner.kind}{contest.winner.identityId ? ` — ${contest.winner.identityId}` : ''} ({when(contest.winner.decidedAtMs)})</p>
            )}
            <table className="w-full mt-2">
              <thead><tr className="text-left text-gray-500"><th>Contender (leader)</th><th className="text-right">Votes</th></tr></thead>
              <tbody>
                {contest.contenders.map((contender) => (
                  <tr key={contender.identityId}><td><code>{contender.identityId}</code></td><td className="text-right">{contender.votes ?? '—'}</td></tr>
                ))}
                <tr className="text-gray-500"><td>Abstain</td><td className="text-right">{contest.abstainVotes ?? '—'}</td></tr>
                <tr className="text-gray-500"><td>Lock</td><td className="text-right">{contest.lockVotes ?? '—'}</td></tr>
              </tbody>
            </table>
          </section>
        )}

        {status && status.proposals.length > 0 && (
          <section data-testid="election-proposals">
            <h4 className="font-semibold mb-1">Proposals ({status.proposals.length})</h4>
            <ul className="space-y-2">
              {status.proposals.map((proposal) => (
                <li key={proposal.id} className="border border-gray-200 dark:border-gray-800 rounded p-2">
                  <p>Leader <code>{proposal.leaderId}</code>{proposal.createdAt ? ` · filed ${when(proposal.createdAt)}` : ''}</p>
                  {proposal.description && <p className="text-gray-600 dark:text-gray-400 whitespace-pre-wrap">{proposal.description}</p>}
                  <p className="text-gray-500">
                    {proposal.reasonIds.length} reason{proposal.reasonIds.length === 1 ? '' : 's'}
                    {proposal.moderatorsShare !== null && ` · charges ${proposal.moderatorsShare}% of the moderators fee`}
                    {proposal.rewardSplit && ` · split leader ${proposal.rewardSplit.leader}% / equal ${proposal.rewardSplit.equal}% / actions ${proposal.rewardSplit.actions}%`}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        )}
        {status && emptyStateKnown && !contest && !seated && (
          <p data-testid="election-no-contest" className="text-gray-500">
            {status.proposals.length === 0 ? 'No team has applied yet. ' : 'No charter has entered the contest yet. '}
            The contest opens when a leader files an elected charter; the network admits contested documents
            only from a later epoch, so an election may not be possible yet.
          </p>
        )}
      </CardContent>
    </Card>
  )
}
