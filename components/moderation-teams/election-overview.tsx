'use client'

import Link from 'next/link'
import { ArrowPathIcon, ArrowTopRightOnSquareIcon, PlusIcon } from '@heroicons/react/24/outline'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/contexts/auth-context'
import { useLoginModal } from '@/hooks/use-login-modal'
import { moderatedContract, type ModeratedContractKey } from '@/lib/moderated-contracts'
import { electionView, type ElectionStatus } from '@/lib/services/moderation-election-service'
import { electionStage, proposalStanding, type ElectionStage } from '@/lib/moderation-charters/team-flow'
import { DEPOSIT_TEXT } from '@/lib/moderation-charters/costs'
import { masternodeVoteUrl, teamsHref } from '@/lib/moderation-charters/links'
import { CHARTERS_CONTRACT_ID } from '@/lib/moderation-charters/rules.mjs'
import { CharterTerms, IdentityName, Notice, Section, StageBadge, formatDuration, formatWhen, formatWindow, useChainNow } from './shared'

const STANDING_LABEL = { gathering: 'Gathering members', contending: 'Applied', seated: 'Seated', 'not-seated': 'Not seated' } as const

/** What the stage means for someone who wants to stand, in a sentence or two. */
function StageExplainer({ stage, status, now }: { stage: ElectionStage; status: ElectionStatus; now: number }) {
  const { joinWindowSeconds, voteWindowSeconds } = status.declaration
  switch (stage.kind) {
    case 'not-open':
      return (
        <p>
          Applications open on <strong>{formatWhen(stage.opensAtMs)}</strong> (in {formatDuration(stage.opensAtMs - now)}).
          Until then, leaders can propose teams and members can ask to join them.
        </p>
      )
    case 'open':
      return (
        <p>
          No team has applied yet. The first application opens a {formatWindow(joinWindowSeconds)} window for others to apply.
          If nobody else does, that team is seated when the window closes; otherwise masternodes vote for {formatWindow(voteWindowSeconds)}.
        </p>
      )
    case 'joining':
      return (
        <p>
          Applications close on <strong>{formatWhen(stage.joinClosesAtMs)}</strong> (in {formatDuration(stage.joinClosesAtMs - now)}).{' '}
          {stage.contenders === 1
            ? 'If no other team applies by then, the applicant is seated without a vote.'
            : `Then masternodes vote until ${formatWhen(stage.votingEndsAtMs)}.`}
        </p>
      )
    case 'voting':
      return (
        <p>
          Masternodes are voting between {stage.contenders} teams
          {stage.votingEndsAtMs ? <> until <strong>{formatWhen(stage.votingEndsAtMs)}</strong> (in {formatDuration(stage.votingEndsAtMs - now)})</> : null}.
          A tie goes to the team that applied first.
        </p>
      )
    case 'deciding':
      return <p>The contest is over. The winning team is seated with the next block.</p>
    case 'seated':
      return <p>This contract has its moderation team. The seat stays with it: challenges are not possible yet.</p>
    case 'unknown':
      return <p>Part of the election could not be read, so its stage isn&apos;t shown. Refresh to try again.</p>
  }
}

/**
 * A contract's election, as someone thinking of standing sees it: where it
 * stands and what comes next, the seated team with its charter, the
 * applications in the contest, and every proposal filed so far.
 */
