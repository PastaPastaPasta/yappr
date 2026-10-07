'use client'

import { motion } from 'framer-motion'
import { PlusIcon, TrashIcon, XMarkIcon } from '@heroicons/react/24/outline'
import { Switch } from '@/components/ui/switch'
import { IconButton } from '@/components/ui/icon-button'
import { POLLR_TOPOLOGY, pollrIsV5 } from '@/lib/constants'
import {
  DEFAULT_POLL_DURATION,
  POLL_DURATIONS,
  POLL_MAX_OPTIONS,
  POLL_MIN_OPTIONS,
  pollEndsAt,
  pollLimits,
  pollOptionsError,
  pollQuestionError,
  trimPollOptions,
  type PollDuration,
} from '@/lib/pollr-rules'

export interface PollDraft {
  options: string[]
  multiChoice: boolean
  /** How long the poll stays open; every poll closes (v5 requires it, within 31 days). */
  duration: PollDuration
}

const LIMITS = pollLimits(POLLR_TOPOLOGY)
const LOCKED_NOTE = 'This poll is already on Platform and can no longer be edited — retrying the post re-uses it.'
const VOTING_NOTE = pollrIsV5()
  ? 'Polls live on the Pollr contract. Voters can change their vote until the poll closes; after that the results are final.'
  : 'Polls live on the Pollr contract. Votes are permanent and cannot be changed.'

export function createPollDraft(): PollDraft {
  return { options: ['', ''], multiChoice: false, duration: DEFAULT_POLL_DURATION }
}

/** Filled-in, trimmed options — what actually gets written to the contract. */
export function pollDraftOptions(draft: PollDraft): string[] {
  return trimPollOptions(draft.options)
}

/**
 * Why this poll can't be posted yet, or null. `question` is the post text the
 * poll takes as its question (without appended attachment URLs).
 */
export function pollDraftProblem(draft: PollDraft, question: string): string | null {
  return pollOptionsError(pollDraftOptions(draft), LIMITS) ?? pollQuestionError(question.trim(), LIMITS)
}

/** Close time in ms since epoch, computed at the moment of posting. */
export function pollDraftEndsAt(draft: PollDraft): number {
  return pollEndsAt(draft.duration)
}

interface PollEditorProps {
  draft: PollDraft
  /** The post text, which becomes the poll's question. */
  question: string
  onChange: (draft: PollDraft) => void
  onRemove: () => void
  disabled?: boolean
  /** The poll already exists on Platform (immutable) — editing is no longer possible. */
  locked?: boolean
}

export function PollEditor({ draft, question, onChange, onRemove, disabled = false, locked = false }: PollEditorProps) {
  // A poll that already landed on Platform is immutable, but the user may still
  // detach it and post without the embed.
  const fieldsDisabled = disabled || locked
  // Only once there is something to judge: an untouched draft isn't an error.
  const problem = locked || pollDraftOptions(draft).length < POLL_MIN_OPTIONS ? null : pollDraftProblem(draft, question)

  const setOption = (index: number, value: string) => {
    const options = [...draft.options]
    options[index] = value
    onChange({ ...draft, options })
  }

  const addOption = () => {
    if (draft.options.length >= POLL_MAX_OPTIONS) return
    onChange({ ...draft, options: [...draft.options, ''] })
  }

  const removeOption = (index: number) => {
    if (draft.options.length <= POLL_MIN_OPTIONS) return
    onChange({ ...draft, options: draft.options.filter((_, i) => i !== index) })
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-xl border-2 border-gray-200 dark:border-gray-700 overflow-hidden"
    >
      <div className="flex items-center justify-between px-4 py-2 bg-gray-50 dark:bg-gray-800/50 border-b border-gray-200 dark:border-gray-700">
        <span className="text-xs font-medium text-gray-500 dark:text-gray-400">
          Poll — your post text is the question
        </span>
        <IconButton onClick={onRemove} disabled={disabled} aria-label="Remove poll">
          <XMarkIcon className="h-4 w-4" />
        </IconButton>
      </div>

      <div className="p-4 space-y-2">
        {draft.options.map((option, index) => (
          <div key={index} className="flex items-center gap-2">
            <input
              type="text"
              value={option}
              onChange={(e) => setOption(index, e.target.value)}
              disabled={fieldsDisabled}
              maxLength={LIMITS.optionMaxChars}
              placeholder={`Choice ${index + 1}`}
              className="flex-1 px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent outline-none focus:border-yappr-500 placeholder:text-gray-400 dark:placeholder:text-gray-600"
            />
            {draft.options.length > POLL_MIN_OPTIONS && (
              <IconButton
                onClick={() => removeOption(index)}
                disabled={fieldsDisabled}
                aria-label={`Remove choice ${index + 1}`}
              >
                <TrashIcon className="h-4 w-4 text-red-500" />
              </IconButton>
            )}
          </div>
        ))}

        {draft.options.length < POLL_MAX_OPTIONS && (
          <button
            type="button"
            onClick={addOption}
            disabled={fieldsDisabled}
            className="flex items-center gap-1.5 text-sm text-yappr-500 hover:text-yappr-600 disabled:opacity-50"
          >
            <PlusIcon className="h-4 w-4" />
            Add choice
          </button>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-gray-100 dark:border-gray-800">
          <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
            <Switch
              checked={draft.multiChoice}
              onCheckedChange={(checked) => onChange({ ...draft, multiChoice: checked })}
              disabled={fieldsDisabled}
            />
            Allow multiple choices
          </label>

          <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
            Closes
            <select
              value={draft.duration}
              onChange={(e) => onChange({ ...draft, duration: e.target.value as PollDuration })}
              disabled={fieldsDisabled}
              className="px-2 py-1 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent outline-none focus:border-yappr-500"
            >
              {POLL_DURATIONS.map(({ value, label }) => (
                <option key={value} value={value} className="dark:bg-neutral-900">
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>

        {problem && <p className="text-xs text-red-500">{problem}</p>}

        <p className="text-xs text-gray-400">
          {locked ? LOCKED_NOTE : VOTING_NOTE}
        </p>
      </div>
    </motion.div>
  )
}
