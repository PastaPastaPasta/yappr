import { StackActions, type NavigationContainerRef, type ParamListBase } from 'expo-router/react-navigation';

import { lastIdentity, useSessionStore } from '~/data/session';
import { useAccounts } from '~/features/auth/accounts';

/** The navigation container, as much of it as resetting the tab stacks needs. */
export type TabStacksNavigation = Pick<NavigationContainerRef<ParamListBase>, 'isReady' | 'getRootState' | 'dispatch'>;

/** The root stack's route that holds the tab navigator (`src/app/(tabs)`). */
const TABS_ROUTE = '(tabs)';

/** A navigator's state, mounted (with a key) or not yet (partial). */
interface StateNode {
  key?: string;
  routes: readonly RouteNode[];
}
interface RouteNode {
  name: string;
  state?: StateNode;
}

/** The `(tabs)` route, under expo-router's own root route (`__root`) and the root stack. */
function findTabs(routes: readonly RouteNode[] | undefined): RouteNode | undefined {
  for (const route of routes ?? []) {
    if (route.name === TABS_ROUTE) return route;
    const found = findTabs(route.state?.routes);
    if (found) return found;
  }
  return undefined;
}

/**
 * Takes every tab's stack back to its root screen (Home, Explore,
 * Notifications, the inbox, Profile), leaving the current tab selected and
 * root modals alone. Only stacks the navigator has mounted hold screens
 * beyond their root.
 */
export function popTabStacksToRoot(navigation: TabStacksNavigation): void {
  if (!navigation.isReady()) return;
  const root: StateNode | undefined = navigation.getRootState();
  const tabs = findTabs(root?.routes)?.state;
  for (const tab of tabs?.routes ?? []) {
    const stack = tab.state;
    if (typeof stack?.key === 'string' && stack.routes.length > 1) {
      navigation.dispatch({ ...StackActions.popToTop(), target: stack.key });
    }
  }
}

/**
 * The tab stacks belong to the account they were opened as (PRD AUTH-10:
 * switching reloads all screens for the new identity). When another account
 * takes over (a switch, a finished "Add account", or the next account after a
 * sign-out) or the active account signs out, every tab goes back to its root,
 * so no screen of the previous account (its open conversation, its settings)
 * is left on a stack (D-rc5a-003). Signing in from signed out keeps the
 * user's place, and an "Add account" or "Sign in again" that ends on the same
 * account changes nothing: its signed-out moment is the account parked, not
 * gone. Started once by the root layout; returns the unsubscribe.
 */
export function startTabStacksFollowAccount(navigation: TabStacksNavigation): () => void {
  const initial = useSessionStore.getState();
  /** The account the stacks were opened as; null for signed out. */
  let owner = initial.status === 'unknown' ? lastIdentity() : (initial.session?.identityId ?? null);
  return useSessionStore.subscribe(({ status, session }) => {
    if (status === 'signed-in' && session) {
      if (owner !== null && owner !== session.identityId) popTabStacksToRoot(navigation);
      owner = session.identityId;
    } else if (status === 'signed-out' && owner !== null && useAccounts.getState().transition?.kind === 'sign-out') {
      popTabStacksToRoot(navigation);
      owner = null;
    }
  });
}
