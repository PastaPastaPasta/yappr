/**
 * Translates inbound links onto app routes (UX_SPEC §3.5). Web URLs
 * (`https://yap.pr/post?id=X`) and scheme links that keep web's paths
 * (`yappr://post?id=X`) both come through here; see `src/app/+native-intent.tsx`.
 *
 * Inbound links are untrusted (any web page or QR code can produce one), so
 * only known web routes and validated path-form detail routes are accepted.
 * Web-only pages open in the in-app browser; anything else lands on
 * FALLBACK_ROUTE with "This link isn't supported in the app" (PRD NET-11).
 *
 * Pure (no React Native imports) so it is unit-tested in isolation.
 */

/** Where unsupported or malformed links land (with a toast, `src/navigation/inbound-links.ts`). */
export const FALLBACK_ROUTE = '/';

/** The web app, whose pages the in-app browser opens. */
const WEB_ORIGIN = 'https://yap.pr';

export interface LinkOptions {
  /**
   * True for the link that launched the app. A cold link has no current tab,
   * so detail screens are pinned to Home; warm links push onto the current tab.
   */
  initial: boolean;
  /**
   * The web prefix this build claims (`/devnet` for devnet, '' for testnet
   * and production). Links under another deployment's prefix are refused,
   * since their ids belong to another network.
   */
  webBasePath: string;
  /**
   * Dev builds only: pass other app routes through (e.g. `yappr-dev:///__gallery`
   * for screenshots). Routes in NEVER_FROM_OUTSIDE stay refused even then.
   */
  allowAppRoutes: boolean;
  /**
   * The signed-in viewer (before the engine restores, whoever was signed in
   * last), or null: `/login` is then ignored, and `/user`, `/followers` and
   * `/following` resolve the viewer's own profile.
   */
  viewerId?: string | null;
}

/** What an inbound link does. */
export type LinkTarget =
  /** Navigate to an app route. */
  | { kind: 'route'; route: string }
  /** A web-only page (store, blog, DPNS registration, the legal pages): the in-app browser. */
  | { kind: 'browser'; url: string }
  /** Home, with "This link isn't supported in the app" and "Open in browser" for `url`. */
  | { kind: 'unsupported'; url: string }
  /** Nothing to do (sign-in while signed in). */
  | { kind: 'ignore' };

/** Web deployments that serve the app's paths under a prefix. */
const WEB_BASE_PATHS = ['/devnet', '/testing'];

/** Web pages the app does not have in 1.0 (UX_SPEC §3.5); each covers its sub-paths. */
const WEB_ONLY = [
  '/terms',
  '/privacy',
  '/about',
  '/cookies',
  '/contract',
  '/dpns/register',
  '/store',
  '/item',
  '/cart',
  '/checkout',
  '/orders',
  '/blog',
  '/embed',
];

/** Identity and document ids: base58, 43–44 characters. */
const ID = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
/** Conversation ids: base58 of 10 (legacy 1:1 DMs) to 32 bytes. */
const CONVERSATION_ID = /^[1-9A-HJ-NP-Za-km-z]{10,44}$/;
/** The contract's hashtag pattern (`^[a-z0-9_]{1,63}$`), with an optional cashtag `$`. */
const TAG = /^\$?[a-z0-9_]{1,63}$/;
const ENGAGEMENT_KINDS = new Set(['post', 'reply']);
const PROFILE_TABS = new Set(['posts', 'replies', 'top', 'mentions']);
const SETTINGS_SECTIONS = new Set(['account', 'notifications', 'privacy', 'appearance', 'about']);

/**
 * Screens a link must never open, even in dev builds: they take secrets,
 * prefill content the user would publish, or are app-state gates.
 */
const NEVER_FROM_OUTSIDE = [
  '/sign-in',
  '/compose',
  '/lockdown',
  '/terms-gate',
  '/media',
  '/settings/app-lock',
  '/settings/accounts',
  '/block',
  '/report',
];

