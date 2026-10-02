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
export const TERMS_VERSION = '2026-10-01';

/** The summary on the gate (UX_SPEC §5.1 terms.rule1–4). */
export const TERMS_SUMMARY = [
  'No harassment, hate, threats or illegal content. There is zero tolerance for abuse.',
  "Reported content can be removed by the community's moderators, and abusive accounts can be banned.",
  'You can block anyone, and report posts that break these rules.',
  'What you post is public and permanent on Dash Platform.',
] as const;

/**
 * The full community rules, drafted from COMPLIANCE.md (UGC section) for
 * mobile 1.0. Shown in the gate under "Community rules".
 */
export const COMMUNITY_RULES: readonly { title: string; body: string }[] = [
  {
    title: 'Zero tolerance for abuse',
    body:
      'Harassment, hate speech, threats of violence, doxxing, and content that sexualises minors are not allowed. ' +
      'Neither is content that is illegal where you live or that promotes self-harm. Accounts that post it can be banned.',
  },
  {
    title: 'Sensitive content',
    body:
      'Mark posts with nudity, gore or other graphic content as sensitive. Yappr hides sensitive posts until each viewer chooses to see them.',
  },
  {
    title: 'Spam and impersonation',
    body:
      'Do not post spam, scams or misleading links, and do not pretend to be another person or organisation.',
  },
  {
    title: 'Reports and moderation',
    body:
      "Anyone can report a post, a reply or an account. The community's elected moderators can remove reported content and suspend or ban accounts, " +
      'and the Yappr team hides content that breaks these rules in the official apps, usually within 24 hours. ' +
      'Reports are public documents signed by the reporter. For anything urgent, email support@yap.pr.',
  },
  {
    title: 'Blocking',
    body: 'You can block anyone. Their posts, replies, mentions and messages stop reaching you.',
  },
  {
    title: 'Your content is public and permanent',
    body:
      'Posts, replies, likes and follows are documents on Dash Platform. Anyone can read them, and deleting a post may leave a trace on the network.',
  },
];

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
