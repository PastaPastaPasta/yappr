/**
 * Pure rules for Pollr polls and ballots: what each contract topology accepts,
 * how long a poll may stay open, and how a voter's wanted choices turn into
 * ballot writes. No SDK, no network — the services and the poll editor call in.
 */

export type PollrTopology = 'v3' | 'v4' | 'v7' | 'v8'

export const POLL_MIN_OPTIONS = 2
export const POLL_MAX_OPTIONS = 10

const DAY_MS = 24 * 60 * 60 * 1000

/** v7's `endsWithin31Days`: a poll closes at most 31 days after `$createdAt`. */
export const POLL_MAX_DURATION_MS = 31 * DAY_MS

/** How long a new poll stays open. */
export type PollDuration = '1d' | '3d' | '7d' | '14d' | '30d'

/**
 * The durations the poll editor offers, shortest first. The longest is 30 days,
 * not 31: the close time is computed from this device's clock, and `$createdAt`
 * is the block's, so a full 31 days would be refused whenever the clock runs
 * ahead of the chain.
 */
export const POLL_DURATIONS: readonly { value: PollDuration; label: string; ms: number }[] = [
  { value: '1d', label: '1 day', ms: DAY_MS },
  { value: '3d', label: '3 days', ms: 3 * DAY_MS },
  { value: '7d', label: '7 days', ms: 7 * DAY_MS },
  { value: '14d', label: '14 days', ms: 14 * DAY_MS },
  { value: '30d', label: '30 days', ms: 30 * DAY_MS },
]

export const DEFAULT_POLL_DURATION: PollDuration = '1d'

/** The close time, in ms since epoch, of a poll opened at `now` for `duration`. */
export function pollEndsAt(duration: PollDuration, now: number = Date.now()): number {
  const entry = POLL_DURATIONS.find((option) => option.value === duration) ?? POLL_DURATIONS[0]
  return now + entry.ms
}

interface PollLimits {
  questionMaxChars: number
  /** UTF-8 cap on the question, or null where the contract sets none. */
  questionMaxBytes: number | null
  optionMaxChars: number
  optionMaxBytes: number | null
  /** The contract refuses two identical options (`uniqueItems`). */
  uniqueOptions: boolean
  /** Every poll must carry a close time. */
  endsAtRequired: boolean
}

/** What each topology's `poll` schema accepts. */
export function pollLimits(topology: PollrTopology): PollLimits {
  // v8 is v7 without the poll indexes: the same poll and ballot schemas.
  if (topology === 'v7' || topology === 'v8') {
    return { questionMaxChars: 280, questionMaxBytes: 560, optionMaxChars: 80, optionMaxBytes: 160, uniqueOptions: true, endsAtRequired: true }
  }
  // v3/v4: option0..option9 strings, 1-100 characters, and a 512-character question.
  return { questionMaxChars: 512, questionMaxBytes: null, optionMaxChars: 100, optionMaxBytes: null, uniqueOptions: false, endsAtRequired: false }
}

/**
 * Length as the contract counts it: Unicode code points, so an emoji is one
 * character (JavaScript's `length` counts it as two UTF-16 units).
 */
export function charCount(value: string): number {
  return Array.from(value).length
}

const encoder = new TextEncoder()

function utf8Length(value: string): number {
  return encoder.encode(value).length
}

/**
 * Why `value` is over its limits, as the end of a sentence, or null. The byte
 * cap is the one emoji and non-Latin scripts hit first, so it says so.
 */
function lengthProblem(value: string, maxChars: number, maxBytes: number | null): string | null {
  if (charCount(value) > maxChars) return `${maxChars} characters or fewer`
  if (maxBytes !== null && utf8Length(value) > maxBytes) return `shorter: emoji and non-Latin letters take extra room (${maxBytes} bytes at most)`
  return null
}

/** Trimmed options with the blank ones dropped — what actually gets written to the contract. */
export function trimPollOptions(options: readonly string[]): string[] {
  return options.map((option) => option.trim()).filter((option) => option.length > 0)
}

/** Why the contract would refuse this (trimmed) question, or null. */
export function pollQuestionError(question: string, limits: PollLimits): string | null {
  if (question.length === 0) return 'Poll question is required'
  const problem = lengthProblem(question, limits.questionMaxChars, limits.questionMaxBytes)
  return problem ? `Poll question must be ${problem}` : null
}

/** Why the contract would refuse these (trimmed, non-empty) options, or null. */
export function pollOptionsError(options: readonly string[], limits: PollLimits): string | null {
  if (options.length < POLL_MIN_OPTIONS || options.length > POLL_MAX_OPTIONS) {
    return `Polls need between ${POLL_MIN_OPTIONS} and ${POLL_MAX_OPTIONS} choices`
  }
  for (const option of options) {
    const problem = lengthProblem(option, limits.optionMaxChars, limits.optionMaxBytes)
    if (problem) return `Each choice must be ${problem}`
  }
  if (limits.uniqueOptions && new Set(options).size !== options.length) {
    return 'Each choice must be different'
  }
  return null
}

