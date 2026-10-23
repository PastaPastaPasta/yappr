'use client'

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useSdk } from '@/contexts/sdk-context'
import { bannerPhase, parseCachedElections, serializeElections, type PendingElection } from '@/lib/election-banner'
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
/** How often a shown phase is re-derived from the clock (a deadline passing moves it on). */
const TICK_MS = 30_000

/** A contract still waiting for its first team: its election, and how far chain time was from this clock when read. */
interface ClosedElection {
  contract: ModeratedContractKey
  status: ElectionStatus
  offsetMs: number
}

interface Snapshot {
  /** Read from the chain; null until every contract has answered once (or nothing was remembered). */
  live: readonly ClosedElection[] | null
  /** Remembered from an earlier visit, shown until the chain answers. */
  remembered: readonly PendingElection[] | null
}

/**
 * The contracts this build elects moderators for (from the committed cut;
 * legacy and older topologies have none, and never read). Whether one is
 * still closed is the registered contract's answer: the registered interim
 * may differ from the file's.
 */
const CANDIDATES: readonly ModeratedContractKey[] = electedContracts()

const EMPTY: Snapshot = { live: null, remembered: null }
let snapshot: Snapshot = EMPTY
const listeners = new Set<() => void>()
/** Contracts read open (a team is seated): a seat is never lifted, so they are not read again. */
const settledOpen = new Set<ModeratedContractKey>()
const statusReads = new Map<ModeratedContractKey, { at: number; answer: Promise<ClosedElection> }>()
let watchers = 0
let stopWatching: (() => void) | null = null

function publish(next: Snapshot) {
  snapshot = next
  for (const listener of listeners) listener()
}

function phaseOf({ status, offsetMs }: ClosedElection, nowMs: number) {
  const chainNow = nowMs + offsetMs
  return bannerPhase(electionStage(status, chainNow), chainNow)
}

function pendingAt(closed: readonly ClosedElection[], nowMs: number): PendingElection[] {
  return closed.flatMap((election) => {
    const phase = phaseOf(election, nowMs)
    return phase ? [{ contract: election.contract, phase }] : []
  })
}

const sameLive = (a: readonly ClosedElection[] | null, b: readonly ClosedElection[]) =>
  a !== null && a.length === b.length && a.every((entry, index) => entry.status === b[index].status && entry.offsetMs === b[index].offsetMs)

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
      const election = { contract, status, offsetMs: chainOffsetMs(status) }
      if (!status.seated && phaseOf(election, Date.now()) === null) throw new Error(`incomplete read (${status.failures.join(', ')})`)
      return election
    }),
  }
  statusReads.set(contract, entry)
  entry.answer.catch(() => {
    if (statusReads.get(contract) === entry) statusReads.delete(contract)
  })
  return entry.answer
}

/** One contract: open (nothing to announce) or its election. One cheap, cached team read first. */
async function readContract(contract: ModeratedContractKey): Promise<ClosedElection | 'open'> {
  const docType = Object.keys(moderatedContract(contract).elected()?.moderatedDocumentTypes ?? {})[0]
  if (!docType || await moderationServiceFor(contract).moderatedTypeOpen(docType)) return 'open'
  const election = await loadStatus(contract)
  return election.status.seated ? 'open' : election
}

/**
 * Reads every contract still closed; true once all are open. A contract whose
 * read failed keeps its last answer; before the first full answer, what was
 * remembered stays up rather than a partial one.
 */
async function readElections(): Promise<boolean> {
  const contracts = CANDIDATES.filter((contract) => !settledOpen.has(contract))
  const results = await Promise.allSettled(contracts.map(readContract))
  let failed = false
  const live = contracts.flatMap((contract, index): ClosedElection[] => {
    const result = results[index]
    if (result.status === 'rejected') {
      failed = true
      logger.warn(`Moderator elections: the ${contract} election could not be read`, result.reason)
      return (snapshot.live ?? []).filter((entry) => entry.contract === contract)
    }
    if (result.value === 'open') {
      settledOpen.add(contract)
      return []
    }
    return [result.value]
  })
  const allOpen = contracts.every((contract) => settledOpen.has(contract))
  if (failed && snapshot.live === null && snapshot.remembered !== null) return allOpen
  if (!failed) {
    const pending = pendingAt(live, Date.now())
    if (pending.length > 0) writeScoped(CACHE_KEY, serializeElections(pending, Date.now()))
    else removeScoped(CACHE_KEY)
  }
  if (!sameLive(snapshot.live, live)) publish({ live, remembered: snapshot.remembered })
  return allOpen
}

function watch(): () => void {
  watchers += 1
  if (watchers === 1) {
    stopWatching = watchModeratedTypeOpen(readElections, () => undefined, { targets: [window, document] })
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

const getSnapshot = () => snapshot
const getServerSnapshot = () => EMPTY

/** Paints what was remembered, then keeps the shared read going while mounted. */
function useElectionsRead() {
  const { isReady: sdkReady } = useSdk()

  useEffect(() => {
    if (CANDIDATES.length === 0 || snapshot !== EMPTY) return
    const cached = parseCachedElections(readScoped(CACHE_KEY), Date.now())
    if (cached) publish({ live: null, remembered: cached })
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
 * could not be). One shared read serves every caller and keeps asking every
 * minute (and when the window regains focus) while any contract is closed.
 *
 * The last answer is remembered for a day and painted on mount, so a repeat
 * visit shows the banner in its first frame; the chain then confirms it, or
 * lifts it once a team is seated.
 */
export function useModeratorElections(): readonly PendingElection[] | null {
  useElectionsRead()
  const { live, remembered } = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  const [now, setNow] = useState(() => Date.now())

  const ticking = live !== null && live.length > 0
  useEffect(() => {
    if (!ticking) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(timer)
  }, [ticking])

  return useMemo(() => {
    const pending = live !== null ? pendingAt(live, now) : remembered
    return pending && pending.length > 0 ? pending : null
  }, [live, remembered, now])
}

/** Social is pending in `state`: a closed, readable election (no clock needed: every pre-seat phase is closed). */
function socialClosed(state: Snapshot): boolean {
  if (state.live === null) return state.remembered?.some((entry) => entry.contract === 'social') ?? false
  return state.live.some((entry) => entry.contract === 'social')
}

/**
 * Whether posting is closed right now (social still waits for its first
 * team), through the same shared read. False while it is not known, so a
 * page never claims a closure the chain has not confirmed. Empty states use
 * it to stop inviting posts. It changes only when the answer does.
 */
export function usePostingClosed(): boolean {
  useElectionsRead()
  return useSyncExternalStore(subscribe, () => socialClosed(snapshot), () => false)
}
