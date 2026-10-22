# Running an archival ("uncensored") frontend

Yappr's moderators can hide content and restrict accounts, but they can never delete anything ([SOCIAL_V18.md](SOCIAL_V18.md), D43/D44). A hidden post, reply, blog post, comment, store, listing or review is still on chain, in full, with the moderator's stamp. yap.pr and the official apps do not list it. Anyone can build a frontend that does.

This repository ships every part of that. Both parts are build flags that are **off by default**, and release builds (yap.pr root, `/staging`, `/staging-old` and the official mobile apps) refuse them, so a flag cannot reach yap.pr by accident.

| Flag | Value | What it turns on |
| --- | --- | --- |
| `NEXT_PUBLIC_MODERATION_VIEW` | `all` | The archive view: every listing reads every lane, hidden and restricted content is shown with a label. |
| `NEXT_PUBLIC_MODERATION_LOG` | `1` | The `/moderation-log` page. |

They are independent. Any other value (empty, `0`, `default`, `true`) means off, and a release build refuses everything but unset or empty (the log flag also accepts `0`).

The mobile engine has the same two flags. They go in the env file of a **non-release** engine variant (today the devnet variant, `.env.devnet`) and reach the bundle like any other `NEXT_PUBLIC_` key. The testnet and staging-testnet engine variants are official release builds and refuse them.

## The model, in one paragraph

