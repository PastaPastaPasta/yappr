/**
 * Translates inbound links onto app routes (UX_SPEC §3.5). Web URLs
 * (`https://yap.pr/post?id=X`) and scheme links that keep web's paths
 * (`yappr://post?id=X`) both come through here; see `src/app/+native-intent.tsx`.
 *
 * Pure (no React Native imports) so it is unit-tested in isolation.
 */

/** Where unsupported or malformed links land. TODO(shell PR): toast + "Open in browser". */
export const FALLBACK_ROUTE = '/';

/** Web deployments that serve the same paths under a prefix (yap.pr/devnet, yap.pr/testing). */
const BASE_PATHS = ['/devnet', '/testing'];

/** Identity and document ids: base58, 43–44 characters. */
const ID = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
/** The contract's hashtag pattern (`^[a-z0-9_]{1,63}$`), any case, with an optional cashtag `$`. */
const TAG = /^\$?[A-Za-z0-9_]{1,63}$/;
const ENGAGEMENT_KINDS = new Set(['post', 'reply']);
const SETTINGS_SECTIONS = new Set(['account', 'notifications', 'privacy', 'appearance', 'about']);

type Query = Record<string, string>;

/** Splits any inbound URL form into a path and its query parameters. */
function parse(url: string): { path: string; query: Query } {
  let rest = url.trim().split('#')[0] ?? '';
  const scheme = /^([a-z][a-z0-9+.-]*):(\/\/)?/i.exec(rest);
  if (scheme) {
    rest = rest.slice(scheme[0].length);
    // http(s) carries a host before the path; custom schemes put the first
    // path segment where the host would be (`yappr://post?id=X`).
    if (/^https?$/i.test(scheme[1] ?? '')) rest = rest.replace(/^[^/?]*/, '');
  }
  const [rawPath = '', rawQuery = ''] = rest.split(/\?(.*)/s);
  const query: Query = {};
  for (const pair of rawQuery.split('&')) {
    if (!pair) continue;
    const [k = '', v = ''] = pair.split(/=(.*)/s);
    try {
      query[decodeURIComponent(k.replace(/\+/g, ' '))] = decodeURIComponent(v.replace(/\+/g, ' '));
    } catch {
      // Malformed %-escape: drop the parameter, validation below rejects the link.
    }
  }
  let path = `/${rawPath.replace(/^\/+/, '')}`.replace(/\/+$/, '') || '/';
  const base = BASE_PATHS.find((b) => path === b || path.startsWith(`${b}/`));
  if (base) path = path.slice(base.length) || '/';
  return { path, query };
}

const id = (value: string | undefined) => (value && ID.test(value) ? value : undefined);

function withQuery(path: string, query: Record<string, string | undefined>): string {
  const parts = Object.entries(query)
    .filter((e): e is [string, string] => e[1] !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  return parts.length ? `${path}?${parts.join('&')}` : path;
}

/** Web route → app route, or undefined when the path isn't a web route. */
const WEB_ROUTES: Record<string, (q: Query) => string | null> = {
  '/': () => '/',
  '/feed': () => '/',
  '/welcome': () => '/',
  '/login': () => '/sign-in',
  '/explore': () => '/explore',
  '/notifications': () => '/notifications',
  '/messages': (q) => {
    if (q.startConversation === undefined) return '/messages';
    // TODO(messages PR): open the existing conversation when there is one (engine `dm` lookup).
    const to = id(q.startConversation);
    return to ? withQuery('/messages/new', { with: to }) : null;
  },
  '/bookmarks': () => '/bookmarks',
  '/settings': (q) =>
    q.section && SETTINGS_SECTIONS.has(q.section) ? `/settings/${q.section}` : '/settings',
  '/search': (q) => withQuery('/explore/search', { q: q.q }),
  '/post': (q) => {
    const post = id(q.id);
    if (!post) return null;
    return withQuery(`/post/${post}`, { reply: id(q.reply) });
  },
  '/post/engagements': (q) => {
    const post = id(q.id);
    if (!post || (q.kind && !ENGAGEMENT_KINDS.has(q.kind))) return null;
    return withQuery(`/post/${post}/engagements`, { kind: q.kind });
  },
  // TODO(profiles PR): the viewer's own id → /profile, and `edit=true` → /profile/edit.
  '/user': (q) => (id(q.id) ? `/user/${q.id}` : null),
  '/mentions': (q) => (id(q.user) ? withQuery(`/user/${q.user}`, { tab: 'mentions' }) : null),
  // TODO(profiles PR): a missing `id` means the viewer.
  '/followers': (q) => (id(q.id) ? `/user/${q.id}/followers` : null),
  '/following': (q) => (id(q.id) ? `/user/${q.id}/following` : null),
  '/hashtag': (q) => (q.tag && TAG.test(q.tag) ? `/hashtag/${encodeURIComponent(q.tag)}` : null),
};

/**
 * Detail screens every tab can push (src/app/(tabs)/(home,explore,...)). A
 * cold link has no current tab, and expo-router would pick the first group
 * alphabetically (Explore), so external links open them in Home.
 */
const SHARED_ROUTE = /^\/(post|user|hashtag)\//;
const inHomeTab = (route: string) => (SHARED_ROUTE.test(route) ? `/(home)${route}` : route);

/** The dev client's own launch link (`exp+yappr://expo-development-client/?url=...`). */
const DEV_CLIENT = '/expo-development-client';

/** Web pages that are not in the app in 1.0. TODO(shell PR): open these in the in-app browser. */
const WEB_ONLY = ['/terms', '/privacy', '/about', '/cookies', '/contract', '/dpns', '/store', '/item', '/cart', '/checkout', '/orders', '/blog', '/embed'];

/**
 * The app route for an inbound URL. Web routes are translated; anything else
 * is treated as an app route already (e.g. `yappr-dev:///__gallery`) and
 * passed through for expo-router to match (`+not-found` catches the rest).
 */
export function toAppRoute(url: string): string {
  const { path, query } = parse(url);
  const web = WEB_ROUTES[path];
  if (web) return inHomeTab(web(query) ?? FALLBACK_ROUTE);
  if ([DEV_CLIENT, ...WEB_ONLY].some((p) => path === p || path.startsWith(`${p}/`))) {
    return FALLBACK_ROUTE;
  }
  return inHomeTab(withQuery(path, query));
}
