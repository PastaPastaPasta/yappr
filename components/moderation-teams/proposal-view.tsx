'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { ArrowLeftIcon, ArrowTopRightOnSquareIcon, CheckCircleIcon, LockOpenIcon } from '@heroicons/react/24/outline'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { useAuth } from '@/contexts/auth-context'
import { useLoginModal } from '@/hooks/use-login-modal'
import { logger } from '@/lib/logger'
import { moderatedContract, type ModeratedContractKey } from '@/lib/moderated-contracts'
import { moderationElectionService, type CharterProposal, type CharterReason, type ElectionStatus } from '@/lib/services/moderation-election-service'
import { charterService, type JoinRequest } from '@/lib/services/charter-service'
import { CharterActionError, type CharterAction } from '@/lib/moderation-charters/refusals'
import { CHARTERS_CONTRACT_ID, CHARTER_LIMITS, CONTEST_FUND_CREDITS, LEADER_MINIMUM_CREDITS, messageProblem, utf8Bytes } from '@/lib/moderation-charters/rules.mjs'
import { DEPOSIT_TEXT, LEADER_MINIMUM_TEXT, applyCostLines, formatDash, joinCostLines } from '@/lib/moderation-charters/costs'
import { applyBlocker, chainOffsetMs, electionStage, joinBlocker, statusForContract, proposalStanding, type ApplyBlocker, type ElectionStage } from '@/lib/moderation-charters/team-flow'
import { inviteUrl, masternodeVoteUrl, teamsHref } from '@/lib/moderation-charters/links'
import {
  CharterTerms, CostPreview, Hint, IdentityName, InviteLink, Notice, Section, StageBadge,
  formatDuration, formatWhen, formatWindow, useAccountReadiness, useChainNow, useCharterRun, useCreateFees,
} from './shared'
import { TeamAdmin } from './team-admin'

const DEFAULT_MESSAGE = 'I would like to serve on this moderation team.'

function applyBlockerText(blocker: ApplyBlocker, stage: ElectionStage): string {
  switch (blocker) {
    case 'signed-out': return 'Sign in as the leader to apply.'
    case 'not-leader': return 'Only the leader can apply.'
    case 'seated': return 'This contract already has a seated team.'
    case 'not-open': return stage.kind === 'not-open' ? `Applications open on ${formatWhen(stage.opensAtMs)}.` : 'Applications are not open yet.'
    case 'closed': return 'Applications have closed: masternodes are voting.'
    case 'already-applied': return 'You have applied for this contract.'
    case 'too-many-members': return `Pick at most ${CHARTER_LIMITS.members} members.`
    case 'unknown-members': return 'Pick members only from the people who asked to join.'
    case 'low-balance': return `Your balance is below ${LEADER_MINIMUM_TEXT}: the ${formatDash(CONTEST_FUND_CREDITS)} DASH deposit plus fees. Top up first.`
    case 'unknown': return 'The election could not be read. Refresh, then try again.'
    case 'requests-unread': return "The join requests haven't been read yet. Wait a moment, or read them again above."
  }
}

/** What happens after an application, by stage. */
function NextSteps({ stage, status, now }: { stage: ElectionStage; status: ElectionStatus; now: number }) {
  const vote = masternodeVoteUrl(status.targetContractId, CHARTERS_CONTRACT_ID)
  return (
    <div className="space-y-2 text-sm" data-testid="next-steps">
      <h3 className="font-semibold">What happens next</h3>
      <ul className="list-disc ml-5 space-y-1">
        {stage.kind === 'joining' && (
          <>
            <li>Other teams can apply until <strong>{formatWhen(stage.joinClosesAtMs)}</strong> (in {formatDuration(stage.joinClosesAtMs - now)}).</li>
            <li>If no other team applies, yours is seated when that window closes, without a vote.</li>
            <li>If another team applies, masternodes vote until {formatWhen(stage.votingEndsAtMs)}. A tie goes to the team that applied first.</li>
          </>
        )}
        {stage.kind === 'voting' && (
          <li>Masternodes are voting{stage.votingEndsAtMs ? <> until <strong>{formatWhen(stage.votingEndsAtMs)}</strong></> : null}. A tie goes to the team that applied first.</li>
        )}
        {stage.kind === 'deciding' && <li>The contest is over; the winner is seated with the next block.</li>}
        {stage.kind === 'seated' && <li>The contest is over.</li>}
      </ul>
      <p>
        Masternode owners vote on{' '}
        <a href={vote} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-yappr-700 dark:text-yappr-400 hover:underline">
          vote.dashhq.org <ArrowTopRightOnSquareIcon className="h-4 w-4" />
        </a>
        . Share your charter with them.
      </p>
    </div>
  )
}

