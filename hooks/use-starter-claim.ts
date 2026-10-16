import { useEffect } from 'react'
import { create } from 'zustand'
import { logger } from '@/lib/logger'
import { isStarterGrantSettled, markStarterGrantSettled, type StarterClaimState } from '@/lib/starter-grant'
import { starterGrantAmount } from '@/lib/contract-topology'
import { tokenService } from '@/lib/services/token-service'

/** Each identity's starter-grant claim state, as chain last answered it. */
const useStarterClaimStore = create<{ states: Record<string, StarterClaimState> }>(() => ({ states: {} }))

function setClaimState(identityId: string, state: StarterClaimState): void {
  useStarterClaimStore.setState((store) => ({ states: { ...store.states, [identityId]: state } }))
}

/** Records a claim that landed (or that chain refused as already made), here and in this browser. */
export function markStarterGrantClaimed(identityId: string): void {
  markStarterGrantSettled(identityId)
  setClaimState(identityId, 'claimed')
}

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
  if (state === 'claimed') markStarterGrantClaimed(identityId)
  // A claim that landed while this read was under way stands.
  else if (useStarterClaimStore.getState().states[identityId] !== 'claimed') setClaimState(identityId, state)
}

/** Reads the claim state from chain, one read per identity at a time; an unknown answer is read again by the next caller. */
function load(identityId: string): void {
  const current = useStarterClaimStore.getState().states[identityId]
  if (current === 'claimed' || current === 'unclaimed' || inFlight.has(identityId)) return
  if (isStarterGrantSettled(identityId)) {
    setClaimState(identityId, 'claimed')
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
