'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { logger } from '@/lib/logger'
import toast from 'react-hot-toast'
import { ChartBarIcon } from '@heroicons/react/24/outline'
import { useAuth } from '@/contexts/auth-context'
import { useRequireAuth } from '@/hooks/use-require-auth'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { cn, formatNumber } from '@/lib/utils'
import { categorizeError } from '@/lib/error-utils'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { pollMissingMeansDeleted, pollrPollUrl } from '@/lib/poll-embed'
import { pollrIsV4, pollrHasV5Ballots, pollrPollsDeletable } from '@/lib/constants'
import { isReferenceNotFoundError } from '@/lib/error-utils'
import { choiceDelta, editorStart, normalizeChoices, sameChoices } from '@/lib/pollr-rules'
import type { Poll, PollTally } from '@/lib/services'
import type { BallotState } from '@/lib/services/pollr-vote-service'
import { pollIsClosed, tallyIsFinal } from '@/lib/services/pollr-vote-service'

interface PollCardProps {
  pollId: string
  /**
   * Text of the post this poll is embedded in. When it already says the poll
   * question (native poll posts use the post body as the question) the card
   * skips its own heading instead of printing the question twice.
   */
  postContent?: string
  /** Author of the embedding post, so a poll made by someone else can say so. */
  postAuthorId?: string
  /**
   * The post names this poll in its embed fields (not a legacy Pollr link), so
   * a poll that no longer exists was deleted (see pollMissingMeansDeleted).
   */
  nativeEmbed?: boolean
  className?: string
}

/** How long to wait before re-reading a poll Platform says is absent (v6, see the load). */
const ABSENT_RECHECK_MS = 2500

function percent(count: number, total: number): number {
  if (total <= 0) return 0
  return Math.round((count / total) * 100)
}

// The composer appends attachment URLs to the post body, so the text that
// reaches us is the question plus trailing links. Drop those before comparing.
const TRAILING_URLS_PATTERN = /(?:\s+(?:https?|ipfs):\/\/\S+)+\s*$/

function postTextWithoutTrailingUrls(content: string): string {
  return content.replace(TRAILING_URLS_PATTERN, '').trim()
}

/** Stop clicks inside the poll from triggering the surrounding post-card navigation. */
function stopPropagation(event: React.MouseEvent | React.KeyboardEvent) {
  event.stopPropagation()
}

