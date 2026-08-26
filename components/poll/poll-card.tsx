'use client'

import { useCallback, useEffect, useState } from 'react'
import { logger } from '@/lib/logger'
import toast from 'react-hot-toast'
import { ChartBarIcon } from '@heroicons/react/24/outline'
import { useAuth } from '@/contexts/auth-context'
import { useRequireAuth } from '@/hooks/use-require-auth'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { cn, formatNumber } from '@/lib/utils'
import { categorizeError } from '@/lib/error-utils'
import { pollrPollUrl } from '@/lib/poll-embed'
import type { Poll, PollTally } from '@/lib/services'

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
  className?: string
}

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

export function PollCard({ pollId, postContent, postAuthorId, className }: PollCardProps) {
  const { user } = useAuth()
  const { openLoginPrompt } = useRequireAuth()

  const [poll, setPoll] = useState<Poll | null>(null)
  const [tally, setTally] = useState<PollTally | null>(null)
  const [myVotes, setMyVotes] = useState<number[]>([])
  const [selected, setSelected] = useState<number[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  // Multi-choice voters can come back and add more selections; this reopens the
  // ballot over the already-recorded ones.
  const [addingChoices, setAddingChoices] = useState(false)

  const userId = user?.identityId ?? null

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      setLoading(true)
      setLoadError(false)
      try {
        const { pollrPollService, pollrVoteService } = await import('@/lib/services')
        const loadedPoll = await pollrPollService.getPoll(pollId)
        if (cancelled) return
        if (!loadedPoll) {
          setLoadError(true)
          return
        }
        setPoll(loadedPoll)

        // A failed tally shouldn't hide the poll itself — fall back to zeroes.
        try {
          const [loadedTally, loadedVotes] = await Promise.all([
            pollrVoteService.getTally(pollId, loadedPoll.options.length),
            userId ? pollrVoteService.getMyVotes(pollId, userId) : Promise.resolve<number[]>([]),
          ])
          if (cancelled) return
          setTally(loadedTally)
          setMyVotes(loadedVotes)
        } catch (error) {
          logger.error('PollCard: failed to load poll results', error)
        }
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
  }, [pollId, userId])

  // Reset any pending selection when switching polls or signing in/out.
  useEffect(() => {
    setSelected([])
    setAddingChoices(false)
  }, [pollId, userId])

  const isClosed = Boolean(poll?.endsAt && poll.endsAt < Date.now())
  const hasVoted = myVotes.length > 0
  // Stay in vote mode while choices are still selected: a multi-choice ballot
  // that failed partway leaves its unrecorded choices selected for a retry.
  const showResults = !user || isClosed || (hasVoted && selected.length === 0 && !addingChoices)
  // A multi-choice voter who hasn't picked everything can still add selections.
  const canAddChoices = Boolean(
    user && !isClosed && poll?.multiChoice && hasVoted && myVotes.length < (poll?.options.length ?? 0)
  )

  const toggleChoice = useCallback((index: number, multiChoice: boolean) => {
    setSelected((current) => {
      if (!multiChoice) return [index]
      return current.includes(index)
        ? current.filter((choice) => choice !== index)
        : [...current, index].sort((a, b) => a - b)
    })
  }, [])

  const handleVote = useCallback(async () => {
    if (!poll || selected.length === 0) return
    const authedUser = user
    if (!authedUser) {
      openLoginPrompt('generic')
      return
    }

    setSubmitting(true)
    try {
      const { pollrVoteService } = await import('@/lib/services')
      const result = await pollrVoteService.castVote(
        poll.id,
        poll.ownerId,
        selected,
        authedUser.identityId,
        poll.endsAt
      )

      // Duplicates mean the ballot was already on Platform — record them rather
      // than surfacing an error.
      const recordedList = [...result.created, ...result.alreadyVoted]
      const recorded = new Set(recordedList)
      if (recordedList.length > 0) {
        setMyVotes((current) => Array.from(new Set([...current, ...recordedList])).sort((a, b) => a - b))
      }
      // Anything that didn't make it stays selected so the user can retry it.
      setSelected((current) => current.filter((choice) => !recorded.has(choice)))
      if (result.failed.length === 0) {
        setAddingChoices(false)
      }

      // Fold the new votes in rather than re-reading: the count trees can lag a
      // few seconds behind the write, and that stale answer would be cached.
      if (result.created.length > 0) {
        const baseline = tally ?? { counts: new Array<number>(poll.options.length).fill(0), total: 0 }
        setTally(pollrVoteService.applyOptimisticVotes(poll.id, baseline, result.created))
      }

      if (result.created.length > 0) {
        toast.success('Vote counted')
      } else if (result.alreadyVoted.length > 0 && result.failed.length === 0) {
        toast('You had already voted', { icon: 'ℹ️' })
      }
      if (result.failed.length > 0) {
        toast.error(categorizeError(result.error))
      }
    } catch (error) {
      logger.error('PollCard: failed to cast vote', error)
      toast.error(categorizeError(error))
    } finally {
      setSubmitting(false)
    }
  }, [poll, selected, tally, user, openLoginPrompt])

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

  const counts = tally?.counts ?? new Array<number>(poll.options.length).fill(0)
  const total = tally?.total ?? 0
  const leading = counts.length > 0 ? Math.max(...counts) : 0
  const questionShownByPost = postTextWithoutTrailingUrls(postContent ?? '') === poll.question.trim()
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
            const share = percent(count, total)
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
                    {share}% · {formatNumber(count)}
                  </span>
                </div>
              </div>
            )
          })}

          {canAddChoices && (
            <button
              onClick={() => setAddingChoices(true)}
              className="text-xs font-medium text-yappr-500 hover:underline"
            >
              Add choices
            </button>
          )}
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          {poll.options.map((option, index) => {
            // Votes are immutable: a choice already on Platform can't be undone.
            const isRecorded = myVotes.includes(index)
            const isChecked = isRecorded || selected.includes(index)
            return (
              <label
                key={index}
                className={cn(
                  'flex items-center gap-2.5 rounded-lg border px-3 py-2 transition-colors',
                  isRecorded ? 'cursor-default' : 'cursor-pointer',
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
                  disabled={submitting || isRecorded}
                  className="accent-yappr-500"
                />
                <span className="text-sm text-gray-900 dark:text-gray-100 break-words">
                  {option}
                  {isRecorded && <span className="ml-1.5 text-xs text-yappr-500">✓ recorded</span>}
                </span>
              </label>
            )
          })}

          <div className="flex items-center gap-2">
            <Button
              onClick={handleVote}
              disabled={selected.length === 0 || submitting}
              className="flex-1 h-9 text-sm font-semibold bg-yappr-500 hover:bg-yappr-600 disabled:bg-gray-300 dark:disabled:bg-gray-700"
            >
              {submitting ? <Spinner size="sm" className="h-4 w-4 border-white" /> : 'Vote'}
            </Button>
            {hasVoted && (
              <Button
                variant="ghost"
                onClick={() => {
                  setSelected([])
                  setAddingChoices(false)
                }}
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
          {formatNumber(total)} vote{total === 1 ? '' : 's'}
          {poll.multiChoice && ' · multiple choice'}
          {isClosed && ' · Final results'}
        </span>
        {!user && !isClosed && (
          <button
            onClick={() => openLoginPrompt('generic')}
            className="font-medium text-yappr-500 hover:underline"
          >
            Sign in to vote
          </button>
        )}
      </div>

      <PollFooter pollId={poll.id} ownerId={foreignPollOwner} />
    </div>
  )
}

function PollFooter({ pollId, ownerId }: { pollId: string; ownerId?: string | null }) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-gray-400">
      <a
        href={pollrPollUrl(pollId)}
        target="_blank"
        rel="noopener noreferrer"
        onClick={stopPropagation}
        className="inline-flex items-center gap-1 hover:text-yappr-500 transition-colors"
      >
        <ChartBarIcon className="h-3.5 w-3.5" />
        Powered by Pollr
      </a>
      {ownerId && (
        <span title={ownerId}>· Poll by {ownerId.slice(0, 6)}…</span>
      )}
    </div>
  )
}
