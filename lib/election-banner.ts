/**
 * What the app-wide moderator election banner says. Pure (unit-tested).
 *
 * Until a contract's first moderation team is seated, a `notYetUsable`
 * interim keeps its moderated writes closed: posting on social, blogs on
 * blog, stores on storefront. The banner names the phase each pending
 * election is in, from the same stage the Moderation teams page shows
 * (`electionStage` in lib/moderation-charters/team-flow.ts), and where to go.
 */
import type { ModeratedContractKey } from '@/lib/moderated-contracts'
import type { ElectionStage } from '@/lib/moderation-charters/team-flow'

/** Where a pending election stands, as the banner says it. */
export type BannerPhase =
  /** Nobody has applied. `opensAtMs`: applications open then (the election delay), else they already can. */
  | { kind: 'waiting'; opensAtMs: number | null }
  /** Teams are applying until `untilMs`; with two or more applicants masternodes then vote. */
  | { kind: 'applications'; untilMs: number; applicants: number }
  /** Masternodes vote until `untilMs` (null when the end could not be read). */
  | { kind: 'voting'; untilMs: number | null }
  /** The contest is over (or a sole applicant's window closed); the team is seated with the next block. */
  | { kind: 'deciding' }

export interface PendingElection {
  contract: ModeratedContractKey
  phase: BannerPhase
}

/**
 * The banner's phase for an election stage at `nowMs` (chain time); null when
 * there is nothing to announce (seated, or a read failed). A vote whose end
 * has passed is deciding: the stage only learns of the winner on a re-read.
 */
export function bannerPhase(stage: ElectionStage, nowMs: number): BannerPhase | null {
  switch (stage.kind) {
    case 'not-open':
      return { kind: 'waiting', opensAtMs: stage.opensAtMs }
    case 'open':
      return { kind: 'waiting', opensAtMs: null }
    case 'joining':
      return { kind: 'applications', untilMs: stage.joinClosesAtMs, applicants: stage.contenders }
    case 'voting':
      return stage.votingEndsAtMs !== null && stage.votingEndsAtMs <= nowMs ? { kind: 'deciding' } : { kind: 'voting', untilMs: stage.votingEndsAtMs }
    case 'deciding':
      return { kind: 'deciding' }
    default:
      return null
  }
}

/** The order contracts are named in, and how: "Social, Blogs and Stores". */
const ORDER: readonly ModeratedContractKey[] = ['social', 'blog', 'storefront']
const NAME: Record<ModeratedContractKey, string> = { social: 'Social', blog: 'Blogs', storefront: 'Stores' }
/** What a seated team opens on each contract. */
const OPENS: Record<ModeratedContractKey, string> = { social: 'Posting opens', blog: 'Blogs open', storefront: 'Stores open' }
/** Which phase the links lead to when several elections are pending: where there is most to see or do. */
const PRIORITY: Record<BannerPhase['kind'], number> = { voting: 0, applications: 1, waiting: 2, deciding: 3 }

/** A local date and time, short: "Oct 23, 9:22 PM". */
export function formatBannerTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

