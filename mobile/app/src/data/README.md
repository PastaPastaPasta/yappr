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
| `session.ts` | `useSession()`, `useViewerId()`, `useProvisionalViewerId()`, `useCapabilities()` |
| `require-auth.tsx` | `requireAuth(action)` / `useRequireAuth()`, and the "Sign in to continue" sheet |
| `writes.ts` | `runWrite`, `submitWrite`, `sendWrite`, `useWrite`, `checkWrite`, `retryWrite`: tickets, toasts and rollback |
| `optimistic.ts` | `setViewerState`, `setFollowing`, `setAuthorBlocked`, `hidePost`, `markPostDeleted`, `dropFromLists`, `updateCachedPosts` |
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

- **In a list cell:** `sendWrite(likeWrite, vars, 'Reposted!')` (the toast
  is optional and shows once the engine has taken the write). Neither of
  the functions below subscribes either:
  - `runWrite(spec, vars)` resolves with a `WriteResult`:
    - `{ status: 'submitted', ticket }`;
    - `{ status: 'queued' }`: a write with the same key was pending;
    - `{ status: 'refused', error }`: undone, and the user was told;
    - `{ status: 'unknown', error }`: the engine restarted or timed out
      under the call. The change stays, and the tracker adopts the ticket
      the engine restores on its next boot (with the spec's `matches`).
  - `submitWrite(spec, vars)` is the older form: the ticket, or null for
    anything but `submitted`.
- **On a screen that shows the status:** `const w = useWrite(spec)`, then
  `w.run(vars)` (ticket or null) or `w.send(vars)` (a `WriteResult`). Read `w.status` (`idle` / `pending` / `confirmed` /
  `unconfirmed` / `failed`) and `w.ticket`; `w.check()` and `w.retry()` act
  on it.
- **What happens to the ticket.** The tracker handles every outcome; screens
  don't:
  - `confirmed`: the change stays, and `onConfirmed` runs.
  - `failed`: the change is undone, an error haptic fires, and a toast shows
    the engine's `categorizeError` text (or `failureMessage` when the engine
    has nothing specific, or the spec's `failureText` for the ticket). The
    toast offers **Retry** when the engine allows one. `onFailed` runs after
    the undo, for a failure that changed state anyway.
  - `unconfirmed`: the write may have landed, so the change stays (PRD G-3).
    A "Not confirmed yet" toast offers **Check again**. If the check proves
    the write absent, the change is undone and the toast offers **Retry**.
    Engagements set `announceUnconfirmed: false`: G-3 counts them as done,
    with no toast.
  - Nothing is retried automatically. Retry applies only to the latest write
    for a key, and never while another is in flight. A failure of an older
    write for a key says nothing: the newer write decides the state.
- **One write per key at a time.** A write made while one with its key is
  pending is queued with its optimistic change shown at once (only the latest
  queued write is kept). It is sent when the pending one confirms, or might
  have landed, and dropped when the pending one fails, since that failure's
  undo restored the very state a toggle back asked for. It is also dropped,
  undone and announced when the pending one's call is cut short (below). With `intent` on the
  spec, a queued write that asks for what the pending one asked is dropped
  too, so a like, unlike, like run sends one like.
- **Offline (PRD G-1).** While the OS reports no connectivity, `runWrite`
  (and Retry) send nothing and make no optimistic change: the toast says
  "You're offline. Nothing was sent." and the result is `refused`.
- **Short of credits or YAPP (PRD G-5).** `INSUFFICIENT_CREDITS` and
  `INSUFFICIENT_YAPP` failures toast the mobile copy (YAPP with "Open
  yap.pr"), never Retry. `writeFailureText` gives the same text to a spec
  with its own message.
- **The engine cut the call short.** `ENGINE_RESTARTED`, `ENGINE_DISCONNECTED`,
  `RPC_TIMEOUT` and `ENGINE_TIMEOUT` mean the write may have run (an account
  switch is an engine restart). No failure toast: give the spec `matches`, so
  the tracker can follow the restored ticket. A write queued behind it is
  never sent: the call may still be running, and the next engine may sign as
  another account. `onAdopted` tells a spec that
  keeps its own record of the write (a DM's outbox bubble) which ticket that is.
  - Signing out or switching accounts forgets every tracked write.
- **When the engine refuses the call itself.** No ticket is made, and the
  change is undone. `NOT_SIGNED_IN` opens the sign-in sheet. `onRejected`
  can handle a specific code (`QUOTE_HAS_TEXT`). Anything else toasts
  `failureMessage`.
- **Toasts on the happy path** ("Reposted!", "Added to bookmarks") are the
  caller's: `sendWrite`'s third argument.
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
- `setAuthorBlocked(authorId, blocked)` sets `viewer.authorBlocked` on the
  author's cached posts and quotes, so a block survives a relaunch.
- `hidePost(id)` removes a post from every `PostItem` at once.
  `markPostDeleted(id)` turns every cached copy into the "deleted" line, and
  `dropFromLists(id)` takes it out of cached lists (not threads).
- **Patches change only the patched marks.** A copy's unknown fields stay
  unknown, and counts move only where the copy knew the old mark.
- **Each helper returns its undo.** The undo applies to every copy,
  including copies cached after the change (a detail screen seeded from a
  patched card). It also refetches the post's (or the author's profile's)
  detail family, so a copy that was already right comes back right.
- **Patches don't disturb queries.** Untouched objects keep their identity,
  so memoized cells don't re-render. A patched query keeps its age, so stale
  data still refetches. A fetch already in flight is cancelled with a
  revert, so the query stays `success` and the old fetch can't land the
  pre-write state over the change.
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
- **In Lockdown Mode** (the engine is `unsupported`): it toasts
  "Unavailable in Lockdown Mode" and drops the action (PRD NET-06).
- **While the engine is still restoring the session:** whoever was signed
  in last time counts, so a write at boot shows at once (PRD G-2). If that
  account is gone, the engine refuses the write (`NOT_SIGNED_IN`), the change
  is undone and the sheet opens.
- **Session expired (PRD AUTH-14, `session-expiry.ts`):** a write that fails
  `KEY_REVOKED` (Platform refused the key: disabled, gone from the identity,
  expired) or `NO_KEY` (outside Messages, where it means the encryption key)
  toasts "Your session has expired. Please sign in again." with "Sign in"
  (never Retry), and marks the account "Sign in again", persisted. Every
  failed ticket the app hears of marks its account, followed by a spec or
  not, and so does a call the engine refuses with `KEY_REVOKED`. Reads carry on. While
  the active account is marked, `requireAuth` opens the "Sign in again"
  sheet instead of running the action; it leads to `reauthenticate` (the
  auth feature, registered by `AuthGates`). A fresh sign-in of the account
  (`session.changed` `signed-in`) or signing it out clears the mark.
  - In the account list, tapping a marked account that is not the current
    one switches to it for reading; its "Sign in again" button opens its
    sign-in. One whose key is gone cannot be opened: its sign-in opens
    instead, and abandoning it returns to the account that was current.
  - The marks, not the flow, decide that a sign-in for a marked account
    logs in afresh: the key screen never offers to switch to it, and every
    wallet request names the marked accounts (`startKeyExchange({ reauth })`).
  - The engine that signs a marked account in was booted without its other
    stored keys, so the sign-in flow then restarts into it
    (`loadSignedInAgain`), reading the mark before the sign-in clears it.
  - The encryption key: a wallet sign-in stores the wallet-derived one, as
    web does, replacing an imported key; a key sign-in keeps the stored one.
  - A wallet whose key is disabled on the identity fails the sign-in
    (`KEY_DISABLED`), and the account stays marked.

Other session hooks:
- `useSession()`: `status` (`unknown` / `signed-out` / `signed-in`),
  `session`, `accounts`, `identityId` and `signedIn`.
- `useViewerId()`: the identity id alone, which re-renders less.
- `useProvisionalViewerId()`: the same, but while the session is `unknown`
  whoever was signed in last time (`lastIdentity()`), whose account the
  persisted cache belongs to. For what a cached card shows during a cold
  launch (the media gate), never for writes.
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
  `content.created` (it seeds the new post, puts a post on top of the
  loaded Recent home feeds, marks every feed stale without refetching it,
  since an infinite query's refetch re-reads every page it holds, and
  refetches the author's profile and the thread or quoted post).

## Gotcha: React Compiler and closures

The app builds with React Compiler, which memoizes callbacks by the property
paths they read and evaluates those paths while rendering. A closure such as
`() => read(target!.id)` therefore throws during render when `target` is
undefined, even if the callback never runs. Read plain values first:
`const targetId = target?.id ?? ''`, then use `targetId` in the closure.

## Posts

`src/features/post/PostItem.tsx` is the post cell for every list. It is the
design system's `PostCard` with all of these wired:

- like, repost (the v10 slot rules, and the `QUOTE_HAS_TEXT` confirm),
  bookmark and follow, all optimistic;
- share, and the ⋯ / long-press menu, with delete own (native confirm),
  block and report. iOS long press shows the menu as an action sheet: the
  iOS menu view is a UIButton, so wrapping a whole card in it would swallow
  every tap inside;
- the navigation: post, author, compose, media, hashtags, mentions and safe
  external links.

Render `<PostItem post={post} />` with the post from a query, and pass card
props (`variant`, `replyingTo`) through.

- **`removal`:** a post this device deleted leaves lists at once
  (`removal="hide"`, the default). Threads and detail screens pass
  `removal="stub"`, which shows the "deleted" line in its place, so replies
  below it keep their parent. A detail screen whose root was deleted should
  pop: `usePostRemoved(id)`.
- **Bare reposts:** a bare repost's like, repost and bookmark wait for its
  `engage.stats` marks. A tap before they arrive says "Loading this post."

Navigation helpers (`openPost`,
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