/** Why the contract would refuse this close time for a poll created at `now`, or null. */
export function pollEndsAtError(endsAt: number | undefined, limits: PollLimits, now: number = Date.now()): string | null {
  if (endsAt === undefined) return limits.endsAtRequired ? 'Polls need a close time' : null
  if (!Number.isFinite(endsAt) || endsAt <= now) return 'A poll must close in the future'
  if (limits.endsAtRequired && endsAt - now > POLL_MAX_DURATION_MS) return 'A poll can stay open for at most 31 days'
  return null
}

// ---- Ballots (v7) -------------------------------------------------------------

/**
 * A voter's one v7 ballot on a poll. `choices` holds the picked options in
 * order, and is empty when the ballot was withdrawn.
 */
export interface Ballot {
  id: string
  revision: number
  choices: number[]
}

/** A replace with no choices withdraws: the document is written without `choices`. */
export type BallotWrite =
  | { kind: 'create'; choices: number[] }
  | { kind: 'replace'; ballot: Ballot; choices: number[] }

/** Whether `choice` names an option of a `size`-option poll (any schema-valid option by default). */
export function isChoiceIndex(choice: number, size: number = POLL_MAX_OPTIONS): boolean {
  return Number.isInteger(choice) && choice >= 0 && choice < Math.min(size, POLL_MAX_OPTIONS)
}

/** Dedupe, drop anything that is not an option of a `size`-option poll, and order. */
export function normalizeChoices(choices: readonly number[], size: number = POLL_MAX_OPTIONS): number[] {
  return Array.from(new Set(choices))
    .filter((choice) => isChoiceIndex(choice, size))
    .sort((a, b) => a - b)
}

export function sameChoices(a: readonly number[], b: readonly number[]): boolean {
  const left = normalizeChoices(a)
  const right = normalizeChoices(b)
  return left.length === right.length && left.every((choice, index) => choice === right[index])
}

/**
 * Where the ballot editor starts. Normally from the recorded choices; after a
 * submission that was not confirmed, from what the voter last asked for, since
 * it may never have landed. `unsent` is where that request differs from the
 * recorded ballot — shown as "not sent yet", and sent only when the voter
 * submits again.
 */
export function editorStart(recorded: readonly number[], requested: readonly number[] | null): { selected: number[]; unsent: number[] } {
  if (requested === null) return { selected: normalizeChoices(recorded), unsent: [] }
  const { added, removed } = choiceDelta(recorded, requested)
  return { selected: normalizeChoices(requested), unsent: normalizeChoices([...added, ...removed]) }
}

/** What changed between two selections: the choices `next` adds and the ones it drops. */
export function choiceDelta(previous: readonly number[], next: readonly number[]): { added: number[]; removed: number[] } {
  const before = new Set(previous)
  const after = new Set(next)
  return {
    added: normalizeChoices(next.filter((choice) => !before.has(choice))),
    removed: normalizeChoices(previous.filter((choice) => !after.has(choice))),
  }
}

/**
 * The one write that takes a voter from `ballot` to selecting exactly
 * `wanted`, or null when none is needed. The first pick creates the ballot;
 * after that every change replaces it, and withdrawing replaces it without
 * choices. Ballots are never deleted, so a withdrawn one is replaced again on
 * a later pick rather than created twice.
 *
 * `wanted` must already be normalized; a single-choice `wanted` holds at most one.
 */
export function planBallotWrite(ballot: Ballot | null, wanted: readonly number[]): BallotWrite | null {
  const choices = normalizeChoices(wanted)
  if (!ballot) return choices.length === 0 ? null : { kind: 'create', choices }
  return sameChoices(ballot.choices, choices) ? null : { kind: 'replace', ballot, choices }
}

// ---- Tallies --------------------------------------------------------------------

/**
 * The choice a grouped-count key names, or null. Keys are the hex of the
 * index-encoded integer: plain big-endian bytes on PV14 (5.0.0-beta.5,
 * `00`..`09`), the top bit flipped before it (`80`..`89`, testnet). Both
 * decode, since a choice is always below 0x80.
 */
export function decodeChoiceKey(key: string): number | null {
  if (!/^[0-9a-f]{2}$/i.test(key)) return null
  const byte = parseInt(key, 16)
  const choice = byte >= 0x80 ? byte - 0x80 : byte
  return isChoiceIndex(choice) ? choice : null
}

export function sumCounts(counts: readonly number[]): number {
  return counts.reduce((sum, count) => sum + count, 0)
}

/**
 * Fold a voter's change into per-option counts: +1 for each added choice, -1
 * for each removed one (never below zero). The total is re-summed.
 */
export function applyChoiceDelta(counts: readonly number[], added: readonly number[], removed: readonly number[]): { counts: number[]; total: number } {
  const next = [...counts]
  for (const choice of added) {
    if (choice >= 0 && choice < next.length) next[choice] += 1
  }
  for (const choice of removed) {
    if (choice >= 0 && choice < next.length) next[choice] = Math.max(0, next[choice] - 1)
  }
  return { counts: next, total: sumCounts(next) }
}