/**
 * One proposal: its charter, who asked to join, and what the viewer can do
 * with it. A member asks to join (with a message only the leader reads); the
 * leader shares the invite link, reads the requests, picks members and files
 * the application; once seated, the leader changes the team.
 */
export function ProposalView({ contract, proposalId, election }: {
  contract: ModeratedContractKey
  proposalId: string
  election: { status: ElectionStatus | null; refresh: () => Promise<void> }
}) {
  const { user } = useAuth()
  const me = user?.identityId ?? null
  const openLogin = useLoginModal((s) => s.open)
  const { status, refresh } = election
  const now = useChainNow(status)
  const declared = moderatedContract(contract)

  const [proposal, setProposal] = useState<CharterProposal | null | undefined>(undefined)
  const [reasons, setReasons] = useState<CharterReason[] | null>(null)
  const [requests, setRequests] = useState<JoinRequest[] | null>(null)
  const [requestsFailed, setRequestsFailed] = useState(false)
  const [messages, setMessages] = useState<Map<string, string | null> | null>(null)
  const [members, setMembers] = useState<string[]>([])
  const [message, setMessage] = useState(DEFAULT_MESSAGE)
  const [confirmed, setConfirmed] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const { balance, needsKey: needsMemberKey } = useAccountReadiness(me, 'member', done)
  const { busy, error, setError, run } = useCharterRun()
  const fees = useCreateFees({ descriptionBytes: 600, reasons: 3, members: Math.max(members.length, 1) })

  const loadRequests = useCallback(async () => {
    setRequestsFailed(false)
    try {
      setRequests(await charterService.joinRequests(proposalId))
      setRequestsFailed(false)
    } catch (readError) {
      logger.warn('Moderation teams: join requests could not be read', readError)
      // Unknown, never "nobody asked": an application must not go solo on a list it could not read.
      setRequests(null)
      setRequestsFailed(true)
    }
  }, [proposalId])

  useEffect(() => {
    let live = true
    setProposal(undefined)
    charterService.getProposal(proposalId).then((read) => {
      if (!live) return
      setProposal(read)
      if (read) moderationElectionService.getReasons(read.reasonIds).then((list) => { if (live) setReasons(list) }).catch(() => { if (live) setReasons([]) })
    }).catch((readError: unknown) => {
      logger.warn('Moderation teams: proposal could not be read', readError)
      if (live) setProposal(null)
    })
    loadRequests().catch(() => { /* handled inside */ })
    return () => { live = false }
  }, [proposalId, loadRequests])

  const requested = useMemo(() => (requests ? new Set(requests.map((r) => r.ownerId)) : null), [requests])
  // An application sent from this browser whose outcome is still unknown (read again after each try or clear).
  const [pendingApplication, setPendingApplication] = useState(false)
  const [confirmAbandon, setConfirmAbandon] = useState(false)
  const recheckPending = useCallback(() => {
    setPendingApplication(!!me && !!declared.contractId && charterService.hasPendingApplication(me, declared.contractId))
  }, [me, declared.contractId])
  useEffect(recheckPending, [recheckPending])

  if (proposal === undefined) return <Section><p className="text-gray-500">Loading the proposal…</p></Section>
  // Checked against the page's own contract, whether or not the election has been read.
  if (proposal === null || proposal.targetContractId !== declared.contractId) {
    return (
      <Section>
        <Notice tone="error">{proposal === null ? 'This proposal could not be found.' : `This proposal is not for ${declared.label}.`}</Notice>
        <Link href={teamsHref(contract)} className="text-sm hover:underline">Back to {declared.label} moderation</Link>
      </Section>
    )
  }

  const stage = status ? electionStage(status, now) : null
  const standing = status ? proposalStanding(proposal, status) : null
  const isLeader = me === proposal.leaderId
  const myRequest = me ? requests?.find((r) => r.ownerId === me) ?? null : null
  const join = standing ? joinBlocker({ proposal, viewerId: me, alreadyAsked: myRequest !== null, standing }) : null
  const apply = status && stage ? applyBlocker({ stage, proposal, viewerId: me, status, members, requested, balance, minimumBalance: LEADER_MINIMUM_CREDITS }) : 'unknown'
  const seatedHere = status?.seated && status.seated.submittedCharterId === proposal.id ? status.seated : null
  const myApplication = status?.contest?.contenders.find((c) => c.identityId === proposal.leaderId && (!c.submittedCharterId || c.submittedCharterId === proposal.id)) ?? null

  /** Runs a write whose work resolves to the sentence to show once it is done. */
  const runForOutcome = async (label: string, action: CharterAction, work: () => Promise<string | undefined>) => {
    const outcome = await run(label, action, work)
    if (outcome) setDone(outcome)
  }

  const askToJoin = () => runForOutcome('Sending your request…', 'join', async () => {
    if (!me) return
    const problem = messageProblem(message)
    if (problem) throw new CharterActionError(problem, 'refused')
    if (proposal.targetContractId !== declared.contractId) throw new CharterActionError(`This proposal is not for ${declared.label}.`, 'refused')
    await charterService.requestToJoin(me, proposal.id, message.trim() || DEFAULT_MESSAGE)
    await loadRequests()
    return 'Your request is sent. The leader decides who is on the team.'
  })

  const readMessages = () => run('Unlocking messages…', 'join', async () => {
    setMessages(await charterService.readJoinMessages(proposal.id, proposal.leaderId))
  })

  const fileApplication = () => runForOutcome('Filing your application…', 'application', async () => {
    if (!me) return
    // This tab's contract, and the proposal's own target: the deposit can only go to the contest shown.
    const target = declared.contractId
    if (!target || proposal.targetContractId !== target) throw new CharterActionError(`This proposal is not for ${declared.label}.`, 'refused')
    /** Reads the contest and balance again: before the key is asked for, and once more right before a new application is signed. */
    const preflight = async () => {
      const fresh = statusForContract(await moderationElectionService.getStatus(target), target)
      const freshBalance = await charterService.balance(me)
      if (!fresh) throw new CharterActionError('The election could not be read. Refresh, then try again.', 'refused')
      const freshStage = electionStage(fresh, Date.now() + chainOffsetMs(fresh))
      const blocker = applyBlocker({ stage: freshStage, proposal, viewerId: me, status: fresh, members, requested, balance: freshBalance, minimumBalance: LEADER_MINIMUM_CREDITS })
      if (blocker) throw new CharterActionError(applyBlockerText(blocker, freshStage), 'refused')
    }
    await preflight()
    try {
      await charterService.fileApplication(me, proposal, target, members, preflight)
    } finally {
      recheckPending()
    }
    await refresh()
    return 'Your application is filed.'
  })

  const abandonApplication = () => {
    if (!me || !declared.contractId) return
    charterService.abandonApplication(me, declared.contractId)
      .then(() => {
        setError(null)
        recheckPending()
      })
      .catch((abandonError: unknown) => logger.warn('Moderation teams: the application could not be cleared', abandonError))
  }

  const link = typeof window === 'undefined' ? '' : inviteUrl(contract, proposal.id, window.location.origin)
  const messageBytes = utf8Bytes(message)

  return (
    <div data-testid="proposal-view">
      <Section>
        <Link href={teamsHref(contract)} className="inline-flex items-center gap-1 text-sm text-gray-500 hover:underline">
          <ArrowLeftIcon className="h-4 w-4" /> {declared.label} moderation
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-bold">Charter led by <IdentityName id={proposal.leaderId} /></h2>
          {stage && <StageBadge stage={stage} />}
        </div>
        {proposal.createdAt && <p className="text-xs text-gray-500">Proposed {formatWhen(proposal.createdAt)}</p>}
        <CharterTerms proposal={proposal} reasons={reasons} />
      </Section>

      <Section title="Team" testId="proposal-team">
        <p className="text-sm">Leader <IdentityName id={proposal.leaderId} /></p>
        {requests === null ? (requestsFailed ? (
          <div className="flex flex-wrap items-center gap-2" data-testid="join-requests-unread">
            <p className="text-sm text-gray-500">The join requests couldn&apos;t be read.</p>
            <Button size="sm" variant="outline" onClick={() => { loadRequests().catch(() => { /* handled inside */ }) }}>Read them again</Button>
          </div>
        ) : <p className="text-sm text-gray-500">Loading join requests…</p>) : requests.length === 0 ? (
          <p className="text-sm text-gray-500">Nobody has asked to join yet.</p>
        ) : (
          <ul className="space-y-2" data-testid="join-requests">
            {requests.map((request) => {
              const text = messages?.get(request.id)
              const picked = members.includes(request.ownerId)
              const canPick = isLeader && !myApplication && !seatedHere
              return (
                <li key={request.id} className="rounded-lg border border-gray-200 dark:border-gray-800 p-2 text-sm">
                  <label className={canPick ? 'flex items-start gap-2 cursor-pointer' : 'flex items-start gap-2'}>
                    {canPick && (
                      <input type="checkbox" className="mt-1" checked={picked} aria-label="Pick this member"
                        onChange={(e) => setMembers(e.target.checked ? [...members, request.ownerId] : members.filter((id) => id !== request.ownerId))} />
                    )}
                    <span className="flex-1 min-w-0">
                      <IdentityName id={request.ownerId} />
                      {seatedHere?.members.includes(request.ownerId)
                        ? <span className="ml-2 text-xs text-green-700 dark:text-green-400">on the team</span>
                        : myApplication?.members?.includes(request.ownerId) && <span className="ml-2 text-xs text-green-700 dark:text-green-400">in the application</span>}
                      {request.createdAt && <span className="ml-2 text-xs text-gray-500">asked {formatWhen(request.createdAt)}</span>}
                      {messages && (
                        <span className="block mt-1 whitespace-pre-wrap break-words text-gray-700 dark:text-gray-300" data-testid="join-message">
                          {text ?? <em className="text-gray-500">This message couldn&apos;t be read.</em>}
                        </span>
                      )}
                    </span>
                  </label>
                </li>
              )
            })}
          </ul>
        )}
        {isLeader && requests && requests.length > 0 && !messages && (
          <Button variant="outline" size="sm" className="gap-1" onClick={() => readMessages()} disabled={busy !== null}>
            <LockOpenIcon className="h-4 w-4" /> Read their messages
          </Button>
        )}
      </Section>

      {done && <Section><Notice tone="success" testId="action-done"><CheckCircleIcon className="inline h-5 w-5 mr-1" />{done}</Notice></Section>}
      {error && <Section><Notice tone="error" testId="action-error">{error}</Notice></Section>}
      {busy && <Section><Notice testId="action-progress">{busy}</Notice></Section>}

      {!isLeader && (
        <Section title="Join this team" testId="join-panel">
          {!me ? (
            <>
              <p className="text-sm">Sign in to ask to join this team.</p>
              <Button onClick={() => openLogin()}>Sign in</Button>
            </>
          ) : join === 'already-asked' ? (
            <p className="text-sm">You asked to join{myRequest?.createdAt ? ` on ${formatWhen(myRequest.createdAt)}` : ''}. The leader decides who is on the team.</p>
          ) : join === 'not-seated' ? (
            <p className="text-sm text-gray-500">Another team holds the seat, so this team can&apos;t take members.</p>
          ) : (
            <>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                Tell the leader why you&apos;d like to serve. Only the leader can read your message. Members act on the contract&apos;s
                moderation alone, each on the reasons above.
              </p>
              <Textarea aria-label="Message to the leader" value={message} onChange={(e) => setMessage(e.target.value)} rows={3} />
              <Hint bad={messageBytes > CHARTER_LIMITS.messageBytes}>{messageBytes} / {CHARTER_LIMITS.messageBytes} bytes</Hint>
              <CostPreview lines={fees ? joinCostLines(fees, { needsCharterKey: needsMemberKey ?? true }) : null} balance={balance} loading={fees === null} />
              {needsMemberKey !== false && (
                <p className="text-xs text-gray-500">
                  First time? Yappr adds a charter key to your account, which needs your MASTER key once. It stays in this tab and is never stored.
                </p>
              )}
              <Button onClick={() => askToJoin()} disabled={busy !== null || requests === null || messageProblem(message) !== null} data-testid="ask-to-join">Ask to join</Button>
            </>
          )}
        </Section>
      )}

      {isLeader && !seatedHere && (
        <Section title="Invite members" testId="invite-panel">
          <p className="text-sm text-gray-600 dark:text-gray-400">Share this link with the people you want on your team.</p>
          <InviteLink url={link} />
        </Section>
      )}

      {isLeader && status && stage && !seatedHere && (
        <Section title={myApplication ? 'Your application' : 'Apply'} testId="apply-panel">
          {myApplication ? (
            <NextSteps stage={stage} status={status} now={now} />
          ) : (
            <>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                Pick up to {CHARTER_LIMITS.members} members above ({members.length} picked), then apply. Applying puts your charter to the
                masternode vote and pays the contest deposit. You can add up to {status.declaration.maxAddedModerators} more members after you are seated.
              </p>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                After you apply, others have {formatWindow(status.declaration.joinWindowSeconds)} to apply too. With no rival you are seated then;
                otherwise masternodes vote for {formatWindow(status.declaration.voteWindowSeconds)}.
              </p>
              <CostPreview lines={fees ? applyCostLines(fees) : null} balance={balance} loading={fees === null} />
              {pendingApplication && (
                <Notice tone="warn" testId="application-uncertain">
                  <p>
                    An application for {declared.label} you sent from this browser may still go through. Check the election before applying again: refresh,
                    and look for your team under Applications.
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => { refresh().catch(() => { /* reported inside */ }); recheckPending() }}>Check the election</Button>
                    <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => setConfirmAbandon(true)} data-testid="abandon-application">Clear and start over</Button>
                  </div>
                </Notice>
              )}
              <ConfirmDialog
                isOpen={confirmAbandon}
                onClose={() => setConfirmAbandon(false)}
                onConfirm={() => { setConfirmAbandon(false); abandonApplication() }}
                title="Clear and start over?"
                message={`Your earlier application may still go through. If you apply again and it does, you may file a second application and pay a second ${DEPOSIT_TEXT} deposit. Only do this once the election shows no application from you.`}
                confirmText="Clear and start over"
                variant="danger"
              />
              {apply ? (
                <Notice tone={apply === 'not-open' ? 'info' : 'warn'} testId="apply-blocker">
                  {apply === 'already-applied' ? 'You have applied for this contract with another of your proposals.' : applyBlockerText(apply, stage)}
                </Notice>
              ) : (
                <>
                  <label className="flex items-start gap-2 text-sm">
                    <input type="checkbox" className="mt-1" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} data-testid="confirm-deposit" />
                    <span>I understand the {DEPOSIT_TEXT} deposit pays for the masternode vote and is not refunded, whatever the result.</span>
                  </label>
                  <Button onClick={() => fileApplication()} disabled={!confirmed || busy !== null} data-testid="file-application">
                    Apply with {members.length} member{members.length === 1 ? '' : 's'}
                  </Button>
                </>
              )}
            </>
          )}
        </Section>
      )}

      {!isLeader && myApplication && status && stage && (
        <Section title="Application" testId="application-status">
          <NextSteps stage={stage} status={status} now={now} />
        </Section>
      )}

      {seatedHere && (
        <Section title="Seated" testId="seated-here">
          <Notice tone="success">This team moderates {declared.label}.</Notice>
          {isLeader && status && <TeamAdmin seated={seatedHere} requests={requests ?? []} maxAdded={status.declaration.maxAddedModerators} onChanged={() => refresh()} />}
        </Section>
      )}
    </div>
  )
}