export function PollCard({ pollId, postContent, postAuthorId, nativeEmbed = false, className }: PollCardProps) {
  const { user } = useAuth()
  const { openLoginPrompt } = useRequireAuth()

  const [poll, setPoll] = useState<Poll | null>(null)
  const [tally, setTally] = useState<PollTally | null>(null)
  const [myVotes, setMyVotes] = useState<number[]>([])
  const [selected, setSelected] = useState<number[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  // Set when the user's own votes couldn't be read. Distinct from "no votes":
  // an empty list reopens the ballot, which on a single-choice poll walks the
  // voter into a write Platform rejects outright.
  const [votesUnavailable, setVotesUnavailable] = useState(false)
  // Bumped to re-run the load effect without a page refresh.
  const [reloadToken, setReloadToken] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  // Reopens the ballot after voting: on v5 to change or withdraw the vote, on
  // v3 (immutable ballots) for a multi-choice voter to add more selections.
  const [editing, setEditing] = useState(false)
  // Platform refused a write because the poll has closed, though this device's
  // clock says it is still open: trust the chain, or every retry is refused.
  const [closedOnChain, setClosedOnChain] = useState(false)
  // v5: an earlier write to the voter's ballots on this poll could still land
  // (pollrVoteService.getBallotState). The ballots are then shown read-only
  // until a check finds nothing pending; every later submission is a fresh
  // plan against the chain.
  const [ballotPending, setBallotPending] = useState(false)
  // v5: what the voter last asked for when a submission was not fully
  // confirmed. Only pre-fills the editor once the ballots settle (part of it
  // may never have been sent); it is never resent on its own.
  const [requested, setRequested] = useState<number[] | null>(null)
  // v6: the poll no longer exists because its owner deleted it.
  const [deleted, setDeleted] = useState(false)
  // v6: the signed-in owner may still delete the poll (no ballot names it yet).
  const [deletable, setDeletable] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  // Bumped by every eligibility check and every vote, so only the latest check
  // may offer the delete: a count read before a vote cannot bring it back.
  const deleteCheckRef = useRef(0)

  const userId = user?.identityId ?? null
  // v5 ballots stay editable until the poll closes; v3 ballots are permanent.
  const editable = pollrHasV5Ballots()
  // v4 (indexOnly ballots) is shown but not voted on.
  const votingSupported = !pollrIsV4()

  /**
   * v6: whether the signed-in owner may delete `target` now, recomputed from
   * scratch (pollrVoteService.deleteEligible). Only the latest check applies,
   * so a count read before a vote cannot bring the delete back.
   */
  const checkDeletable = useCallback(async (target: Poll, ownState?: PromiseSettledResult<BallotState>) => {
    const epoch = ++deleteCheckRef.current
    setDeletable(false)
    if (!pollrPollsDeletable() || !userId) return
    const { pollrVoteService } = await import('@/lib/services')
    const eligible = await pollrVoteService.deleteEligible(target, userId, ownState)
    if (deleteCheckRef.current === epoch) setDeletable(eligible)
  }, [userId])

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      setLoading(true)
      setLoadError(false)
      setVotesUnavailable(false)
      // Both are identity-scoped or poll-scoped: drop them before querying so a
      // failed lookup can't leave the previous account's (or poll's) answer on
      // screen as if it belonged to the one now being loaded.
      setMyVotes([])
      setBallotPending(false)
      setTally(null)
      setDeleted(false)
      setDeletable(false)
      try {
        const { pollrPollService, pollrVoteService } = await import('@/lib/services')
        // A failed read throws; null is Platform saying the poll does not exist.
        let loadedPoll = await pollrPollService.fetchPoll(pollId)
        if (!loadedPoll && !cancelled && pollMissingMeansDeleted(nativeEmbed)) {
          // A node a block behind proves a just-published poll absent too, so
          // ask again before saying it was deleted.
          await new Promise((resolve) => setTimeout(resolve, ABSENT_RECHECK_MS))
          if (!cancelled) loadedPoll = await pollrPollService.fetchPoll(pollId)
        }
        if (cancelled) return
        if (!loadedPoll) {
          if (pollMissingMeansDeleted(nativeEmbed)) setDeleted(true)
          else setLoadError(true)
          return
        }
        setPoll(loadedPoll)

        const [tallyResult, votesResult] = await Promise.allSettled([
          pollrVoteService.getTally(loadedPoll),
          userId
            ? pollrVoteService.getBallotState(loadedPoll, userId)
            : Promise.resolve({ choices: [] as number[], pending: false }),
        ])
        if (cancelled) return

        // A failed tally shouldn't hide the poll itself, but it mustn't be
        // drawn as 0% across the board either: `tally === null` renders an
        // explicit "results unavailable" state with a retry.
        if (tallyResult.status === 'fulfilled') {
          setTally(tallyResult.value)
        } else {
          logger.error('PollCard: failed to load poll tally', tallyResult.reason)
        }

        // Own votes are load-bearing for correctness, so a failure closes the
        // ballot instead of guessing that the user hasn't voted.
        if (votesResult.status === 'fulfilled') {
          setMyVotes(votesResult.value.choices)
          setBallotPending(votesResult.value.pending)
        } else {
          logger.error('PollCard: failed to load own votes', votesResult.reason)
          setVotesUnavailable(true)
        }

        // v6: the owner may delete the poll until its first ballot. Not
        // awaited: the poll shows while the ballots are counted.
        checkDeletable(loadedPoll, votesResult)
          .catch((error: unknown) => logger.warn('PollCard: failed to count ballots', error))
      } catch (error) {
        logger.error('PollCard: failed to load poll', error)
        if (!cancelled) setLoadError(true)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load().catch((error) => logger.error('PollCard: failed to load poll', error))

    return () => {
      cancelled = true
    }
  }, [pollId, userId, reloadToken, nativeEmbed, checkDeletable])

  /** Leave the ballot: drop any pending selection and close the edit detour. */
  const stopEditing = useCallback(() => {
    setSelected([])
    setEditing(false)
  }, [])

  // Reset any pending selection when switching polls or signing in/out.
  useEffect(() => {
    stopEditing()
    setRequested(null)
  }, [pollId, userId, stopEditing])

  /** Leave the editor and forget any interrupted request: the voter chose not to send it. */
  const cancelEditing = useCallback(() => {
    stopEditing()
    setRequested(null)
  }, [stopEditing])

  useEffect(() => {
    setClosedOnChain(false)
  }, [pollId])

  const isClosed = closedOnChain || (poll ? pollIsClosed(poll) : false)
  const hasVoted = myVotes.length > 0
  // v3 stays in vote mode while choices are still selected: a multi-choice
  // ballot that failed partway leaves its unrecorded choices selected for a
  // retry. A v5 retry is a re-pick from the voter's current ballot instead.
  const showResults =
    !user ||
    !votingSupported ||
    isClosed ||
    votesUnavailable ||
    ballotPending ||
    (hasVoted && !editing && (editable || selected.length === 0))
  // v5: any voter may change their vote while the poll is open. v3: a
  // multi-choice voter who hasn't picked everything can still add selections.
  const canEdit = Boolean(
    user &&
      votingSupported &&
      !isClosed &&
      !votesUnavailable &&
      !ballotPending &&
      hasVoted &&
      (editable || (poll?.multiChoice && myVotes.length < (poll?.options.length ?? 0)))
  )
  const startEditing = useCallback(() => {
    // v5 edits the whole selection, so it starts from what is recorded (or
    // from an interrupted request, see editorStart); v3 only adds to it, so
    // the recorded choices stay locked and nothing is selected.
    setSelected(editable ? editorStart(myVotes, requested).selected : [])
    setEditing(true)
  }, [editable, myVotes, requested])

  const toggleChoice = useCallback((index: number, multiChoice: boolean) => {
    setSelected((current) => {
      if (!multiChoice) return [index]
      return current.includes(index)
        ? current.filter((choice) => choice !== index)
        : normalizeChoices([...current, index])
    })
  }, [])

  /** v5: make the voter's ballots select exactly `wanted` (empty = withdraw). */
  const submitSelection = useCallback(async (currentPoll: Poll, wanted: number[], voterId: string) => {
    const { pollrVoteService } = await import('@/lib/services')
    const result = await pollrVoteService.setVote(currentPoll, wanted, voterId)

    if (result.unconfirmed || result.heldBack) {
      // A write is out with no outcome yet (this one, or an earlier one this
      // was held back behind), so the ballots may still change. Show them
      // read-only until "Check again" finds nothing pending; the vote and
      // tally stay as they were rather than take a read that likely predates
      // the write. The voter picks again from the settled ballots.
      toast(result.unconfirmed ? 'Your vote was sent and is being confirmed.' : 'Your earlier vote is still being confirmed.', {
        icon: '⏳',
        duration: 6000,
      })
      setBallotPending(true)
      setRequested(normalizeChoices(wanted))
      stopEditing()
      return
    }

    if (result.choices === null) {
      // The ballot state is unknown: close the ballot as when own votes fail to load.
      setVotesUnavailable(true)
    } else if (result.choices !== undefined) {
      // Adjust the counts by what changed against the selection the tally was
      // read with — down as well as up, since a vote can move or be withdrawn.
      const { added, removed } = choiceDelta(myVotes, result.choices)
      setMyVotes(result.choices)
      if (tally && (added.length > 0 || removed.length > 0)) {
        setTally(pollrVoteService.applyOptimisticVotes(currentPoll.id, tally, added, removed))
      }
    }

    if (result.closed) {
      setClosedOnChain(true)
      toast.error('This poll has closed')
    } else if (result.stale) {
      toast('Your vote changed elsewhere — showing the latest.', { icon: 'ℹ️' })
    } else if (!result.success && pollrPollsDeletable() && isReferenceNotFoundError(result.error)) {
      // v6: the owner deleted the poll after this card loaded. Re-read it
      // rather than keep a ballot open that every retry would pay to fail.
      const { pollrPollService } = await import('@/lib/services')
      pollrPollService.clearCache(currentPoll.id)
      toast('This poll was deleted.', { icon: 'ℹ️' })
      stopEditing()
      setRequested(null)
      setReloadToken((token) => token + 1)
      return
    } else if (!result.success) {
      toast.error(categorizeError(result.error))
      // Keep the ballot open on the wanted picks for a retry — including after a
      // partial first multi-choice vote, which now has recorded choices.
      setSelected(wanted)
      setEditing(true)
      return
    } else if (wanted.length === 0) {
      toast.success('Vote withdrawn')
    } else {
      toast.success(myVotes.length > 0 ? 'Vote updated' : 'Vote counted')
    }

    stopEditing()
    setRequested(null)
    // Closed or changed elsewhere: what is on screen is out of date, so re-read
    // the poll's tally and the voter's ballots together.
    if (result.closed || result.stale) setReloadToken((token) => token + 1)
  }, [myVotes, tally, stopEditing])

  const handleVote = useCallback(async (wantedOverride?: number[]) => {
    const wanted = wantedOverride ?? selected
    if (!poll || (!editable && wanted.length === 0)) return
    const authedUser = user
    if (!authedUser) {
      openLoginPrompt()
      return
    }

    setSubmitting(true)
    // No delete while a ballot is on its way, and no count read before it may
    // bring the delete back (the epoch moves on).
    deleteCheckRef.current += 1
    setDeletable(false)
    try {
      if (editable) {
        await submitSelection(poll, wanted, authedUser.identityId)
        return
      }

      const { pollrVoteService } = await import('@/lib/services')
      const result = await pollrVoteService.castVote(poll, wanted, authedUser.identityId)

      // Duplicates mean the ballot was already on Platform — record them rather
      // than surfacing an error.
      const recordedList = [...result.created, ...result.alreadyVoted]
      const recorded = new Set(recordedList)
      if (recordedList.length > 0) {
        setMyVotes((current) => normalizeChoices([...current, ...recordedList]))
      }
      // The voter has a ballot on chain but it couldn't be read which: close the
      // ballot as when own votes fail to load, rather than tick a guessed choice.
      if (result.unresolvedDuplicate) {
        setVotesUnavailable(true)
      }
      // Anything that didn't make it stays selected so the user can retry it —
      // except on a single-choice poll, where the ballot is settled the moment
      // anything is recorded. A duplicate there reports the choice already on
      // Platform, not the one just attempted, so filtering by index alone would
      // leave the rejected pick selected and the ballot stuck open.
      const settled = !poll.multiChoice && (recordedList.length > 0 || result.unresolvedDuplicate)
      setSelected((current) => (settled ? [] : current.filter((choice) => !recorded.has(choice))))
      if (result.failed.length === 0) {
        setEditing(false)
      }

      // Fold the new votes in rather than re-reading: the count trees can lag a
      // few seconds behind the write, and that stale answer would be cached.
      // Only when a real tally is in hand — incrementing an invented zero
      // baseline would turn "results unavailable" into a confident wrong number.
      const optimistic =
        result.created.length > 0 && tally
          ? pollrVoteService.applyOptimisticVotes(poll.id, tally, result.created)
          : tally
      setTally(optimistic)

      if (result.created.length > 0) {
        toast.success('Vote counted')
      } else if ((result.alreadyVoted.length > 0 || result.unresolvedDuplicate) && result.failed.length === 0) {
        toast('You had already voted', { icon: 'ℹ️' })
      }
      if (result.failed.length > 0) {
        toast.error(categorizeError(result.error))
      }

      // A duplicate means the voter already cast a ballot this card's tally
      // predates (another tab or device), so the numbers on screen are short by
      // that vote. Re-read them rather than leave "✓ your vote" on a 0.
      if (result.alreadyVoted.length > 0 || result.unresolvedDuplicate) {
        setTally(await pollrVoteService.refreshTally(poll, optimistic, result))
      }
    } catch (error) {
      logger.error('PollCard: failed to cast vote', error)
      toast.error(categorizeError(error))
    } finally {
      setSubmitting(false)
      // Recomputed from scratch once the submission is over: a landed ballot
      // is known for good, one that may still land reads as pending, and a vote
      // that was never sent gives the delete back.
      checkDeletable(poll).catch((error: unknown) => logger.warn('PollCard: failed to count ballots', error))
    }
  }, [poll, selected, tally, user, editable, submitSelection, openLoginPrompt, checkDeletable])

  /** v6: the owner deletes the poll, which Platform allows only until its first ballot. */
  const handleDelete = useCallback(async () => {
    if (!poll || !userId) return
    setDeleting(true)
    try {
      const { pollrPollService } = await import('@/lib/services')
      const result = await pollrPollService.deletePoll(poll, userId)
      if (result.status === 'deleted') {
        setDeleted(true)
        toast.success('Poll deleted')
      } else if (result.status === 'voted') {
        setDeletable(false)
        toast.error('Someone has voted on this poll, so it can\'t be deleted anymore.')
        setReloadToken((token) => token + 1)
      } else if (result.status === 'pending') {
        // Nothing was sent: the owner's own vote is still being confirmed.
        setDeletable(false)
        toast('Your vote on this poll is still being confirmed.', { icon: '⏳' })
        setReloadToken((token) => token + 1)
      } else {
        toast.error(categorizeError(result.error))
        // The delete may still have landed (a timed-out wait): re-read.
        setReloadToken((token) => token + 1)
      }
    } catch (error) {
      logger.error('PollCard: failed to delete poll', error)
      toast.error(categorizeError(error))
    } finally {
      setDeleting(false)
      setConfirmingDelete(false)
    }
  }, [poll, userId])

  if (loading) {
    return (
      <div className={cn('mt-3 rounded-xl border border-gray-200 dark:border-gray-700 p-3 animate-pulse', className)}>
        <div className="h-4 w-2/3 bg-gray-200 dark:bg-gray-700 rounded" />
        <div className="mt-3 space-y-2">
          <div className="h-8 w-full bg-gray-200 dark:bg-gray-700 rounded-lg" />
          <div className="h-8 w-full bg-gray-200 dark:bg-gray-700 rounded-lg" />
        </div>
      </div>
    )
  }

  if (deleted) {
    return (
      <div className={cn('mt-3 rounded-xl border border-gray-200 dark:border-gray-700 p-3', className)}>
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <ChartBarIcon className="h-4 w-4" />
          <span>This poll was deleted.</span>
        </div>
      </div>
    )
  }

  if (loadError || !poll) {
    return (
      <div className={cn('mt-3 rounded-xl border border-gray-200 dark:border-gray-700 p-3', className)}>
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <ChartBarIcon className="h-4 w-4" />
          <span>This poll could not be loaded.</span>
        </div>
        <PollFooter pollId={pollId} />
      </div>
    )
  }

  // v5 submits the whole selection, so it needs a change (an emptied
  // multi-choice ballot is a withdrawal); v3 submits additions, so it needs one.
  const submitDisabled = submitting || (editable ? sameChoices(selected, myVotes) : selected.length === 0)
  const submitLabel = editable && hasVoted ? 'Update vote' : 'Vote'
  // An interrupted request that the settled ballots do not fully show.
  const interruptedUnsent = editable && requested ? editorStart(myVotes, requested).unsent : []
  // While editing, the options the current selection would change.
  const unsentInEditor = editable && requested ? choiceDelta(myVotes, selected) : null
  // Shown only once the close has passed AND the counts can no longer move.
  const finalResults = tally !== null && tallyIsFinal(poll, tally)

  // No tally means the counts are unknown, not zero — see PollTallyUnavailableError.
  const tallyUnavailable = tally === null
  const counts = tally?.counts ?? []
  const total = tally?.total ?? 0
  const leading = counts.length > 0 ? Math.max(...counts) : 0
  // Compare both raw and URL-stripped: the composer appends attachment URLs to
  // the body, but a question may legitimately end in a URL of its own.
  const postText = (postContent ?? '').trim()
  const question = poll.question.trim()
  const questionShownByPost = postText === question || postTextWithoutTrailingUrls(postText) === question
  // The poll may have been made by someone other than whoever posted it.
  const foreignPollOwner = postAuthorId && postAuthorId !== poll.ownerId ? poll.ownerId : null

  return (
    <div
      onClick={stopPropagation}
      onKeyDown={stopPropagation}
      className={cn('mt-3 rounded-xl border border-gray-200 dark:border-gray-700 p-3', className)}
    >
      {!questionShownByPost && (
        <p className="text-sm font-semibold text-gray-900 dark:text-gray-100 break-words">
          {poll.question}
        </p>
      )}

      {showResults ? (
        <div className="mt-3 space-y-2">
          {poll.options.map((option, index) => {
            const count = counts[index] ?? 0
            const share = tallyUnavailable ? 0 : percent(count, total)
            const isMine = myVotes.includes(index)
            return (
              <div key={index} className="relative overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700">
                <div
                  className={cn(
                    'absolute inset-y-0 left-0 transition-all',
                    isMine ? 'bg-yappr-500/20' : 'bg-gray-200/70 dark:bg-gray-700/50'
                  )}
                  style={{ width: `${share}%` }}
                />
                <div className="relative flex items-center justify-between gap-3 px-3 py-2">
                  <span className={cn(
                    'text-sm break-words',
                    count === leading && count > 0 ? 'font-semibold' : '',
                    'text-gray-900 dark:text-gray-100'
                  )}>
                    {option}
                    {isMine && <span className="ml-1.5 text-xs text-yappr-500">✓ your vote</span>}
                  </span>
                  <span className="shrink-0 text-xs tabular-nums text-gray-500">
                    {tallyUnavailable ? '—' : `${share}% · ${formatNumber(count)}`}
                  </span>
                </div>
              </div>
            )
          })}

          {canEdit && interruptedUnsent.length > 0 && (
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Part of your last vote was not sent.
            </p>
          )}

          {canEdit && (
            <button
              onClick={startEditing}
              className="text-xs font-medium text-yappr-500 hover:underline"
            >
              {editable ? (interruptedUnsent.length > 0 ? 'Finish your vote' : 'Change vote') : 'Add choices'}
            </button>
          )}

          {ballotPending && user && (
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Confirming your vote…{' '}
              <button
                onClick={() => setReloadToken((token) => token + 1)}
                className="font-medium text-yappr-500 hover:underline"
              >
                Check again
              </button>
            </p>
          )}

          {/* One retry covers both reads — the reload refetches the tally and
              the user's own votes together. */}
          {(tallyUnavailable || (votesUnavailable && user && !isClosed)) && (
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {tallyUnavailable
                ? "Couldn't load the results."
                : "Couldn't check whether you've already voted."}{' '}
              <button
                onClick={() => setReloadToken((token) => token + 1)}
                className="font-medium text-yappr-500 hover:underline"
              >
                Try again
              </button>
            </p>
          )}
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          {poll.options.map((option, index) => {
            // v3 votes are immutable: a choice already on Platform can't be
            // undone. v5 ones can, so every option stays live.
            const isRecorded = myVotes.includes(index)
            const isLocked = !editable && isRecorded
            const isChecked = isLocked || selected.includes(index)
            return (
              <label
                key={index}
                className={cn(
                  'flex items-center gap-2.5 rounded-lg border px-3 py-2 transition-colors',
                  isLocked ? 'cursor-default' : 'cursor-pointer',
                  isChecked
                    ? 'border-yappr-500 bg-yappr-50 dark:bg-yappr-950/40'
                    : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600'
                )}
              >
                <input
                  type={poll.multiChoice ? 'checkbox' : 'radio'}
                  name={`poll-${poll.id}`}
                  checked={isChecked}
                  onChange={() => toggleChoice(index, poll.multiChoice)}
                  disabled={submitting || isLocked}
                  className="accent-yappr-500"
                />
                <span className="text-sm text-gray-900 dark:text-gray-100 break-words">
                  {option}
                  {isRecorded && <span className="ml-1.5 text-xs text-yappr-500">{editable ? '✓ your vote' : '✓ recorded'}</span>}
                  {unsentInEditor && [...unsentInEditor.added, ...unsentInEditor.removed].includes(index) && (
                    <span className="ml-1.5 text-xs text-amber-600 dark:text-amber-400">not sent yet</span>
                  )}
                </span>
              </label>
            )
          })}

          <div className="flex items-center gap-2">
            <Button
              onClick={() => handleVote()}
              disabled={submitDisabled}
              className="flex-1 h-9 text-sm font-semibold bg-yappr-500 hover:bg-yappr-600 disabled:bg-gray-300 dark:disabled:bg-gray-700"
            >
              {submitting ? <Spinner size="sm" className="h-4 w-4 border-white" /> : submitLabel}
            </Button>
            {/* A single-choice v5 voter withdraws by dropping the one choice;
                a multi-choice one just unticks everything. */}
            {editable && editing && hasVoted && !poll.multiChoice && (
              <Button
                variant="ghost"
                onClick={() => handleVote([])}
                disabled={submitting}
                className="h-9 text-sm"
              >
                Withdraw
              </Button>
            )}
            {/* Only for the "change vote" / "add choices" detour. NOT when v3
                choices are still selected after a partial failure — cancelling
                there would silently discard the retry the user still needs. */}
            {editing && (
              <Button
                variant="ghost"
                onClick={cancelEditing}
                disabled={submitting}
                className="h-9 text-sm"
              >
                Cancel
              </Button>
            )}
          </div>
        </div>
      )}

      <div className="mt-2 flex items-center justify-between gap-2 text-xs text-gray-500">
        <span>
          {/* "Final results" would vouch for numbers we don't have. */}
          {tallyUnavailable ? 'Vote count unavailable' : `${formatNumber(total)} vote${total === 1 ? '' : 's'}`}
          {poll.multiChoice && ' · multiple choice'}
          {/* Nor when the count wasn't bounded by the close time. */}
          {finalResults && ' · Final results'}
          {isClosed && !finalResults && ' · Closed'}
          {!isClosed && poll.endsAt !== undefined && ` · ${closesInLabel(poll.endsAt)}`}
        </span>
        {!user && !isClosed && votingSupported && (
          <button
            onClick={() => openLoginPrompt()}
            className="font-medium text-yappr-500 hover:underline"
          >
            Sign in to vote
          </button>
        )}
        {deletable && !submitting && !ballotPending && (
          <button
            onClick={() => setConfirmingDelete(true)}
            className="font-medium text-gray-500 hover:text-red-600 hover:underline"
          >
            Delete poll
          </button>
        )}
      </div>

      <PollFooter pollId={poll.id} ownerId={foreignPollOwner} />

      <ConfirmDialog
        isOpen={confirmingDelete}
        onClose={() => setConfirmingDelete(false)}
        onConfirm={() => {
          handleDelete().catch((error) => logger.error('PollCard: failed to delete poll', error))
        }}
        title="Delete this poll?"
        message="The post stays, but its poll is removed for everyone. A poll can only be deleted until someone votes."
        confirmText="Delete poll"
        isLoading={deleting}
      />
    </div>
  )
}