type Query = Record<string, string>;

const matchesPrefix = (path: string, prefix: string) =>
  path === prefix || path.startsWith(`${prefix}/`);

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
  const path = `/${rawPath.replace(/^\/+/, '')}`.replace(/\/+$/, '') || '/';
  return { path, query };
}

const id = (value: string | undefined) => (value && ID.test(value) ? value : undefined);

/** A tag in the contract's lowercase form (`#DASH` and `dash` are the same tag), or undefined. */
function tag(value: string | undefined): string | undefined {
  const lower = value?.toLowerCase();
  return lower && TAG.test(lower) ? lower : undefined;
}

function withQuery(path: string, query: Record<string, string | undefined>): string {
  const parts = Object.entries(query)
    .filter((e): e is [string, string] => e[1] !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  return parts.length ? `${path}?${parts.join('&')}` : path;
}

/** The viewer's own followers or following list when `id` is left out (web's default). */
function listOf(q: Query, viewerId: string | null, list: 'followers' | 'following'): string | null {
  const who = q.id === undefined ? viewerId : id(q.id);
  return who ? `/user/${who}/${list}` : null;
}

/** A web route with nothing to open (sign-in while signed in). */
const IGNORE = '';
/** Web route → app route; null for a web route with invalid parameters, IGNORE for a no-op. */
const WEB_ROUTES: Record<string, (q: Query, viewerId: string | null) => string | null> = {
  '/': () => '/',
  '/feed': () => '/',
  '/welcome': () => '/',
  '/login': (_q, viewerId) => (viewerId ? IGNORE : '/sign-in'),
  '/explore': () => '/explore',
  '/notifications': () => '/notifications',
  '/messages': (q) => {
    if (q.startConversation === undefined) return '/messages';
    // The new-message screen opens the existing (or a new) conversation with them (`dm.startDirect`).
    const to = id(q.startConversation);
    return to ? withQuery('/messages/new', { with: to }) : null;
  },
  '/bookmarks': () => '/bookmarks',
  '/settings': (q) =>
    q.section && SETTINGS_SECTIONS.has(q.section) ? `/settings/${q.section}` : '/settings',
  '/search': (q) => withQuery('/explore/search', { q: q.q }),
  '/post': (q) => {
    const post = id(q.id);
    return post ? withQuery(`/post/${post}`, { reply: id(q.reply) }) : null;
  },
  '/post/engagements': (q) => {
    const post = id(q.id);
    if (!post || (q.kind && !ENGAGEMENT_KINDS.has(q.kind))) return null;
    return withQuery(`/post/${post}/engagements`, { kind: q.kind });
  },
  '/user': (q, viewerId) => {
    const user = id(q.id);
    if (!user) return null;
    if (user !== viewerId) return `/user/${user}`;
    return q.edit === 'true' ? '/profile/edit' : '/profile';
  },
  '/mentions': (q) => (id(q.user) ? withQuery(`/user/${q.user}`, { tab: 'mentions' }) : null),
  '/followers': (q, viewerId) => listOf(q, viewerId, 'followers'),
  '/following': (q, viewerId) => listOf(q, viewerId, 'following'),
  '/hashtag': (q) => {
    const t = tag(q.tag);
    return t ? `/hashtag/${encodeURIComponent(t)}` : null;
  },
};

/**
 * App-route form of the detail screens (`yappr://post/X`), validated like the
 * web forms. Unknown query parameters are dropped. undefined = not one of these.
 */
function pathFormRoute(path: string, q: Query): string | null | undefined {
  const [, head, value = '', tail, ...rest] = path.split('/');
  if (rest.length > 0) return undefined;
  switch (head) {
    case 'post':
      if (!id(value)) return null;
      if (tail === undefined) return withQuery(`/post/${value}`, { reply: id(q.reply) });
      if (tail !== 'engagements' || (q.kind && !ENGAGEMENT_KINDS.has(q.kind))) return null;
      return withQuery(`/post/${value}/engagements`, { kind: q.kind });
    case 'user':
      if (!id(value)) return null;
      if (tail === undefined) {
        return withQuery(`/user/${value}`, { tab: q.tab && PROFILE_TABS.has(q.tab) ? q.tab : undefined });
      }
      return tail === 'followers' || tail === 'following' ? `/user/${value}/${tail}` : null;
    case 'hashtag': {
      const t = tail === undefined ? tag(value) : undefined;
      return t ? `/hashtag/${encodeURIComponent(t)}` : null;
    }
    case 'messages':
      // /messages/new and /messages/settings are app screens, not conversations.
      if (value === 'new' || value === 'new-group' || value === 'settings') return undefined;
      return tail === undefined && CONVERSATION_ID.test(value) ? `/messages/${value}` : null;
    default:
      return undefined;
  }
}

/**
 * Screens every tab can push (src/app/(tabs)/(home,explore,...)). A cold link
 * has no current tab, and expo-router would pick the first group
 * alphabetically (Explore), so the launch link opens detail screens in Home
 * and notification settings in Profile, its home under Settings.
 */
const SHARED_ROUTE = /^\/(post|user|hashtag)\//;
const PROFILE_SHARED_ROUTE = /^\/settings\/notifications(?:$|\?)/;

/** The launch link's route, pinned to a tab when it is a shared screen. */
function pinColdRoute(route: string): string {
  if (SHARED_ROUTE.test(route)) return `/(home)${route}`;
  if (PROFILE_SHARED_ROUTE.test(route)) return `/(profile)${route}`;
  return route;
}

/** The dev client's own launch link (`exp+yappr://expo-development-client/?url=...`). */
const DEV_CLIENT = '/expo-development-client';

/** The web page for a path: the in-app browser opens only yap.pr, with a path of plain characters. */
function webUrl(path: string, query: Query): string {
  const safe = /^[\w./-]*$/.test(path) && !path.includes('..') ? path : '/';
  return withQuery(`${WEB_ORIGIN}${safe}`, query);
}

/**
 * What an inbound URL does: a translated web route, a validated path-form
 * detail route, or (dev builds only) another app route; a web-only page in
 * the in-app browser; or Home with the unsupported-link toast.
 */
export function resolveLink(url: string, options: LinkOptions): LinkTarget {
  const parsed = parse(url);
  let { path } = parsed;

  if (options.webBasePath && matchesPrefix(path, options.webBasePath)) {
    path = path.slice(options.webBasePath.length) || '/';
  } else if (WEB_BASE_PATHS.some((b) => matchesPrefix(path, b))) {
    // Another deployment's link; its ids belong to another network.
    return { kind: 'unsupported', url: webUrl(path, parsed.query) };
  }
  // The same page on this build's web deployment.
  const page = webUrl(`${options.webBasePath}${path === '/' ? '' : path}` || '/', parsed.query);

  if (WEB_ONLY.some((p) => matchesPrefix(path, p))) return { kind: 'browser', url: page };

  const web = WEB_ROUTES[path];
  let route = web ? web(parsed.query, options.viewerId ?? null) : pathFormRoute(path, parsed.query);
  if (route === undefined) {
    const allowed =
      options.allowAppRoutes &&
      !matchesPrefix(path, DEV_CLIENT) &&
      !NEVER_FROM_OUTSIDE.some((p) => matchesPrefix(path, p));
    route = allowed ? withQuery(path, parsed.query) : null;
  }
  if (route === IGNORE) return { kind: 'ignore' };
  if (route === null) return { kind: 'unsupported', url: page };
  return { kind: 'route', route: options.initial ? pinColdRoute(route) : route };
}

/** The app route for an inbound URL, or FALLBACK_ROUTE for anything that is not one. */
export function toAppRoute(url: string, options: LinkOptions): string {
  const target = resolveLink(url, options);
  return target.kind === 'route' ? target.route : FALLBACK_ROUTE;
}
