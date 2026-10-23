'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { CheckCircleIcon, TrashIcon } from '@heroicons/react/24/outline'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useAuth } from '@/contexts/auth-context'
import { useLoginModal } from '@/hooks/use-login-modal'
import { logger } from '@/lib/logger'
import { moderatedContract, type ModeratedContractKey } from '@/lib/moderated-contracts'
import { moderationElectionService, type CharterReason, type ElectionStatus } from '@/lib/services/moderation-election-service'
import { charterService } from '@/lib/services/charter-service'
import { CHARTER_LIMITS, DEFAULT_MODERATORS_SHARE, DEFAULT_REWARD_SPLIT, charterTermsProblems, reasonProblem, utf8Bytes, type ReasonDraft, type RewardSplit } from '@/lib/moderation-charters/rules.mjs'
import { DEPOSIT_TEXT, startCostLines } from '@/lib/moderation-charters/costs'
import { chainOffsetMs, electionStage, statusForContract } from '@/lib/moderation-charters/team-flow'
import { CharterActionError } from '@/lib/moderation-charters/refusals'
import { inviteUrl, teamsHref } from '@/lib/moderation-charters/links'
import { CostPreview, FieldError, Hint, InviteLink, Notice, ReasonCode, Section, useAccountReadiness, useChainNow, useCharterRun, useCreateFees } from './shared'

const SPLIT_PARTS: Array<{ key: keyof RewardSplit; label: string; help: string }> = [
  { key: 'leader', label: 'Leader', help: 'paid to the leader' },
  { key: 'equal', label: 'Shared equally', help: 'split equally among the other members' },
  { key: 'actions', label: 'By actions', help: 'split by how many moderation actions each one took' },
]
const EMPTY_DRAFT: ReasonDraft = { code: '', label: '', description: '' }

/**
 * Starting a team: the leader drafts the charter (what the team moderates,
 * the reasons it may act on, the moderators' share and the reward split),
 * sees what filing it costs, and submits it as a proposal. A proposal can be
 * filed before the election opens; members then ask to join it through the
 * invite link this ends with.
 */
