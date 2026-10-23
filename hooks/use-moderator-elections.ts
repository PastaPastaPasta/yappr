'use client'

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useSdk } from '@/contexts/sdk-context'
import {
  bannerPhase,
  mergeElectionAnswers,
  parseCachedElections,
  pendingElections,
  serializeElections,
  type BannerPhase,
  type ElectionAnswer,
  type ElectionSource,
  type PendingElection,
} from '@/lib/election-banner'
import { logger } from '@/lib/logger'
import { moderatedContract, type ModeratedContractKey } from '@/lib/moderated-contracts'
import { watchModeratedTypeOpen } from '@/lib/moderated-type-gate'
import { electedContracts } from '@/lib/moderation-charters/links'
import { chainOffsetMs, electionStage } from '@/lib/moderation-charters/team-flow'
import { readScoped, removeScoped, writeScoped } from '@/lib/storage-scope'
import { moderationElectionService, type ElectionStatus } from '@/lib/services/moderation-election-service'
import { moderationServiceFor } from '@/lib/services/moderation-service'

const CACHE_KEY = 'moderator-elections'
/**
 * The election status is several reads per contract, so the app shares one
 * answer per contract for this long. Phases move on with the clock in
 * between; a seat shows sooner, through the team read.
 */
const STATUS_SHARE_MS = 5 * 60_000
/** How often a closed contract's team is re-read while the tab is visible (a hidden tab reads nothing). */
const RECHECK_MS = 2 * 60_000
/** How often a shown phase is re-derived from the clock (a deadline passing moves it on). */
const TICK_MS = 30_000

/** A contract still waiting for its first team: its election, and how far chain time was from this clock when read. */
interface ClosedElection {
  status: ElectionStatus
  offsetMs: number
}

type Sources = ReadonlyMap<ModeratedContractKey, ElectionSource<ClosedElection>>

/**
 * The contracts this build elects moderators for (from the committed cut;
 * legacy and older topologies have none, and never read). Whether one is
 * still closed is the registered contract's answer: the registered interim
 * may differ from the file's.
 */
const CANDIDATES: readonly ModeratedContractKey[] = electedContracts()

/**
 * Remembers that every candidate has its team, keyed by their contract ids:
 * a seat is never lifted, so a repeat visit knows at once there is no banner.
 * It only shapes the layout; the reads still run.
 */
const ALL_OPEN_KEY = 'moderator-elections-all-open'
const CANDIDATE_IDS = CANDIDATES.map((contract) => moderatedContract(contract).contractId).join(',')

const EMPTY: Sources = new Map()
let sources: Sources = EMPTY
/** Whether this tab knows if a banner is due: nothing to elect, every team remembered seated, a remembered answer, or a finished read. */
let answered = CANDIDATES.length === 0 || readScoped(ALL_OPEN_KEY) === CANDIDATE_IDS
const listeners = new Set<() => void>()
/** Contracts read open (a team is seated): a seat is never lifted, so they are not read again. */
const settledOpen = new Set<ModeratedContractKey>()
const statusReads = new Map<ModeratedContractKey, { at: number; answer: Promise<ClosedElection> }>()
/** Bumped by every read cycle: a cycle that settles after a newer one started publishes nothing. */
let generation = 0
let watchers = 0
let stopWatching: (() => void) | null = null

function publish(next: Sources) {
  sources = next
  answered = true
  for (const listener of listeners) listener()
}

function livePhase({ status, offsetMs }: ClosedElection, nowMs: number): BannerPhase | null {
  const chainNow = nowMs + offsetMs
  return bannerPhase(electionStage(status, chainNow), chainNow)
}

const sameSources = (a: Sources, b: Sources) =>
  a.size === b.size && [...b].every(([contract, source]) => {
    const before = a.get(contract)
    if (!before) return false
    if ('live' in source) return 'live' in before && before.live === source.live
    return 'remembered' in before && before.remembered === source.remembered
  })

/**
 * The election of a closed contract, shared for {@link STATUS_SHARE_MS}. A
 * status that cannot place the election (a part of it failed to read) is a
 * failed read: it is neither shared nor shown, and the last answer stands.
 */
function loadStatus(contract: ModeratedContractKey): Promise<ClosedElection> {
  const shared = statusReads.get(contract)
  if (shared && Date.now() - shared.at < STATUS_SHARE_MS) return shared.answer
  const entry = {
    at: Date.now(),
    answer: moderationElectionService.getStatus(moderatedContract(contract).contractId).then((status) => {
      if (!status) throw new Error('the contract does not elect its moderators')
      const election = { status, offsetMs: chainOffsetMs(status) }
      if (!status.seated && livePhase(election, Date.now()) === null) throw new Error(`incomplete read (${status.failures.join(', ')})`)
      return election
    }),
  }
  statusReads.set(contract, entry)
  entry.answer.catch(() => {
    if (statusReads.get(contract) === entry) statusReads.delete(contract)
  })
  return entry.answer
}

