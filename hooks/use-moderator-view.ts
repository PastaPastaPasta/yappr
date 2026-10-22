'use client'

import { create } from 'zustand'
import { cacheManager } from '@/lib/cache-manager'
import { logger } from '@/lib/logger'
import { MODERATED_CONTRACTS, moderatedContract, type ModeratedContractKey } from '@/lib/moderated-contracts'
import { moderatorViewScope, setModeratorViewContracts } from '@/lib/moderation-view'
import { moderationServiceFor } from '@/lib/services/moderation-service'
import { scopedKey } from '@/lib/storage-scope'

/**
 * The moderator view: "Show hidden & restricted", for verified members of a
 * contract's seated team only (lib/moderation-view.ts).
 *
 * The switch is kept per identity for this tab (sessionStorage), off by
 * default. Whatever it says, the view covers only the contracts whose seated
 * team the signed-in identity was read on, and nothing for anyone else.
 * Whenever what it covers changes, every cache that kept or dropped hidden
 * items forgets them and the page under the app shell is mounted afresh
 * (`generation`), so each listing reads again with or without every lane.
 */

const TOGGLE_KEY = 'yappr_moderator_view'

const toggleKey = (identityId: string) => scopedKey(`${TOGGLE_KEY}:${identityId}`)

function readToggle(identityId: string | null): boolean {
  if (!identityId || typeof window === 'undefined') return false
  try {
    return sessionStorage.getItem(toggleKey(identityId)) === '1'
  } catch {
    return false
  }
}

function writeToggle(identityId: string, on: boolean): void {
  try {
    if (on) sessionStorage.setItem(toggleKey(identityId), '1')
    else sessionStorage.removeItem(toggleKey(identityId))
  } catch {
    // Storage blocked: the switch holds until the page is reloaded.
  }
}

/**
 * The contracts `identityId` sits on the seated team of, among those whose
 * listings carry moderation lanes (social v18, blog v10, storefront v11).
 * Read off the chain; a contract whose team cannot be read is left out.
 */
export async function seatedModeratorContracts(identityId: string): Promise<ModeratedContractKey[]> {
  const laned = MODERATED_CONTRACTS.filter((key) => moderatedContract(key).hidesInsteadOfDeleting())
  const seats = await Promise.all(laned.map((key) => moderationServiceFor(key).isSeatedMember(identityId)))
  return laned.filter((_, index) => seats[index])
}

interface ModeratorViewState {
  /** The signed-in identity, or null. */
  viewer: string | null
  /** Whose seats `seated` lists: the viewer once they have been read. */
  seatedFor: string | null
  seated: ModeratedContractKey[]
  /** The switch, as the viewer left it in this tab. */
  enabled: boolean
  /** Bumped whenever the contracts the view covers change. */
  generation: number
  setViewer: (viewer: string | null) => void
  setSeated: (identityId: string, seated: ModeratedContractKey[]) => void
  setEnabled: (on: boolean) => void
}

/** Applies a new state's scope to the reads; a change clears the caches and remounts the page. */
function applied(state: ModeratorViewState, next: Partial<ModeratorViewState>): Partial<ModeratorViewState> {
  const merged = { ...state, ...next }
  if (!setModeratorViewContracts(moderatorViewScope(merged))) return next
  cacheManager.clearAll()
  return { ...next, generation: state.generation + 1 }
}

export const useModeratorViewStore = create<ModeratorViewState>((set) => ({
  viewer: null,
  seatedFor: null,
  seated: [],
  enabled: false,
  generation: 0,
  setViewer: (viewer) => set((state) => (state.viewer === viewer ? {} : applied(state, { viewer, seatedFor: null, seated: [], enabled: readToggle(viewer) }))),
  setSeated: (identityId, seated) => set((state) => (state.viewer === identityId ? applied(state, { seatedFor: identityId, seated }) : {})),
  setEnabled: (on) => set((state) => {
    if (!state.viewer || state.seatedFor !== state.viewer || state.seated.length === 0) return {}
    writeToggle(state.viewer, on)
    return applied(state, { enabled: on })
  }),
}))

/** Reads the signed-in identity's seats whenever it changes. */
export function syncModeratorViewer(identityId: string | null): () => void {
  useModeratorViewStore.getState().setViewer(identityId)
  if (!identityId) return () => {}
  let cancelled = false
  seatedModeratorContracts(identityId).catch((error: unknown): ModeratedContractKey[] => {
    logger.warn('Moderator view: could not read the seated teams', error)
    return []
  }).then((seated) => {
    if (!cancelled) useModeratorViewStore.getState().setSeated(identityId, seated)
  }).catch((error: unknown) => logger.error('Moderator view: could not apply the seated teams', error))
  return () => {
    cancelled = true
  }
}

const NONE: readonly ModeratedContractKey[] = []

/** What the moderator view's controls need: the viewer's seated contracts, and whether the view is on. */
export function useModeratorView(): {
  /** The contracts the viewer is a verified seated moderator of; empty for everyone else. */
  seated: readonly ModeratedContractKey[]
  /** True while the view is on (it then covers every contract in `seated`). */
  active: boolean
  /** True while the signed-in identity's seats are being read. */
  checking: boolean
  setEnabled: (on: boolean) => void
} {
  const viewer = useModeratorViewStore((state) => state.viewer)
  const seatedFor = useModeratorViewStore((state) => state.seatedFor)
  const seated = useModeratorViewStore((state) => state.seated)
  const enabled = useModeratorViewStore((state) => state.enabled)
  const setEnabled = useModeratorViewStore((state) => state.setEnabled)
  const verified = viewer !== null && seatedFor === viewer ? seated : NONE
  return { seated: verified, active: enabled && verified.length > 0, checking: viewer !== null && seatedFor !== viewer, setEnabled }
}

/** True when the viewer is a verified seated moderator of `contract`. */
export function useIsSeatedModerator(contract: ModeratedContractKey): boolean {
  return useModeratorView().seated.includes(contract)
}