export function StartTeamForm({ contract, status }: { contract: ModeratedContractKey; status: ElectionStatus | null }) {
  const { user } = useAuth()
  const me = user?.identityId ?? null
  const openLogin = useLoginModal((s) => s.open)
  const now = useChainNow(status, 30_000)
  const declared = moderatedContract(contract)

  const [description, setDescription] = useState('')
  const [available, setAvailable] = useState<CharterReason[] | null>(null)
  const [ownCodes, setOwnCodes] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<string[]>([])
  const [drafts, setDrafts] = useState<ReasonDraft[]>([])
  const [draft, setDraft] = useState<ReasonDraft>(EMPTY_DRAFT)
  const [draftError, setDraftError] = useState<string | null>(null)
  const [share, setShare] = useState(DEFAULT_MODERATORS_SHARE)
  const [split, setSplit] = useState<RewardSplit>({ ...DEFAULT_REWARD_SPLIT })
  const { balance, needsKey, setNeedsKey } = useAccountReadiness(me, 'leader', status)
  const { busy, error, setBusy, setError, run } = useCharterRun()
  const [touched, setTouched] = useState(false)
  const [filed, setFiled] = useState<string | null>(null)
  // A proposal sent from this browser whose outcome is still unknown (read again after each try or clear).
  const [pendingProposal, setPendingProposal] = useState(false)
  const [confirmAbandon, setConfirmAbandon] = useState(false)
  const recheckPending = useCallback(() => {
    setPendingProposal(!!me && !!declared.contractId && charterService.hasPendingProposal(me, declared.contractId))
  }, [me, declared.contractId])
  useEffect(recheckPending, [recheckPending])

  // Reasons to pick from: the leader's own, and those other proposals for this contract list.
  useEffect(() => {
    if (!me || !status) return
    let live = true
    const cited = [...new Set(status.proposals.flatMap((p) => p.reasonIds))].slice(0, 64)
    Promise.all([charterService.ownReasons(me), moderationElectionService.getReasons(cited)])
      .then(([own, others]) => {
        if (!live) return
        const byId = new Map([...own, ...others].map((reason) => [reason.id, reason]))
        setAvailable([...byId.values()])
        setOwnCodes(new Set(own.map((reason) => reason.code)))
      })
      .catch((readError: unknown) => {
        logger.warn('Moderation teams: reasons could not be read', readError)
        if (live) setAvailable([])
      })
    return () => { live = false }
  }, [me, status])

  const reasonCount = selected.length + drafts.length
  const descriptionBytes = utf8Bytes(description)
  const fees = useCreateFees({ descriptionBytes: Math.max(descriptionBytes, 200), reasons: Math.max(reasonCount, 1), members: 3 }, 400)

  const problems = useMemo(() => charterTermsProblems({
    description,
    reasons: [...selected, ...drafts.map((d) => `new:${d.code}`)],
    moderatorsShare: share,
    rewardSplit: split,
  }), [description, selected, drafts, share, split])
  const problemFor = (field: string) => (touched ? problems.find((p) => p.field === field)?.message : undefined)
  const lines = fees ? startCostLines(fees, { newReasons: drafts.length, needsCharterKey: needsKey ?? true }) : null

  if (!me) {
    return (
      <Section>
        <p className="text-sm">Sign in to start a moderation team.</p>
        <Button onClick={() => openLogin()}>Sign in</Button>
      </Section>
    )
  }
  if (filed) {
    const link = inviteUrl(contract, filed, window.location.origin)
    return (
      <Section testId="proposal-filed">
        <Notice tone="success"><CheckCircleIcon className="inline h-5 w-5 mr-1" /> Your proposal is filed. Charters can&apos;t be changed once filed.</Notice>
        <div className="space-y-2 text-sm">
          <h3 className="font-semibold">Invite your members</h3>
          <p>Share this link. Each member opens it, writes you a short message and asks to join. Only you can read their messages.</p>
          <InviteLink url={link} />
          <p className="text-gray-500">When they have asked, open your proposal, pick up to {CHARTER_LIMITS.members} members and apply.</p>
          <Button asChild><Link href={teamsHref(contract, { proposal: filed })}>Open your proposal</Link></Button>
        </div>
      </Section>
    )
  }
  if (status) {
    const stage = electionStage(status, now)
    if (stage.kind === 'seated' || stage.kind === 'deciding') {
      return <Section><Notice>{declared.label} already has a seated team, so new teams can&apos;t stand yet.</Notice></Section>
    }
  }

  const addDraft = () => {
    const code = draft.code.trim().toUpperCase()
    const candidate = { code, label: draft.label.trim(), ...(draft.description?.trim() ? { description: draft.description.trim() } : {}) }
    const problem = reasonProblem(candidate)
    if (problem) return setDraftError(problem.message)
    if (ownCodes.has(code) || drafts.some((d) => d.code === code)) return setDraftError(`You already have a reason ${code}. Pick it from the list, or use another code.`)
    setDrafts([...drafts, candidate])
    setDraft(EMPTY_DRAFT)
    setDraftError(null)
  }

  const submit = async () => {
    setTouched(true)
    // The proposal is for this tab's contract, and only on that contract's own election read.
    if (problems.length > 0 || !status || status.targetContractId !== declared.contractId) return
    // One session for the whole submission: leaving the page stops every write not yet signed.
    const session = charterService.session()
    const proposalId = await run(null, 'proposal', async () => {
      // Members' join messages are encrypted to the leader's charter key, so it comes first.
      if (needsKey ?? !(await charterService.hasCharterKey(me, 'leader'))) {
        setBusy('Setting up your charter key…')
        await charterService.charterKey(me, 'leader', { create: true, session }).then((key) => key.fill(0))
        setNeedsKey(false)
      }
      let pendingDrafts = drafts
      const reasonIds = [...selected]
      for (const reason of drafts) {
        setBusy(`Filing reason ${reason.code}…`)
        const id = await charterService.fileReason(me, reason, { session })
        reasonIds.push(id)
        // A filed reason is kept as picked, so a retry never files it twice.
        pendingDrafts = pendingDrafts.filter((d) => d.code !== reason.code)
        setDrafts(pendingDrafts)
        setOwnCodes((codes) => new Set([...codes, reason.code]))
        setAvailable((list) => [...(list ?? []), { id, ...reason }])
        setSelected((ids) => [...ids, id])
      }
      setBusy('Filing your proposal…')
      const target = declared.contractId
      // Read again right before a new proposal is signed: a team may have been seated while this was filled in.
      const stillOpen = async () => {
        const fresh = statusForContract(await moderationElectionService.getStatus(target), target)
        if (!fresh || fresh.failures.includes('seatedTeam')) throw new CharterActionError("The election couldn't be read. Refresh, then try again.", 'refused')
        const freshStage = electionStage(fresh, Date.now() + chainOffsetMs(fresh))
        if (freshStage.kind === 'seated' || freshStage.kind === 'deciding') {
          throw new CharterActionError(`${declared.label} already has a seated team, so new teams can't stand yet.`, 'refused')
        }
      }
      return charterService.submitProposal(me, {
        targetContractId: target,
        description,
        reasonIds,
        moderatorsShare: share,
        rewardSplit: split,
      }, { stillOpen, session })
    })
    if (proposalId) setFiled(proposalId)
    recheckPending()
  }

  const abandonProposal = () => {
    charterService.abandonProposal(me, declared.contractId)
      .then(() => {
        setError(null)
        recheckPending()
      })
      .catch((abandonError: unknown) => logger.warn('Moderation teams: the proposal could not be cleared', abandonError))
  }

  const splitTotal = split.leader + split.equal + split.actions

  return (
    <form data-testid="start-team-form" onSubmit={(event) => { event.preventDefault(); submit().catch(() => setBusy(null)) }}>
      <Section title={`Start a team for ${declared.label}`}>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Your charter is what masternodes vote on and what members sign up to. It can&apos;t be changed once filed.
        </p>
      </Section>

      <Section title="What the team will moderate">
        <Textarea
          aria-label="Charter description"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="Who you are, what you will hide or restrict and how you will decide, how quickly you will act on reports…"
          rows={6}
        />
        <Hint bad={descriptionBytes > CHARTER_LIMITS.descriptionBytes}>{descriptionBytes} / {CHARTER_LIMITS.descriptionBytes} bytes</Hint>
        <FieldError message={problemFor('description')} />
      </Section>

      <Section title="Reasons the team may act on">
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Every moderation action names one of these reasons, and the team can act on nothing else. Pick existing reasons or add your own.
        </p>
        {available === null ? <p className="text-sm text-gray-500">Loading reasons…</p> : available.length > 0 && (
          <ul className="space-y-1" data-testid="reason-picker">
            {available.map((reason) => (
              <li key={reason.id}>
                <label className="flex items-start gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={selected.includes(reason.id)}
                    onChange={(event) => setSelected(event.target.checked ? [...selected, reason.id] : selected.filter((id) => id !== reason.id))}
                  />
                  <span>
                    <ReasonCode code={reason.code} />
                    {reason.label}
                    {reason.description && <span className="block text-gray-500">{reason.description}</span>}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
        {drafts.length > 0 && (
          <ul className="space-y-1">
            {drafts.map((d) => (
              <li key={d.code} className="flex items-center gap-2 text-sm">
                <span className="font-mono text-xs rounded bg-yappr-100 dark:bg-yappr-900 px-1.5 py-0.5">{d.code}</span>
                <span className="flex-1">{d.label} <span className="text-xs text-gray-500">(new)</span></span>
                <Button type="button" variant="ghost" size="icon" aria-label={`Remove ${d.code}`} onClick={() => setDrafts(drafts.filter((x) => x.code !== d.code))}>
                  <TrashIcon className="h-4 w-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
        <fieldset className="rounded-lg border border-gray-200 dark:border-gray-800 p-3 space-y-2">
          <legend className="px-1 text-sm font-medium">Add a reason</legend>
          <div className="flex gap-2">
            <Input aria-label="Reason code" placeholder="SPM" maxLength={3} className="w-20 font-mono uppercase"
              value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value.toUpperCase() })} />
            <Input aria-label="Reason name" placeholder="Spam" maxLength={CHARTER_LIMITS.reasonLabelChars}
              value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
          </div>
          <Textarea aria-label="Reason description (optional)" placeholder="What it covers and how the team applies it (optional)" rows={2}
            value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
          <FieldError message={draftError ?? undefined} />
          <Button type="button" variant="outline" size="sm" onClick={addDraft}>Add reason</Button>
        </fieldset>
        <FieldError message={problemFor('reasons')} />
      </Section>

      <Section title="Moderators' share">
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Each moderated post, profile or listing pays a moderators fee into the team&apos;s pot. Your share is how much of it the team takes:
          100% is the full fee, less is a discount for everyone who posts, and 0% is a team that won&apos;t moderate and takes no rewards.
        </p>
        <div className="flex items-center gap-3">
          <input type="range" min={0} max={100} value={share} onChange={(e) => setShare(Number(e.target.value))} aria-label="Moderators' share" className="flex-1" />
          <Input type="number" min={0} max={100} value={share} onChange={(e) => setShare(Math.round(Number(e.target.value)))} className="w-20" aria-label="Moderators' share, percent" />
          <span className="text-sm">%</span>
        </div>
        {share === 0 && <Notice tone="warn">At 0% this team will not moderate and takes no rewards.</Notice>}
        <FieldError message={problemFor('moderatorsShare')} />
      </Section>

      <Section title="Reward split">
        <p className="text-sm text-gray-600 dark:text-gray-400">How the pot is paid out to the team. The three parts add up to 100.</p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {SPLIT_PARTS.map((part) => (
            <label key={part.key} className="text-sm space-y-1">
              <span className="font-medium">{part.label}</span>
              <Input type="number" min={0} max={100} value={split[part.key]}
                onChange={(e) => setSplit({ ...split, [part.key]: Math.round(Number(e.target.value)) })} aria-label={`${part.label}, percent`} />
              <span className="block text-xs text-gray-500">{part.help}</span>
            </label>
          ))}
        </div>
        <Hint bad={splitTotal !== 100}>Adds up to {splitTotal}</Hint>
        <FieldError message={problemFor('rewardSplit')} />
      </Section>

      <Section title="Cost">
        <CostPreview lines={lines} balance={balance ?? null} loading={fees === null} />
        <p className="text-xs text-gray-500">
          Applying later pays a {DEPOSIT_TEXT} contest deposit for the masternode vote. It is not refunded.
        </p>
      </Section>

      <Section>
        {error && <Notice tone="error" testId="start-team-error">{error}</Notice>}
        {pendingProposal && (
          <Notice tone="warn" testId="proposal-uncertain">
            <p>A proposal you sent from this browser may still go through. Check the {declared.label} teams list before submitting again.</p>
            <div className="mt-2">
              <Button type="button" size="sm" variant="outline" disabled={busy !== null} onClick={() => setConfirmAbandon(true)} data-testid="abandon-proposal">
                Clear and start over
              </Button>
            </div>
          </Notice>
        )}
        <ConfirmDialog
          isOpen={confirmAbandon}
          onClose={() => setConfirmAbandon(false)}
          onConfirm={() => { setConfirmAbandon(false); abandonProposal() }}
          title="Clear and start over?"
          message="Your earlier proposal may still go through. If you submit again and it does, you will have filed a second proposal. Proposals are permanent and can't be removed. Only do this once the teams list shows no proposal from you."
          confirmText="Clear and start over"
          variant="danger"
        />
        {busy && <Notice testId="start-team-progress">{busy}</Notice>}
        <Button type="submit" disabled={busy !== null} data-testid="submit-proposal">
          {busy ? 'Working…' : 'Submit proposal'}
        </Button>
      </Section>
    </form>
  )
}
