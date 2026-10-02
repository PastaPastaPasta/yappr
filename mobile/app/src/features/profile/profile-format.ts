import type { CapabilitiesDTO } from '@engine/api';
import type { ProfileTab } from '@engine/api/profiles';

import { config } from '~/config';
import { formatNumber } from '~/lib-allowlist';

/** Pure helpers for the profile screens (PRD PROF-01 – PROF-12, UX_SPEC §4.12 – §4.14, copy §5.6). */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Joined Sep 2026" (copy `profile.joined`). */
export function joinedLabel(date: Date | string | undefined): string | null {
  if (!date) return null;
  const at = new Date(date);
  if (Number.isNaN(at.getTime())) return null;
  return `Joined ${MONTHS[at.getMonth()]} ${at.getFullYear()}`;
}

/** The stored website as a link: a bare `bob.dev` gets `https://`. Null for anything that isn't http(s). */
export function websiteUrl(website: string | undefined): string | null {
  const text = website?.trim();
  if (!text) return null;
  const url = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
  return /^https?:\/\/[^\s/?#]+/i.test(url) ? url : null;
}

/** What the header shows for the website: the host and path, without the scheme or a trailing slash. */
export function websiteLabel(website: string): string {
  return website
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/$/, '');
}

/** The profile on yap.pr (devnet: under `/devnet`), for share and copy (PRD PROF-12). */
export function profileWebUrl(identityId: string): string {
  return `https://yap.pr${config.webBasePath}/user?id=${encodeURIComponent(identityId)}`;
}

/** "Get a username" links here (PRD AUTH-15). */
export function usernameRegisterUrl(): string {
  return `https://yap.pr${config.webBasePath}/dpns/register`;
}

/** 1234 → "1.2K", as web's counts. */
export function formatCount(count: number): string {
  return formatNumber(count);
}

export interface ProfileTabSpec {
  value: ProfileTab;
  label: string;
  empty: { title: string; description?: string };
}

const TABS: Record<ProfileTab, ProfileTabSpec> = {
  posts: { value: 'posts', label: 'Posts', empty: { title: 'No original posts yet' } },
  replies: { value: 'replies', label: 'Replies', empty: { title: 'No replies yet' } },
  top: { value: 'top', label: 'Top', empty: { title: 'No liked posts yet' } },
  mentions: {
    value: 'mentions',
    label: 'Mentions',
    empty: { title: 'No mentions yet', description: 'Posts that mention this user will appear here' },
  },
};

/** Posts, Replies, Top (proved like rankings only, PRD PROF-02) and Mentions. */
export function profileTabs(capabilities: Pick<CapabilitiesDTO, 'rankings'> | null): ProfileTabSpec[] {
  return [TABS.posts, TABS.replies, ...(capabilities?.rankings ? [TABS.top] : []), TABS.mentions];
}

/** A `?tab=` from a link (`/mentions?user=X` → `mentions`), when the build has that tab. */
export function initialTab(requested: string | undefined, tabs: readonly ProfileTabSpec[]): ProfileTab {
  return tabs.find((tab) => tab.value === requested)?.value ?? 'posts';
}

/** Base58 identity ids are 43 or 44 characters (UX_SPEC §3.5); anything else is a DPNS name to resolve. */
export function looksLikeIdentityId(value: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(value);
}

/**
 * A DPNS name the engine can resolve (`alice`, `@alice`, `alice.dash`). Not a
 * full DPNS check: the engine decides. Rejects what can never be one (spaces,
 * slashes), so the screen says "Invalid identity ID" at once.
 */
export function looksLikeName(value: string): boolean {
  return /^@?[a-zA-Z0-9-]{3,63}(\.dash)?$/i.test(value);
}