/** The phase as a clause, lower-case and without a full stop. */
function phaseClause(phase: BannerPhase, formatTime: (ms: number) => string): string {
  switch (phase.kind) {
    case 'waiting':
      return phase.opensAtMs === null ? 'waiting for a team to apply' : `teams can apply from ${formatTime(phase.opensAtMs)}`
    case 'applications':
      return `applications close ${formatTime(phase.untilMs)}`
    case 'voting':
      return phase.untilMs === null ? 'masternodes are voting' : `masternodes are voting until ${formatTime(phase.untilMs)}`
    case 'deciding':
      return 'the new team starts shortly'
  }
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

/** "A", "A and B", "A, B and C". */
function listNames(names: readonly string[]): string {
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

export interface ElectionBannerContent {
  headline: string
  detail: string
  /** The contract whose Moderation teams tab the main link opens. */
  teamsContract: ModeratedContractKey
  /** The contract whose masternode vote "See the vote" opens; null unless masternodes vote (or will: two or more applicants). */
  voteContract: ModeratedContractKey | null
  /** Changes whenever a phase does: a dismissal holds only while it is unchanged. */
  signature: string
}

/** The date a phase counts down to, if it has one. */
function phaseDate(phase: BannerPhase): number | null {
  switch (phase.kind) {
    case 'waiting':
      return phase.opensAtMs
    case 'applications':
    case 'voting':
      return phase.untilMs
    case 'deciding':
      return null
  }
}

/** One election names what it keeps closed and its phase; several are summed up, contracts in the same phase named together. */
function summarize(sorted: readonly PendingElection[], formatTime: (ms: number) => string): Pick<ElectionBannerContent, 'headline' | 'detail'> {
  if (sorted.length === 1) {
    const { contract, phase } = sorted[0]
    return {
      headline: `${OPENS[contract]} once moderators are elected`,
      detail: `${capitalize(phaseClause(phase, formatTime))}.`,
    }
  }
  const groups = new Map<string, string[]>()
  for (const { contract, phase } of sorted) {
    const clause = phaseClause(phase, formatTime)
    groups.set(clause, [...(groups.get(clause) ?? []), NAME[contract]])
  }
  const detail = groups.size === 1
    ? `${capitalize([...groups.keys()][0])}.`
    : [...groups].map(([clause, names]) => `${listNames(names)}: ${clause}.`).join(' ')
  return {
    headline: `${listNames(sorted.map(({ contract }) => NAME[contract]))}: moderator elections in progress`,
    detail,
  }
}

/** The banner for the pending elections, or null when none is pending. */
export function electionBanner(pending: readonly PendingElection[], formatTime: (ms: number) => string = formatBannerTime): ElectionBannerContent | null {
  const sorted = ORDER.flatMap((contract) => pending.filter((entry) => entry.contract === contract).slice(0, 1))
  if (sorted.length === 0) return null
  const lead = sorted.reduce((best, entry) => (PRIORITY[entry.phase.kind] < PRIORITY[best.phase.kind] ? entry : best))
  return {
    ...summarize(sorted, formatTime),
    teamsContract: lead.contract,
    voteContract: lead.phase.kind === 'voting' || (lead.phase.kind === 'applications' && lead.phase.applicants > 1) ? lead.contract : null,
    signature: sorted.map(({ contract, phase }) => [contract, phase.kind, phaseDate(phase)].join(':')).join('|'),
  }
}

/** How long remembered elections may paint the banner before the chain confirms them. */
export const ELECTIONS_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000

const CONTRACTS = new Set<string>(ORDER)

function validPhase(value: unknown, nowMs: number): BannerPhase | null {
  if (typeof value !== 'object' || value === null) return null
  const { kind, untilMs, opensAtMs } = value as Record<string, unknown>
  const future = (ms: unknown): ms is number => typeof ms === 'number' && Number.isFinite(ms) && ms > nowMs
  switch (kind) {
    case 'waiting':
      return { kind, opensAtMs: future(opensAtMs) ? opensAtMs : null }
    case 'applications': {
      // A remembered deadline that has passed says nothing about what came next.
      const { applicants } = value as { applicants?: unknown }
      return future(untilMs) && typeof applicants === 'number' && applicants > 0 ? { kind, untilMs, applicants } : null
    }
    case 'voting':
      return untilMs === null || future(untilMs) ? { kind, untilMs } : null
    case 'deciding':
      return { kind }
    default:
      return null
  }
}

/**
 * The remembered pending elections, as stored; null when there is nothing
 * fit to show (too old, unreadable, or every deadline in it has passed).
 */
export function parseCachedElections(raw: string | null, nowMs: number): PendingElection[] | null {
  if (!raw) return null
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null) return null
    const { savedAt, pending } = value as { savedAt?: unknown; pending?: unknown }
    if (typeof savedAt !== 'number' || nowMs < savedAt || nowMs - savedAt > ELECTIONS_CACHE_MAX_AGE_MS || !Array.isArray(pending)) return null
    const entries = pending.flatMap((entry: unknown): PendingElection[] => {
      const { contract, phase } = (entry ?? {}) as { contract?: unknown; phase?: unknown }
      const valid = typeof contract === 'string' && CONTRACTS.has(contract) ? validPhase(phase, nowMs) : null
      return valid ? [{ contract: contract as ModeratedContractKey, phase: valid }] : []
    })
    return entries.length > 0 ? entries : null
  } catch {
    return null
  }
}

/** The pending elections in the form {@link parseCachedElections} reads back. */
export function serializeElections(pending: readonly PendingElection[], nowMs: number): string {
  return JSON.stringify({ savedAt: nowMs, pending })
}
