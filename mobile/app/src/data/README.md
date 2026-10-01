# `src/data`: the app's data layer

Screens never call the engine directly. They read through TanStack Query
hooks over `engine.api`, write through `submitWrite` / `useWrite`, and gate
writes with `requireAuth`. This folder holds those pieces. Feature code lives
in `src/features/<feature>/**`, next to the routes that use it.

| File | What |
| --- | --- |
| `keys.ts` | `queryKeys`: the one key factory |
| `queries.ts` | `useEngineQuery`, `useEngineInfiniteQuery`, `engineQueryOptions`, `flattenPages` |
| `events.ts` | `useEngineEvent(name, handler)`, `onEngineEvent`: typed engine events |
| `session.ts` | `useSession()`, `useViewerId()`, `useCapabilities()` |
| `require-auth.tsx` | `requireAuth(action)` / `useRequireAuth()`, and the "Sign in to continue" sheet |
| `writes.ts` | `submitWrite`, `useWrite`, `checkWrite`, `retryWrite`: tickets, toasts and rollback |
| `optimistic.ts` | `setViewerState`, `setFollowing`, `hidePost`, `markPostDeleted`, `updateCachedPosts` |
| `sync.ts` | `startDataLayer()`: the root layout starts the app-wide subscriptions once |
| `testing/fake-engine.ts` | A fake `~/engine` for Jest |

## Reads

Take every key from `queryKeys`. Keys start with `['engine', <network>]` and
nest, so a prefix invalidates a family: `queryKeys.post.detail(id)` also
covers that post's thread, engagements and stats.

```tsx
const { data: post } = useEngineQuery(queryKeys.post.detail(id), (api) => api.posts.get(id));

const feed = useEngineInfiniteQuery(
  queryKeys.feed.home({ tab: 'forYou' }),
  (api, cursor) => api.feed.home({ tab: 'forYou', cursor }),
  { persist: true },
);
// feed.items: every loaded page, flattened, each id once. feed.fetchNextPage(), feed.hasNextPage.
```

- **New keys:** add them to `keys.ts` at the end of their section, and keep
  them under the family they belong to.
- **Persistence is opt-in.** `{ persist: true }` keeps a query in MMKV, so
  the next launch paints it before the engine boots. Use it for feeds,
  profiles and posts. Never use it for DMs, notifications or balances:
  MMKV isn't encrypted. Persisted data keeps its `Date`s (the engine codec
  serializes it).
- **No cache reset needed.** Sign-in, sign-out and account switches already
  reset the cache (`session.ts`).

## Writes

Every engine write returns a `WriteTicket` at once (`pending`), then reports
each transition as `write.status`. A `WriteSpec` describes one write:

```ts
export const likeWrite: WriteSpec<{ post: PostDTO; like: boolean }> = {
  key: ({ post }) => `like:${post.id}`,                 // one at a time per post
  submit: (api, { post, like }) => (like ? api.engage.like(targetOf(post)) : api.engage.unlike(targetOf(post))),
  optimistic: ({ post, like }) => setViewerState(post.id, { liked: like }), // returns its undo
  noun: 'like',                                          // "Your like didn't go through."
  failureMessage: 'Failed to update like. Please try again.',
};
```

- **In a list cell:** `submitWrite(likeWrite, vars)`. It doesn't subscribe,
  and it resolves with the ticket, or null if it was skipped or refused.
- **On a screen that shows the status:** `const w = useWrite(spec)`, then
  `w.run(vars)`. Read `w.status` (`idle` / `pending` / `confirmed` /
  `unconfirmed` / `failed`) and `w.ticket`; `w.check()` and `w.retry()` act
  on it.
- **What happens to the ticket.** The tracker handles every outcome; screens
  don't:
  - `confirmed`: the change stays, and `onConfirmed` runs.
  - `failed`: the change is undone, an error haptic fires, and a toast shows
    the engine's `categorizeError` text (or `failureMessage` when the engine
    has nothing specific). The toast offers **Retry** when the engine allows
    one.
  - `unconfirmed`: the write may have landed, so the change stays (PRD G-3).
    A "Not confirmed yet" toast offers **Check again**. If the check proves
    the write absent, the change is undone and the toast offers **Retry**.
  - Nothing is retried automatically.
