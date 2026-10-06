# Social v12 for Platform 5.0.0-beta.2

Social v12 is social v11 (design M, [SOCIAL_V11.md](SOCIAL_V11.md)) plus two Platform 5.0.0-beta.2 keywords. The user approved both on 2026-10-06, when sakura moved to 5.0.0-beta.2 and its Platform chain was wiped:

| Change | Keyword | What changes |
| --- | --- | --- |
| **Counter like indexes** | `summableOffCountIndex` (#5250) | `like.byAuthorPost`, `like.byHashtagPost` and `likeReply.byAuthorReply` keep **one counter per post (reply)**: the number of entries `byPost` (`byReply`) holds for it. A like adds one to each counter instead of writing an entry per like into each index. Counts and rankings read the same. No like documents can be read through them any more. |
| **Barred authors can retract** | `retractedWhen` (#5253) | `post` and `reply` declare `retractedWhen: { "present": "deleted" }`. A banned or suspended author's tombstone of its own post or reply is accepted. Every other replace by a barred author is still refused (41107/41108). This resolves open decision 3 of the 2026-10 moderation QA. |

**Decisions the user confirmed on 2026-10-06:**
- `deleteSettled` stays `{ leader: true, approvals: 3 }` on post and reply. The new `approversPredateDocument` is left at its default, which is on (#5260): a member the leader *added* counts only for documents created strictly after it was added. The leader and the elected members always count. Seat E1's members by election (join requests in the charter window), not by `addedModerator`.
- The counters carry **no `rankedAverageable`** ("likes per post" rankings).

Topology `v12` (`NEXT_PUBLIC_CONTRACT_TOPOLOGY=v12`). v2, v9, v10 and v11 behave exactly as before.

## The file

| | |
| --- | --- |
| File | `contracts/yappr-social-contract-v12.json` |
| sha256 | `5b9cf0cc2d36aaac2e1126a4bcde895eda6427324b1683e2d76aabfbc1329263` |
| Signed create | **19,877 B** as published (19,812 B unsigned): under the 20,000 B budget and the 20,480 B hard cap; v11 was ~19,639 B |
| Parses | wasm-sdk and wasm-dpp2 (5.0.0-beta.2) under full validation; `auditNodeRules` clean; meta-schema v3 at the beta.2 tag clean |

The whole diff against v11:

| Type | v11 | v12 |
| --- | --- | --- |
| `like` | `byAuthorPost [postAuthor, postId]` → `$ownerId`, `rangeCountable`, ranked at `[postAuthor, postId]`, preallocated | **`summableOffCountIndex: "byPost"`**, no terminal, `rangeCountable` + `rangeSummable`, `rankedCountable { at: [postAuthor, postId] }`, preallocated |
| `like` | `byHashtagPost [hashtag, postId]` → `$ownerId`, ranked at `[hashtag, postId]`, `skipIfAbsent`, preallocated | **`summableOffCountIndex: "byPost"`**, the same otherwise (`rangeSummable` added, no terminal) |
| `likeReply` | `byAuthorReply [replyAuthor, replyId]` → `$ownerId`, preallocated | **`summableOffCountIndex: "byReply"`**, `rangeCountable` + `rangeSummable`, preallocated, unranked |
| `post`, `reply` | no `retractedWhen` | **`retractedWhen: { "present": "deleted" }`** |

`byPost`, `byReply`, the trend windows (`byTrendPost`, `byTrendHashtagPost`) and everything else are v11's. A time window can't be a counter, and a counter's source must keep every like exactly once (no `skipIfAbsent`, no `outlivesDelete`, no `$createdAt`), which `byPost` and `byReply` already do.

**Why the counters are lossless.** Every like of one post lands in the same author and the same hashtag. Registration checks this (the "lossless" rule): `postAuthor` is the post's `$ownerId` and `hashtag` the post's `hashtag`, both bound through the `like.postId` reference's `where`. The post's owner never changes (posts are not transferable), and `hashtag` is frozen by name and kept on the moderator's removal record (`deleteKeepsFields`). `replyAuthor` is the reply's `$ownerId`. So a counter is exactly the count of its post's `byPost` entries.

**Ranking spelling.** On a counter, `rankedCountable` is parsed into the Sum ranking, so it is spelled exactly as v11 spelled it. A ranked `count(*)` and a ranked `sum(byPost)` read the same ranking: top creators (`GROUP BY postAuthor`), trending-all-time hashtags (`GROUP BY hashtag`), and an author's or a tag's top posts (`GROUP BY postId`). `rangeCountable` stays, so the trees could also give average queries the number of posts. v12 declares no average ranking.

**The tombstone, and who may write it.** The tombstone is v11's: a replace that sets `deleted: true` and leaves out every content field (`tombstoneIsBlank`, conditional `immutable`). `retractedWhen` picks only *which* replaces a barred owner may make: those whose new document has `deleted`. The rules that make such a document blank are unchanged, and they judge every replace:

| A banned author's replace | v11 | v12 |
| --- | --- | --- |
| a tombstone `{ deleted: true, hashtag? }` | 41107 | **accepted** |
| an edit (no `deleted`) | 41107 | 41107 |
| `deleted` with content kept | 41107 | 10422 (`tombstoneIsBlank`) |
| un-tombstoning | 41107 | 41107 (and 40128: `deleted` is frozen once set) |
| a new post, reply or like | 41107 | 41107 |
| an unlike (a delete) | accepted | accepted |

**Blog has no `retractedWhen`.** `blog` and `blogPost` are `canBeDeleted: false`, but they have no tombstone shape (`deleted` flag): an author can edit a blog post but can't retract it, on any topology. Without a rule blanking the retracted document, `retractedWhen` would let a barred author write into it, so blog v6 stays as it is. A blog tombstone needs its own blog cut and client work.

## What users and moderators will notice

- **Likes cost less** (measured below), and nothing else about likes changes: heart state, counts, unlike, profile Top, top creators, trending and hashtag Top all read the same.
- **A banned or suspended author can delete (tombstone) its own posts and replies.** On v11 the app had to say "you can't delete this while banned"; on v12 the delete just works. Everything else a barred author tries is still refused.
- **Like notifications** read the like counters first, then the likers of only the posts whose count changed (client section). The "Alice and 3 others liked your post" aggregate, the silent first-run baseline and the timeless dating are v11's.
- **Moderation teams:** a member the leader adds after a post was written can't propose or approve that post's settled deletion (41212, "You joined the team after this was posted…"). Elected members and the leader always count. E1 is seated by election, so this changes nothing for it.

## Measured costs

Live fees (balance diffs, `scripts/measure-social-fees.mjs`) for v12 against a v11 copy registered on the same 5.0.0-beta.2 chain are being recorded in a follow-up; `documentCreateCost` estimates (new / known index values):

| Write | v11 | v12 |
| --- | ---: | ---: |
| like | 148.2M / 56.9M | 126.8M / 41.2M |
| reply like | 48.2M / 19.3M | 39.3M / 11.8M |
| post | 456.2M / 304.1M | 452.4M / 299.5M |
| reply | 223.0M / 140.4M | 222.4M / 139.8M |

The estimator overstates steady likes (SOCIAL_V11.md), so quote the live table once it lands.

## Live proof on sakura (5.0.0-beta.2)

Social v12 is live on sakura as `78osKsoZq4X5AyRSn9C9fb92oHQ172qEUFw8Q1v6hS5G` (maker nonce 1, 2026-10-06).

`scripts/prove-merged-counts.mjs --contract-file contracts/yappr-social-contract-v12.json` on a throwaway copy (`43C4JawyXSVDmz3RBA9A3zgZtFTzdnnbMwFqtBHw6Lno`, registered by battery bot 0): **158/158 PASS**, among them:
- **cn-a/cn-b:** a post's counter equals its `byPost` count; `count(*)` and `sum(byPost)` agree at the post, author and hashtag levels; `postAuthor ==` with `postId in [...]` or a `postId` range, grouped by `postId`, returns every post with its likes, a never-liked post at 0.
- **cn-c:** a range total on `byAuthorPost` or `byPost` (both ranked) is refused with the hint to group by the last property.
- **cn-d:** top creators (`GROUP BY postAuthor`) and all-time hashtags (`GROUP BY hashtag`) rank off the sum ranking; an author's and a tag's top posts rank by `postId`.
- **cn-e:** a documents read through `byAuthorPost` or `byHashtagPost` is refused; likers read through `byPost`.
- **cn-f/cn-g:** `likeReply` counters per reply and per author; unlikes take the counters down, drained posts stay at 0.
- **rw-*:** banned, then suspended: the author's tombstones of its post and its reply are accepted; its edits, a tombstone keeping text (10422), taking a tombstone back and a new post are refused (41107/41108).

## Client (topology v12)

- **Topology** (`lib/contract-topology.ts`): `v12` is v11's descriptor with `IndexOnlyLikeShape.authorIndexIsCounter: true`; `barredAuthorsCanTombstone()` is true on v12 only. `isV10()`, `isV11()` and `deletesAreTombstones()` hold on v12, so every v11 behaviour (tombstones, settled deletion, preallocated zero groups, timeless like notifications) carries over.
- **Like notifications** (`like-service.ts` `getLikersOf`): the recent-target like counts are v11's composite count slot over `byPost`/`byReply`. Only for targets whose count moved, the likers are read per target on `byPost`/`byReply` (`postId ==`, keyset-paged on `$ownerId`), four at a time; a target whose read fails is left out and re-read next poll. There is no author-pinned liker read any more: the author index holds no documents.
- **Ranked and count reads** are unchanged: top creators, all-time trending tags, profile Top and tag Top read the counters as v11 read the entry indexes; every grouped count names `byPost`/`byReply`.
- **Barred authors:** the delete of a banned or suspended author just works; the ban panel no longer says such an author can't take its writing down.

## Tooling

- `scripts/validate-contract-offline.mjs` passes v12; `--probes` adds 30 v12 probes (every counter and `retractedWhen` registration rule, refused by the wasm-sdk parse, plus update probes through wasm-dpp2 `validateUpdate`: 40212 for `retractedWhen`/`approversPredateDocument` changes, 10217 for an index change).
- `scripts/verify-v10.mjs --contract-file contracts/yappr-social-contract-v12.json`: n2 reads the author counter around a like and the likers through the target index; x4 proves `retractedWhen` (bars are always lifted, with a loud warning if that cannot be confirmed).
- `scripts/prove-merged-counts.mjs`: the cn-* and rw-* phases above; optional tm-15..22 prove #5260 with a leader-added member.
- `scripts/measure-social-fees.mjs` measures several cuts side by side in one run.

## Publishing

Published 2026-10-06 by the maker at nonce 1 with the rest of the set (the full redeploy record follows in a later document). E1 is filed on it (charter `6kiTPiturzSefwfV5fpwth5juakNpc64txMbBWQ6RFP3`): leader tess1999, members alice7-sept and battery bot 1, both elected through join requests, so #5260 counts them for every post.