/** One contract: open (nothing to announce), its election, or a failed read. One cheap, cached team read first. */
async function readContract(contract: ModeratedContractKey): Promise<ElectionAnswer<ClosedElection>> {
  try {
    const docType = Object.keys(moderatedContract(contract).elected()?.moderatedDocumentTypes ?? {})[0]
    if (!docType || await moderationServiceFor(contract).moderatedTypeOpen(docType)) return 'open'
    const election = await loadStatus(contract)
    return election.status.seated ? 'open' : election
  } catch (error) {
    logger.warn(`Moderator elections: the ${contract} election could not be read`, error)
    return 'failed'
  }
}

/**
 * Reads every contract still closed; true once all are open. A contract whose
 * read failed keeps its last answer (or what was remembered); the cache is
 * rewritten only after a cycle in which every read succeeded. A hidden tab
 * reads nothing: showing it again re-checks at once.
 */
async function readElections(): Promise<boolean> {
  const contracts = CANDIDATES.filter((contract) => !settledOpen.has(contract))
  if (contracts.length === 0) return true
  if (typeof document !== 'undefined' && document.hidden) return false
  const mine = ++generation
  const results = await Promise.all(contracts.map(readContract))
  results.forEach((answer, index) => {
    if (answer === 'open') settledOpen.add(contracts[index])
  })
  const allOpen = CANDIDATES.every((contract) => settledOpen.has(contract))
  if (allOpen) writeScoped(ALL_OPEN_KEY, CANDIDATE_IDS)
  if (mine !== generation) return allOpen
  const answers = new Map(contracts.map((contract, index) => [contract, results[index]]))
  const next = mergeElectionAnswers(CANDIDATES, answers, sources, settledOpen)
  if (!results.includes('failed')) {
    const pending = pendingElections(next, Date.now(), livePhase)
    if (pending.length > 0) writeScoped(CACHE_KEY, serializeElections(pending, Date.now()))
    else removeScoped(CACHE_KEY)
  }
  // The first finished cycle answers even when nothing changed (or a read failed).
  if (!answered || !sameSources(sources, next)) publish(next)
  return allOpen
}

function watch(): () => void {
  watchers += 1
  if (watchers === 1) {
    stopWatching = watchModeratedTypeOpen(readElections, () => undefined, { intervalMs: RECHECK_MS, targets: [window, document] })
  }
  return () => {
    watchers -= 1
    if (watchers === 0) {
      stopWatching?.()
      stopWatching = null
    }
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const getSnapshot = () => sources
const getServerSnapshot = () => EMPTY

/** Paints what was remembered, then keeps the shared read going while mounted. */
function useElectionsRead() {
  const { isReady: sdkReady } = useSdk()

  useEffect(() => {
    if (CANDIDATES.length === 0 || sources !== EMPTY) return
    const cached = parseCachedElections(readScoped(CACHE_KEY), Date.now())
    if (cached) publish(new Map(cached.map(({ contract, phase }) => [contract, { remembered: phase }])))
  }, [])

  useEffect(() => {
    if (CANDIDATES.length === 0 || !sdkReady) return
    return watch()
  }, [sdkReady])
}

/**
 * The moderator elections still pending, each with its phase now, or null
 * while there is nothing to say: no contract of this build elects its
 * moderators, every one has its team, or the elections are not read yet (or
 * could not be). One shared read serves every caller and keeps asking while
 * any contract is closed (every two minutes while the tab is visible, and
 * when it is shown or focused again).
 *
 * The last answer is remembered for a day and painted on mount, so a repeat
 * visit shows the banner in its first frame; the chain then confirms it, or
 * lifts it once a team is seated.
 */
export function useModeratorElections(): readonly PendingElection[] | null {
  useElectionsRead()
  const current = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  const [now, setNow] = useState(() => Date.now())

  const ticking = current.size > 0
  useEffect(() => {
    if (!ticking) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(timer)
  }, [ticking])

  return useMemo(() => {
    const pending = pendingElections(current, now, livePhase)
    return pending.length > 0 ? pending : null
  }, [current, now])
}

/**
 * Whether this tab knows yet if an election banner is due (see `answered`).
 * Until it does, a layout can hold the banner's room so the answer does not
 * move the page. Read beside {@link useModeratorElections}, which runs the read.
 */
export function useElectionsAnswered(): boolean {
  return useSyncExternalStore(subscribe, () => answered, () => CANDIDATES.length === 0)
}

/**
 * Whether posting is closed right now (social still waits for its first
 * team), through the same shared read. False while it is not known, so a
 * page never claims a closure the chain has not confirmed. Empty states use
 * it to stop inviting posts. It changes only when the answer does.
 */
export function usePostingClosed(): boolean {
  useElectionsRead()
  return useSyncExternalStore(subscribe, () => sources.has('social'), () => false)
}
