import { useEffect } from 'react'
import { create } from 'zustand'
import { logger } from '@/lib/logger'
import { isStarterGrantSettled, markStarterGrantSettled, type StarterClaimState } from '@/lib/starter-grant'
import { starterGrantAmount } from '@/lib/contract-topology'
import { tokenService } from '@/lib/services/token-service'

interface StarterClaimStore {
  /** Each identity's starter-grant claim state, as chain last answered it. */
  states: Record<string, StarterClaimState>
  /** The claim succeeded, or chain refused it as already claimed. */
  markClaimed: (identityId: string) => void
}

const useStarterClaimStore = create<StarterClaimStore>((set) => ({
  states: {},
  markClaimed: (identityId) => {
    markStarterGrantSettled(identityId)
    set((store) => ({ states: { ...store.states, [identityId]: 'claimed' } }))
  },
}))

const inFlight = new Set<string>()

async function readClaimState(identityId: string): Promise<void> {
  let state: StarterClaimState
  try {
    state = await tokenService.readStarterClaimState(identityId)
  } catch (error) {
    logger.warn('Starter grant: could not read the claim state; not offering a claim', error)
    state = 'unknown'
  } finally {
    inFlight.delete(identityId)
  }
  // A claim that landed while this read was under way stands.
  useStarterClaimStore.setState((store) => (store.states[identityId] === 'claimed'
    ? store
    : { states: { ...store.states, [identityId]: state } }))
}

/** Reads the claim state from chain, one read per identity at a time; an unknown answer is read again by the next caller. */
function load(identityId: string): void {
  const current = useStarterClaimStore.getState().states[identityId]
  if (current === 'claimed' || current === 'unclaimed' || inFlight.has(identityId)) return
  if (isStarterGrantSettled(identityId)) {
    useStarterClaimStore.getState().markClaimed(identityId)
    return
  }
  inFlight.add(identityId)
  readClaimState(identityId).catch((error: unknown) => logger.error('Starter grant: storing the claim state failed', error))
}

/**
 * `identityId`'s starter-grant claim state, read from chain (#740). It is
 * `unknown` until chain answers, and stays so if the read fails: nothing may
 * offer Claim then, since a refused claim still costs the user credits.
 */
export function useStarterClaimState(identityId: string | undefined): StarterClaimState {
  const state = useStarterClaimStore((store) => (identityId ? store.states[identityId] : undefined))
  useEffect(() => {
    if (identityId && starterGrantAmount() !== null) load(identityId)
  }, [identityId])
  return state ?? 'unknown'
}

/** Records a claim that landed (or that chain refused as already made). */
export function markStarterGrantClaimed(identityId: string): void {
  useStarterClaimStore.getState().markClaimed(identityId)
}
