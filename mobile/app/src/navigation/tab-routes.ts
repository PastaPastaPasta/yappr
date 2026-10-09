import { router, type Href } from 'expo-router';

/**
 * Opens a screen that only one tab's stack has (a conversation on Messages;
 * Settings, Bookmarks and the accounts list on Profile) from wherever the
 * user is: the push switches to that tab. When that tab's stack has not been
 * opened yet this session, a plain push makes the screen the stack's only
 * one, with no Back and the tab stuck on it; `withAnchor` puts the tab's
 * root (unstable_settings in the tabs' shared _layout) underneath. On a
 * stack that is already open it pushes as usual.
 *
 * Screens every tab has (post, user, hashtag, settings/notifications,
 * settings/messages) use a plain push, so Back returns to where the user was.
 */
export function openOnItsTab(href: Href): void {
  router.push(href, { withAnchor: true });
}
