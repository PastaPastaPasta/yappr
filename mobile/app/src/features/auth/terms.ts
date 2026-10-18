import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { syncStorage } from '~/state/storage';

/**
 * The terms and community-rules gate (PRD AUTH-09, PD-1; COMPLIANCE C4).
 * Every identity accepts once per network on this device, at the end of its
 * first sign-in. Bumping TERMS_VERSION shows the gate again to every signed-in
 * account on its next launch (PRD §11.1 OQ-5: the version is an app constant
 * until web publishes one).
 */
export const TERMS_VERSION = '2026-10-18';

export { COMMUNITY_RULES, TERMS_SUMMARY } from './terms-copy';

interface Acceptance {
  version: string;
  acceptedAt: number;
}

interface TermsState {
  /** `<networkKey>:<identityId>` → the accepted version. */
  accepted: Record<string, Acceptance>;
}

const accountKey = (networkKey: string, identityId: string) => `${networkKey}:${identityId}`;

export const useTermsStore = create<TermsState>()(
  persist(() => ({ accepted: {} }), {
    name: 'terms',
    version: 1,
    storage: createJSONStorage(() => syncStorage),
    merge: (persisted, current) => {
      const accepted = (persisted as Partial<TermsState> | undefined)?.accepted;
      return { ...current, accepted: accepted && typeof accepted === 'object' ? accepted : {} };
    },
  }),
);

/** Whether `identityId` has accepted the current terms on this network. */
export function hasAcceptedTerms(networkKey: string, identityId: string): boolean {
  return useTermsStore.getState().accepted[accountKey(networkKey, identityId)]?.version === TERMS_VERSION;
}

/** The same, re-rendering when it changes. */
export function useHasAcceptedTerms(networkKey: string, identityId: string | null): boolean {
  return useTermsStore((s) => !!identityId && s.accepted[accountKey(networkKey, identityId)]?.version === TERMS_VERSION);
}

/** Records acceptance (identity, network, version, time); stored locally only. */
export function acceptTerms(networkKey: string, identityId: string, now = Date.now()): void {
  useTermsStore.setState((s) => ({
    accepted: { ...s.accepted, [accountKey(networkKey, identityId)]: { version: TERMS_VERSION, acceptedAt: now } },
  }));
}
