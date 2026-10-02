import { router, type Href } from 'expo-router';
import { useEffect } from 'react';
import { create } from 'zustand';

import { config } from '~/config';
import { lastIdentity, useSessionStore } from '~/data/session';
import { useLockState } from '~/features/auth/app-lock';
import { openInApp } from '~/features/auth/onboarding';
import { toast } from '~/ui/toast';

import { FALLBACK_ROUTE, resolveLink } from './deep-links';

/**
 * What `+native-intent` does with an inbound link (UX_SPEC §3.5, PRD NET-11)
 * beyond picking its route: the in-app browser for web-only pages, the
 * unsupported-link toast, and holding links while the app lock is up.
 */

export const UNSUPPORTED_LINK = "This link isn't supported in the app";
export const OPEN_IN_BROWSER = 'Open in browser';

interface PendingLinks {
  /** A link that arrived while the app lock covered the app: it opens once unlocked. */
  deferred: string | null;
  /** The browser or toast a link asked for, run once the navigator is up and the app unlocked. */
  effect: (() => void) | null;
}

const usePendingLinks = create<PendingLinks>()(() => ({ deferred: null, effect: null }));

/**
 * While the lock (or its cover) is up nothing may open: on iOS a modal
 * presented now would draw over the lock screen and take touches (SR-01).
 */
const lockIsUp = () => {
  const { locked, covered } = useLockState.getState();
  return locked || covered;
};

/** Before the engine restores the session, whoever was signed in last (PRD G-2). */
function viewerId(): string | null {
  const { status, session } = useSessionStore.getState();
  return status === 'unknown' ? lastIdentity() : (session?.identityId ?? null);
}

/**
 * The route for an inbound link, or null to stay where the app is. `initial`
 * is the link that launched the app, which must land somewhere.
 */
export function routeInboundLink(url: string, initial: boolean): string | null {
  const stay = initial ? FALLBACK_ROUTE : null;
  if (lockIsUp()) {
    usePendingLinks.setState({ deferred: url });
    return stay;
  }
  const target = resolveLink(url, {
    initial,
    webBasePath: config.webBasePath,
    allowAppRoutes: __DEV__,
    viewerId: viewerId(),
  });
  switch (target.kind) {
    case 'route':
      return target.route;
    case 'ignore':
      return stay;
    case 'browser':
      usePendingLinks.setState({ effect: () => openInApp(target.url) });
      return stay;
    case 'unsupported':
      usePendingLinks.setState({
        effect: () => {
          toast(UNSUPPORTED_LINK, { action: { label: OPEN_IN_BROWSER, onPress: () => openInApp(target.url) } });
        },
      });
      return FALLBACK_ROUTE;
  }
}

/**
 * Runs what inbound links left pending once the navigator is ready and the
 * app is unlocked: a link held by the lock opens, and a browser or toast
 * shows. Mounted once (AuthGates).
 */
export function useInboundLinkEffects(ready: boolean): void {
  const lockUp = useLockState((s) => s.locked || s.covered);
  const { deferred, effect } = usePendingLinks();
  useEffect(() => {
    if (!ready || lockUp || (!deferred && !effect)) return;
    usePendingLinks.setState({ deferred: null, effect: null });
    effect?.();
    const route = deferred ? routeInboundLink(deferred, false) : null;
    if (route) router.push(route as Href);
  }, [ready, lockUp, deferred, effect]);
}