Every listing on social v18, blog v10 and storefront v11 is indexed by lane. `live` is 1 (listed) or 2 (written while its author was restricted); `mod` is absent (listed), 1 (hidden) or 2 (legal hold). yap.pr reads `live == 1, mod == null`, which holds exactly the documents everyone can see. An archive reads every lane of the same listing and merges them. The full catalogue of reads, with the exact clauses, is in [SOCIAL_V18.md](SOCIAL_V18.md#archive-and-moderation-log-queries) and `scripts/hide-moderation-queries.mjs`.

## What each flag shows

### `NEXT_PUBLIC_MODERATION_VIEW=all`

- **Listings.** Timelines, tag pages, an author's posts and replies, threads, mentions, blog and store listings, reviews: each read is sent once per lane, with the same order and its own cursor per lane, and the pages are merged by the listing's order (k-way merge). "Load more" pages every lane from where it stopped.
- **Counts.** A count is the sum of its lanes. Grouped counts are summed per key. A store's average rating and its star histogram sum the lanes' totals before dividing.
- **Rankings.** Top authors, most replied, top rated, trending posts and tags: every lane is ranked, the lists are merged, and **hidden posts are not skipped**.
- **Labels.** A hidden or restricted item is shown with a label instead of being dropped: who hid it, when, and the reason ("Hidden · Spam · by @alice · 2h ago"; "Hidden for legal reasons" for `mod == 2`), and "Restricted account" for a post written in lane `live == 2`. Items reached by id, quote, bookmark, notification or ranked list are kept and labelled too.
- **Everything else is unchanged.** Posting, replying and the rest behave as on yap.pr. The archive does not let anyone unhide anything: only the seated team can write `mod`.

With the flag off, the build is exactly yap.pr: one lane per listing, and a hidden document reached some other way is dropped.

### `NEXT_PUBLIC_MODERATION_LOG=1`

The `/moderation-log` page. It is a static route (query parameters only), not linked from anywhere, and without the flag it renders the same page as any address that does not exist.

- **What it lists, newest first**, merged by time across everything below, with "Load more":
  - **Hides.** Each moderated type's `moderated [mod, $moderatedAt]` index, both lanes: `mod == 1` (hidden) and `mod == 2` (legal hold, shown as "hidden for legal reasons"). Social: post, reply, yapprProfile. Blog: blog, blogPost, blogComment. Storefront: store, storeItem, storeReview, itemReview.
  - **Restrictions.** `restriction.log [state, $moderatedAt]`, states 1 (placed) and 2 (lifted), on social and blog.
  - **Warnings.** The contract's warning list, read with `moderationEntriesWithProof`. A warning stores no moderator id, so the row says it was given by the team. The list is in identity order, not time order, so the first page reads all of it once and merges it as one source.
- **Each row** shows what happened, the moderator (DPNS name when there is one), the time, the reason, and a link to the item or account. The reason is the charter reason when a team is seated (a hide's `modLabel` and a restriction's `reason` are the reason's place in the seated charter, see `lib/moderation-labels.ts`), or the interim class before one is; a number nothing explains shows as "Reason N". A warning shows the moderator's own text.
- **Contracts.** `?contract=social|blog|storefront`. Tabs appear for the contracts this build can read the log of, which are the v18 set's. On older cuts (v17 and before, the legacy deployments) the page says the log isn't available for this network.
- **A hide that was undone is not listed.** An unhidden document leaves the `moderated` index, so the log shows what is hidden now, plus every restriction (placed or lifted) and every warning. Say so when you publish one.
- **Links to hidden items** open the item itself only on a build that also has `NEXT_PUBLIC_MODERATION_VIEW=all`; a build with only the log shows the same "hidden" page a visitor of yap.pr gets.

## Building one

An archival frontend is a normal `next build` of this repository with its own env file. `npm run build` is the **release** build: it loads `.env.testnet` only, ignores the shell and refuses the flags, so use `next build` directly.

1. Copy the env file of the network you want to read (`.env.testnet`, or `.env.devnet` for a devnet) to a file of your own, for example `.env.archive`.
2. Point it at the v18 set. The contract ids come from the activation PR that registered social v18, blog v10 and storefront v11 in the App Connect group; until then only a devnet copy of the set has them:

   ```sh
   NEXT_PUBLIC_CONTRACT_TOPOLOGY=v18
   NEXT_PUBLIC_BLOG_TOPOLOGY=v10
   NEXT_PUBLIC_STOREFRONT_TOPOLOGY=v11
   NEXT_PUBLIC_YAPPR_CONTRACT_ID=<social v18>
   NEXT_PUBLIC_YAPPR_BLOG_CONTRACT_ID=<blog v10>
   NEXT_PUBLIC_YAPPR_STOREFRONT_CONTRACT_ID=<storefront v11>
   ```

   Keep every other id and the App Connect pins as the network's file has them.
3. Delete `NEXT_PUBLIC_RELEASE=1` or set it to `0`. With it on, the build is a release and refuses the flags.
4. Add the flags:

   ```sh
   NEXT_PUBLIC_MODERATION_VIEW=all
   NEXT_PUBLIC_MODERATION_LOG=1
   ```
5. Pick a `BASE_PATH` and a `STORAGE_EPOCH` of your own. A frontend served from the same origin as another Yappr build shares its browser storage unless its scope differs (`lib/storage-scope.ts`), and a different frontend must not read yap.pr's sessions:

   ```sh
   BASE_PATH=/archive
   STORAGE_EPOCH=archive-1
   ```
6. Build and publish the static export (`out/`):

   ```sh
   set -a && . ./.env.archive && set +a && next build && node scripts/write-static-404.mjs out /archive
   ```

   Leave `BASE_PATH` empty and drop the last argument when you host it at the root of its own domain.

Nothing else is needed: the contracts and the Platform are the same, and the archive's reads are ordinary document queries that any node serves.

## Why a release cannot carry them

`scripts/release-config.cjs` (`assertReleaseConfig`) refuses the build when `NEXT_PUBLIC_MODERATION_VIEW` is anything but unset or empty, or `NEXT_PUBLIC_MODERATION_LOG` is anything but unset, empty or `0`. Every release build goes through it:

- `npm run build` (root), `build:staging` (`/staging`) and `build:staging-old` run `scripts/build-release.mjs`, which loads the checked-in env file and fails before `next build` starts if the file carries a flag. A flag in the **shell** fails it too, instead of being dropped silently. The environment `next build` inherits has both flags set to empty, so a stray `.env.local`, `.env.production` or `.env` cannot supply them.
- `next.config.js` calls `assertReleaseConfig(process.env)` again at the start of every production build, after Next has loaded its own env files, so a direct `next build` with `NEXT_PUBLIC_RELEASE=1` is covered as well.
- The mobile engine's official variants (testnet, staging-testnet) load the same release env and check the flags again on their own (`mobile/engine/build-config.cjs`).

`scripts/release-config.test.mjs` pins each of those paths.

## What it costs

Reads, not fees: nothing about an archive changes what anyone pays to write. But every listing read multiplies by its lanes, and each is a separate proved query.

| Read | yap.pr | Archive |
| --- | --- | --- |
| A listing or count on social posts and replies, or blog posts (`live` and `mod` lanes) | 1 | **6**: `live` {1, 2} × `mod` {null, 1, 2} |
| A listing or count on a type with only the `mod` lane (mentions, `blog.timeline`, blog comments, every storefront listing and rating) | 1 | **3**: `mod` {null, 1, 2} |
| Counts, grouped counts, averages, histograms | 1 | the same lanes; the results are summed |
| A ranked list (top authors, most replied, top rated) | 1 | the same lanes; each lane's top N is merged |
| The moderation log, one page | not served | one read per source: social 6 hide lanes + 2 restriction states, blog 6 + 2, storefront 8, plus the warning list (read whole, once) |

A few things follow from that:

- **Paging.** Each lane has its own cursor, so "Load more" is again one read per lane, from where each stopped. A page of 20 posts is fetched as up to 6 pages of 20 and merged down to 20; the surplus is read again on the next page.
- **Rankings are approximate at the edge.** A ranked list merges each lane's top N. A group that sits just outside the top N of every lane it appears in, but would rank inside the top N of the sum, can be missed, because its count is split across lanes. Counts are exact; only ranked lists carry this.
- **The composite feed page** (the For You and Following timelines, which are built from several reads) resolves its page of ids through the merged read and then fetches the documents by id, so an archive pays the lane multiple on its first step.
- **Time to first content** grows with the slowest lane. The reads go out together, but a page waits for all of them.
- **A hidden post's likes still count** in `byPost`, the tag totals and trending (accepted gap), so a hidden post can top a ranked list; the archive shows it, labelled.

## Checks

- `npx vitest run lib/contract-query-conformance.test.ts` judges every read of the catalogue, in every lane, against the committed contract files.
- `scripts/prove-v18-moderation.mjs catalogue` ran every one of them, proved, on sakura (179/179).
- `npx vitest run scripts/release-config.test.mjs` pins the release refusals.
