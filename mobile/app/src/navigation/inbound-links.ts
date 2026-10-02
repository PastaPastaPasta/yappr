import { useEffect } from 'react';
import { create } from 'zustand';

import { config } from '~/config';
import { lastIdentity, useSessionStore } from '~/data/session';
import { openInApp } from '~/features/auth/onboarding';
import { toast } from '~/ui/toast';

import { FALLBACK_ROUTE, resolveLink } from './deep-links';

/**
 * What `+native-intent` does with an inbound link (UX_SPEC §3.5, PRD NET-11)
 * beyond picking its route: the in-app browser for web-only pages, the
 * unsupported-link toast.
 */

export const UNSUPPORTED_LINK = "This link isn't supported in the app";
export const OPEN_IN_BROWSER = 'Open in browser';

interface PendingLinks {
  /** The browser or toast a link asked for, run once the navigator is up. */
  effect: (() => void) | null;
}

const usePendingLinks = create<PendingLinks>()(() => ({ effect: null }));

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

/** Shows the browser or toast inbound links asked for once the navigator is ready. Mounted once (AuthGates). */
export function useInboundLinkEffects(ready: boolean): void {
  const effect = usePendingLinks((s) => s.effect);
  useEffect(() => {
    if (!ready || !effect) return;
    usePendingLinks.setState({ effect: null });
    effect();
  }, [ready, effect]);
}