/** "Closes in 3 days" / "Closes in 5 hours" / "Closes in 12 minutes". */
function closesInLabel(endsAt: number, now: number = Date.now()): string {
  const minutes = Math.max(1, Math.ceil((endsAt - now) / 60_000))
  if (minutes < 60) return `Closes in ${minutes} minute${minutes === 1 ? '' : 's'}`
  const hours = Math.ceil(minutes / 60)
  if (hours < 48) return `Closes in ${hours} hour${hours === 1 ? '' : 's'}`
  return `Closes in ${Math.ceil(hours / 24)} days`
}

function PollFooter({ pollId, ownerId }: { pollId: string; ownerId?: string | null }) {
  const pollUrl = pollrPollUrl(pollId)
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-gray-400">
      {pollUrl ? (
        <a
          href={pollUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={stopPropagation}
          className="inline-flex items-center gap-1 hover:text-yappr-500 transition-colors"
        >
          <ChartBarIcon className="h-3.5 w-3.5" />
          Powered by Pollr
        </a>
      ) : (
        <span className="inline-flex items-center gap-1">
          <ChartBarIcon className="h-3.5 w-3.5" />
          Powered by Pollr
        </span>
      )}
      {ownerId && (
        <span title={ownerId}>· Poll by {ownerId.slice(0, 6)}…</span>
      )}
    </div>
  )
}
