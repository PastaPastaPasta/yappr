'use client'

import { create } from 'zustand'
import { clearStoreViewCaches } from '@/lib/caches/store-view-cache'
import { logger } from '@/lib/logger'
import { MODERATED_CONTRACTS, moderatedContract, type ModeratedContractKey } from '@/lib/moderated-contracts'
import {
  moderatorViewContracts,
  moderatorViewHolds,
  moderatorViewScope,
  setModeratorViewContracts,
  viewerChangeReloads,
} from '@/lib/moderation-view'
import { moderationServiceFor } from '@/lib/services/moderation-service'
import { scopedKey } from '@/lib/storage-scope'

/**
 * The moderator view: "Show hidden & restricted", for verified members of a
 * contract's seated team only (lib/moderation-view.ts).
 *
 * The switch is kept for this tab (sessionStorage), as the identity that
 * turned it on, off by default. The view is applied once per page load,
 * before the page mounts: while the switch is on, the page is held until the
 * session is restored and the identity's seats are read, and only then does
 * anything read. Every later change (turning it on or off, signing out of or
 * into a moderator session with it on) reloads the page. So no read or cache
 * ever spans a change of view, and nothing has to be invalidated in place.
 */

const TOGGLE_KEY = scopedKey('yappr_moderator_view')

/** The identity that turned the view on in this tab, or null. */
function readEnabledFor(): string | null {
  if (typeof window === 'undefined') return null
  try {
    return sessionStorage.getItem(TOGGLE_KEY)
  } catch {
    return null
  }
}

/** Saves the switch; false when storage is blocked (it could not outlive a reload). */
function writeEnabledFor(identityId: string | null): boolean {
  try {
    if (identityId) sessionStorage.setItem(TOGGLE_KEY, identityId)
    else sessionStorage.removeItem(TOGGLE_KEY)
    return true
  } catch {
    return false
  }
}

/** Starts the page over under the view now saved: the only way the view changes once the page has loaded. */
function reloadPage(): void {
  // Saved store views are kept per view, but an all-lane one has no business outliving the view.
  clearStoreViewCaches()
  window.location.reload()
}

/** How long to wait before each new try at a seat read that failed. */
const SEAT_RETRY_MS = [2_000, 8_000]

/**
 * Whether `identityId` sits on `key`'s seated team, read off the chain and
 * tried again on failure (a gateway timeout must not hide the controls from a
 * moderator for the session). False once every try failed.
 */
async function readSeat(key: ModeratedContractKey, identityId: string, cancelled: () => boolean): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await moderationServiceFor(key).isSeatedMember(identityId)
    } catch (error) {
      if (attempt >= SEAT_RETRY_MS.length || cancelled()) {
        logger.warn(`Moderator view: could not read the ${key} seated team`, error)
        return false
      }
      await new Promise((resolve) => setTimeout(resolve, SEAT_RETRY_MS[attempt]))
    }
  }
}

/**
 * The contracts `identityId` sits on the seated team of, among those whose
 * listings carry moderation lanes (social v18, blog v10, storefront v11).
 */
async function seatedModeratorContracts(identityId: string, cancelled: () => boolean): Promise<ModeratedContractKey[]> {
  const laned = MODERATED_CONTRACTS.filter((key) => moderatedContract(key).hidesInsteadOfDeleting())
  const seats = await Promise.all(laned.map((key) => readSeat(key, identityId, cancelled)))
  return laned.filter((_, index) => seats[index])
}

interface ModeratorViewState {
  /** True once the session was restored and its identity taken. */
  booted: boolean
  /** The signed-in identity, or null. */
  viewer: string | null
  /** The identity that turned the view on in this tab (sessionStorage), or null. */
  enabledFor: string | null
  /** Whose seats `seated` lists: the viewer once they have been read. */
  seatedFor: string | null
  seated: ModeratedContractKey[]
  /** The signed-in identity, restored or changed. */
  setViewer: (viewer: string | null) => void
  setSeated: (identityId: string, seated: ModeratedContractKey[]) => void
  setEnabled: (on: boolean) => void
  /** Gives up on a held page: turns the switch off and reloads without the view. */
  abandonHold: () => void
}

export const useModeratorViewStore = create<ModeratorViewState>((set, get) => ({
  booted: false,
  viewer: null,
  enabledFor: readEnabledFor(),
  seatedFor: null,
  seated: [],
  setViewer: (viewer) => {
    const state = get()
    if (state.booted && state.viewer === viewer) return
    if (state.booted && viewerChangeReloads({ activeContracts: moderatorViewContracts().size, enabledFor: state.enabledFor, nextViewer: viewer })) {
      reloadPage()
      return
    }
    set({ booted: true, viewer, seatedFor: null, seated: [] })
  },
  setSeated: (identityId, seated) => {
    const state = get()
    if (state.viewer !== identityId) return
    // The page is still held for an identity that turned the view on: apply the view before it mounts.
    if (moderatorViewHolds(state)) {
      setModeratorViewContracts(moderatorViewScope({ viewer: identityId, seatedFor: identityId, seated, enabled: state.enabledFor === identityId }))
      // No seat (unseated since, or unreadable): forget the switch, or every load in this tab would wait on it.
      if (seated.length === 0 && writeEnabledFor(null)) {
        set({ seatedFor: identityId, seated, enabledFor: null })
        return
      }
    }
    set({ seatedFor: identityId, seated })
  },
  setEnabled: (on) => {
    const state = get()
    if (!state.viewer || state.seatedFor !== state.viewer || state.seated.length === 0) return
    if (!writeEnabledFor(on ? state.viewer : null)) {
      logger.warn('Moderator view: the switch cannot be saved in this browser, so it stays as it is')
      return
    }
    reloadPage()
  },
  abandonHold: () => {
    writeEnabledFor(null)
    reloadPage()
  },
}))

/** Takes the restored or changed identity and reads its seats. Call once the session restore has finished. */
export function syncModeratorViewer(identityId: string | null): () => void {
  useModeratorViewStore.getState().setViewer(identityId)
  if (!identityId || useModeratorViewStore.getState().viewer !== identityId) return () => {}
  let cancelled = false
  seatedModeratorContracts(identityId, () => cancelled).then((seated) => {
    if (!cancelled) useModeratorViewStore.getState().setSeated(identityId, seated)
  }).catch((error: unknown) => logger.error('Moderator view: could not apply the seated teams', error))
  return () => {
    cancelled = true
  }
}

/** True while the page must wait for the moderator view to be applied. */
export function useModeratorViewHolding(): boolean {
  return useModeratorViewStore(moderatorViewHolds)
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
  /** Saves the switch and reloads the page under it. */
  setEnabled: (on: boolean) => void
} {
  const booted = useModeratorViewStore((state) => state.booted)
  const viewer = useModeratorViewStore((state) => state.viewer)
  const seatedFor = useModeratorViewStore((state) => state.seatedFor)
  const seated = useModeratorViewStore((state) => state.seated)
  const enabledFor = useModeratorViewStore((state) => state.enabledFor)
  const setEnabled = useModeratorViewStore((state) => state.setEnabled)
  const verified = viewer !== null && seatedFor === viewer ? seated : NONE
  return {
    seated: verified,
    active: enabledFor === viewer && verified.length > 0,
    checking: !booted || (viewer !== null && seatedFor !== viewer),
    setEnabled,
  }
}

/** True when the viewer is a verified seated moderator of `contract`. */
export function useIsSeatedModerator(contract: ModeratedContractKey): boolean {
  return useModeratorView().seated.includes(contract)
}
