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

const inFlight = new Map<string, Promise<StarterClaimState>>()

async function readClaimState(identityId: string): Promise<StarterClaimState> {
  let state: StarterClaimState
  try {
    state = await tokenService.readStarterClaimState(identityId)
  } catch (error) {
    logger.warn('Starter grant: could not read the claim state; not offering a claim', error)
    state = 'unknown'
  } finally {
    inFlight.delete(identityId)
  }
  if (state === 'claimed') {
    markStarterGrantClaimed(identityId)
    return state
  }
  // A claim that landed while this read was under way stands.
  if (useStarterClaimStore.getState().states[identityId] === 'claimed') return 'claimed'
  setClaimState(identityId, state)
  return state
}

/**
 * The claim state read from chain now, sharing a read already under way. A
 * claim this browser has seen (another tab included) answers without a read.
 */
export function refreshStarterClaimState(identityId: string): Promise<StarterClaimState> {
  if (isStarterGrantSettled(identityId)) {
    setClaimState(identityId, 'claimed')
    return Promise.resolve('claimed')
  }
  let read = inFlight.get(identityId)
  if (!read) {
    read = readClaimState(identityId)
    inFlight.set(identityId, read)
  }
  return read
}

/** Reads the claim state once per identity and page; an unknown answer is read again by the next caller. */
function load(identityId: string): void {
  const current = useStarterClaimStore.getState().states[identityId]
  if (current === 'claimed' || (current === 'unclaimed' && !isStarterGrantSettled(identityId))) return
  refreshStarterClaimState(identityId).catch((error: unknown) => logger.error('Starter grant: reading the claim state failed', error))
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