export function ElectionOverview({ contract, election }: {
  contract: ModeratedContractKey
  election: { status: ElectionStatus | null; failed: boolean; loading: boolean; refresh: () => Promise<void> }
}) {
  const { user } = useAuth()
  const openLogin = useLoginModal((s) => s.open)
  const { status, failed, loading, refresh } = election
  const now = useChainNow(status)
  const declared = moderatedContract(contract)
  const seatedProposal = status?.seated ? status.proposals.find((p) => p.id === status.seated?.submittedCharterId) ?? null : null
  const { error } = electionView(status, failed)
  if (!status) {
    return (
      <Section>
        {error ? (
          <Notice tone="error" testId="election-read-error">
            {error} <Button variant="outline" size="sm" className="ml-2" onClick={() => refresh()} disabled={loading}>Retry</Button>
          </Notice>
        ) : <p className="text-gray-500">Loading the election…</p>}
      </Section>
    )
  }
  const stage = electionStage(status, now)
  const contest = status.contest

  return (
    <div data-testid="election-overview">
      <Section>
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1 min-w-0">
            <h2 className="text-lg font-bold">Who moderates {declared.label}</h2>
            <StageBadge stage={stage} />
          </div>
          <Button variant="outline" size="sm" onClick={() => refresh()} disabled={loading} className="shrink-0 gap-1">
            <ArrowPathIcon className="h-4 w-4" /> {loading ? 'Loading…' : 'Refresh'}
          </Button>
        </div>
        <div className="text-sm text-gray-700 dark:text-gray-300 space-y-2">
          <StageExplainer stage={stage} status={status} now={now} />
          <p className="text-gray-500">
            Masternodes elect each contract&apos;s team. A leader proposes a charter (what the team moderates, the reasons it may act on and how rewards are paid),
            gathers members, then applies with a {DEPOSIT_TEXT} contest deposit.
          </p>
        </div>
        {error && <Notice tone="warn">{error}</Notice>}
        {stage.kind !== 'seated' && stage.kind !== 'deciding' && (
          <div className="flex flex-wrap gap-2">
            {user ? (
              <Button asChild className="gap-1"><Link href={teamsHref(contract, { start: true })}><PlusIcon className="h-4 w-4" /> Start a team</Link></Button>
            ) : (
              <Button onClick={() => openLogin()} className="gap-1"><PlusIcon className="h-4 w-4" /> Sign in to start a team</Button>
            )}
          </div>
        )}
      </Section>

      {status.seated && (
        <Section title="Seated team" testId="seated-team">
          <p className="text-sm">Leader <IdentityName id={status.seated.leaderId} /></p>
          <p className="text-sm">
            Members:{' '}
            {status.seated.members.length === 0 ? 'none besides the leader' : status.seated.members.map((id, i) => (
              <span key={id}>{i > 0 && ', '}<IdentityName id={id} /></span>
            ))}
          </p>
          {seatedProposal && <CharterTerms proposal={seatedProposal} reasons={status.failures.includes('seatedReasons') ? [] : status.seatedReasons} />}
          <Link className="text-sm text-yappr-700 dark:text-yappr-400 hover:underline" href={teamsHref(contract, { proposal: status.seated.submittedCharterId })}>
            Open the charter
          </Link>
        </Section>
      )}

      {contest && contest.contenders.length > 0 && !status.seated && (
        <Section title="Applications" testId="election-contest">
          <ul className="space-y-2 text-sm">
            {contest.contenders.map((contender) => (
              <li key={contender.identityId} className="flex items-center justify-between gap-2">
                <span>
                  <IdentityName id={contender.identityId} />
                  {contender.submittedCharterId && (
                    <> · <Link className="text-yappr-700 dark:text-yappr-400 hover:underline" href={teamsHref(contract, { proposal: contender.submittedCharterId })}>charter</Link></>
                  )}
                  {contender.members && <span className="text-gray-500"> · {contender.members.length + 1} on the team</span>}
                </span>
                <span className="text-gray-500 whitespace-nowrap">{contender.votes ?? 0} votes</span>
              </li>
            ))}
          </ul>
          {(stage.kind === 'voting' || (stage.kind === 'joining' && stage.contenders > 1)) && (
            <a className="inline-flex items-center gap-1 text-sm text-yappr-700 dark:text-yappr-400 hover:underline"
              href={masternodeVoteUrl(status.targetContractId, CHARTERS_CONTRACT_ID)} target="_blank" rel="noopener noreferrer">
              Masternode owners vote on EvoVote <ArrowTopRightOnSquareIcon className="h-4 w-4" />
            </a>
          )}
        </Section>
      )}

      <Section title={`Proposals (${status.proposals.length})`} testId="election-proposals">
        {status.proposals.length === 0 ? (
          <p className="text-sm text-gray-500">{status.failures.includes('proposals') ? 'The proposals could not be read.' : 'No team has been proposed yet.'}</p>
        ) : (
          <ul className="space-y-3">
            {[...status.proposals].reverse().map((proposal) => {
              const standing = proposalStanding(proposal, status)
              return (
                <li key={proposal.id}>
                  <Link href={teamsHref(contract, { proposal: proposal.id })}
                    className="block rounded-lg border border-gray-200 dark:border-gray-800 p-3 hover:bg-gray-50 dark:hover:bg-gray-950">
                    <div className="flex items-center justify-between gap-2 text-sm">
                      <span>Led by <IdentityName id={proposal.leaderId} /></span>
                      <span className="text-xs text-gray-500">{STANDING_LABEL[standing]}</span>
                    </div>
                    <p className="mt-1 line-clamp-2 text-sm text-gray-700 dark:text-gray-300 break-words">{proposal.description}</p>
                    <p className="mt-1 text-xs text-gray-500">
                      {proposal.reasonIds.length} reason{proposal.reasonIds.length === 1 ? '' : 's'}
                      {proposal.moderatorsShare !== null && ` · ${proposal.moderatorsShare}% share`}
                      {proposal.createdAt ? ` · proposed ${formatWhen(proposal.createdAt)}` : ''}
                    </p>
                  </Link>
                </li>
              )
            })}
          </ul>
        )}
      </Section>
    </div>
  )
}