- **When the engine refuses the call itself.** No ticket is made, and the
  change is undone. `NOT_SIGNED_IN` opens the sign-in sheet. `onRejected`
  can handle a specific code (`QUOTE_HAS_TEXT`). Anything else toasts
  `failureMessage`.
- **Toasts on the happy path** ("Reposted!", "Added to bookmarks") are the
  caller's. Show them when `submitWrite` resolves with a ticket.
- **Post engagements already exist.** `src/features/post/post-writes.ts` has
  the like, repost, bookmark, follow and delete specs. Reuse them.

## Optimistic updates

The helpers in `optimistic.ts` walk every cached engine query structurally.
Anything with a post's `id` and `stats` is a post: feed pages, threads,
details, quoted posts and `engage.stats` entries. So a new query shape is
covered without registering it.

- `setViewerState(postId, { liked | reposted | bookmarked | ownQuoteId })`
  moves the counts with the flags.
- `setFollowing(authorId, follows)` updates the author's posts, profile
  (and its follower count) and user rows.
- `hidePost(id)` removes a post from every `PostItem` at once.
  `markPostDeleted(id)` turns every cached copy into the "deleted" line.
- Each helper returns its undo. Untouched objects keep their identity, so
  memoized cells don't re-render.
- Render posts from the cache (a query's data), not from a copy in local
  state, or the optimistic change won't show.

## Auth gating

Write controls stay visible when signed out (PRD G-8). Wrap the action:

```ts
const requireAuth = useRequireAuth();
<Button onPress={() => requireAuth(() => follow.run(id))} />
```

- **Signed in:** it runs the action.
- **Signed out:** it opens the "Sign in to continue" sheet, which links to
  `/sign-in`. The action is dropped: after sign-in the user is back where
  they were, and nothing happens.
- **While the engine is still restoring the session:** it waits for the
  answer.

Other session hooks:
- `useSession()`: `status` (`unknown` / `signed-out` / `signed-in`),
  `session`, `accounts`, `identityId` and `signedIn`.
- `useViewerId()`: the identity id alone, which re-renders less.
- `useCapabilities()`: `engine.info().capabilities`, remembered across
  launches for the same engine bundle.

## Events

```ts
useEngineEvent('notifications.count', ({ unread }) => setBadge(unread));
```

- Payloads are typed by `EngineEventMap`. The handler may change on every
  render.
- Outside React, use `onEngineEvent(name, handler)`, which returns the
  unsubscribe.
- These are already handled app-wide: `session.changed` (the session store
  and cache resets), `write.status` (the write tracker) and
  `content.created` (it seeds the new post and invalidates the feeds, the
  author's profile, and the thread or quoted post).

## Posts

`src/features/post/PostItem.tsx` is the post cell for every list. It is the
design system's `PostCard` with all of these wired:

- like, repost (the v10 slot rules, and the `QUOTE_HAS_TEXT` confirm),
  bookmark and follow, all optimistic;
- share, and the ⋯ / long-press menu, with delete own, block and report;
- the navigation: post, author, compose, media, hashtags, mentions and safe
  external links.

Render `<PostItem post={post} />` with the post from a query, and pass card
props (`variant`, `replyingTo`) through. Navigation helpers (`openPost`,
`openUser`, `postWebUrl`, `sharePost`) are in `post-navigation.ts`.

## Tests

Mock the engine and drive it by hand:

```ts
jest.mock('~/engine', () => jest.requireActual('~/data/testing/fake-engine').engineModule);
fakeEngine.method('engage.like').mockResolvedValue(ticket());
fakeEngine.emit('write.status', advance(t, { state: 'confirmed' }));
fakeEngine.setStatus({ state: 'ready', info: { capabilities } });
```

- In component tests, call `notifyManager.setScheduler((cb) => cb())`, so
  cache updates render at once.
- See `src/features/post/PostItem.test.tsx`.
