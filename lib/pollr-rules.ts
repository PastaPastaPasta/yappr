/**
 * Pure rules for Pollr polls and ballots: what each contract topology accepts,
 * how long a poll may stay open, and how a voter's wanted choices turn into
 * ballot writes. No SDK, no network — the services and the poll editor call in.
 */

export type PollrTopology = 'v3' | 'v4' | 'v5' | 'v6'

export const POLL_MIN_OPTIONS = 2
export const POLL_MAX_OPTIONS = 10

const DAY_MS = 24 * 60 * 60 * 1000

/** v5's `endsWithin31Days`: a poll closes at most 31 days after `$createdAt`. */
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

/** What each topology's `poll` schema accepts (v6 keeps v5's poll). */
export function pollLimits(topology: PollrTopology): PollLimits {
  if (topology === 'v5' || topology === 'v6') {
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

// ---- Ballots (v5) -------------------------------------------------------------

/**
 * One of a voter's v5 ballots. A single-choice poll has at most one (slot 0); a
 * multi-choice poll one per option ever ticked (slot = option). `choice` is
 * null when the ballot was withdrawn or the option unticked.
 */
export interface Ballot {
  id: string
  revision: number
  slot: number
  choice: number | null
}

export type BallotWrite =
  | { kind: 'create'; slot: number; choice: number }
  | { kind: 'replace'; ballot: Ballot; choice: number | null }

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

/** The choices a voter's ballots currently select. */
export function recordedChoices(ballots: readonly Ballot[]): number[] {
  return normalizeChoices(ballots.flatMap((ballot) => (ballot.choice === null ? [] : [ballot.choice])))
}

export function sameChoices(a: readonly number[], b: readonly number[]): boolean {
  const left = normalizeChoices(a)
  const right = normalizeChoices(b)
  return left.length === right.length && left.every((choice, index) => choice === right[index])
}

/**
 * Where the ballot editor starts. Normally from the recorded choices; after a
 * submission that was not fully confirmed, from what the voter last asked for,
 * since part of it may never have been sent. `unsent` is where that request
 * differs from the recorded ballots — shown as "not sent yet", and sent only
 * when the voter submits again.
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
 * The writes that take a voter from `ballots` to selecting exactly `wanted`.
 *
 * Single choice: create the one ballot (slot 0) if there is none, otherwise
 * replace its `choice` — or drop it, to withdraw. Multi choice: each option is
 * its own ballot (slot = option), created the first time it is ticked and
 * replaced with `choice` set or dropped after that. Ballots are never deleted,
 * so an unticked option keeps its ballot and a later tick replaces it.
 *
 * `wanted` must already be normalized; a single-choice `wanted` holds at most one.
 */
export function planBallotWrites(multiChoice: boolean, ballots: readonly Ballot[], wanted: readonly number[]): BallotWrite[] {
  if (!multiChoice) {
    const choice = wanted[0] ?? null
    const ballot = ballots.find((entry) => entry.slot === 0)
    if (!ballot) return choice === null ? [] : [{ kind: 'create', slot: 0, choice }]
    return ballot.choice === choice ? [] : [{ kind: 'replace', ballot, choice }]
  }

  const bySlot = new Map(ballots.map((ballot) => [ballot.slot, ballot]))
  const writes: BallotWrite[] = []
  const slots = normalizeChoices([...bySlot.keys(), ...wanted])
  for (const slot of slots) {
    const ballot = bySlot.get(slot)
    const want = wanted.includes(slot)
    if (!ballot) {
      if (want) writes.push({ kind: 'create', slot, choice: slot })
    } else if (want !== (ballot.choice !== null)) {
      writes.push({ kind: 'replace', ballot, choice: want ? slot : null })
    }
  }
  return writes
}

// ---- Tallies --------------------------------------------------------------------

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
