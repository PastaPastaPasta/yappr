# Social v11 for Platform 5.0.0-beta.1

Social v11 is social v10 plus Platform 5.0.0-beta.1 keywords the user approved on 2026-10-01: decisions D1, D3 and D4 of the 5.0 upgrade plan, and then **design M**, which the platform maintainer proposed and the user took the same day:

| Decision | Keyword | What changes |
| --- | --- | --- |
| **D1, cheaper likes** | `outlivesDelete` (#5232/#5233) | The two like trend windows outlive deletes. The like author indexes drop `$createdAt`, so no like index keeps a like's time. An unlike names no `$createdAt`, and like notifications are timeless. |
| **D3, moderation teams** | `deleteWithin` + `deleteSettled` (#5215), reads (#5230) | One moderator deletes a post or reply for 7 days. After that the seated team deletes it together: the leader plus two members. A team deletion can never be restored. |
| **D4, removal records keep fields** | `deleteKeepsFields` (#5219) | A moderator's removal record keeps the post's `hashtag` and `$createdAt`, or the reply's `rootPostId` and `$createdAt`. |
| **M, moderated posts and replies** | `moderatedDocument` (#5214), `preallocated` (#5229), conditional `immutable` (#5217) | `post` and `reply` are `canBeDeleted: false`: only a moderator removes one, leaving a removal record. Every reference at them is `moderatedDocument`, so it keeps resolving after a removal (referential integrity). The like trees are preallocated, paid by the post's or reply's creator. An author "deletes" with a **tombstone**. |

The user accepted M's price on purpose: "we prefer the post pay these costs rather than whoever happens to like first; increased post fees is ok". Tombstones also forgo the storage refund an author's delete gave on v10. This replaces the plan's D2, which it had recommended against.

Topology `v11` (`NEXT_PUBLIC_CONTRACT_TOPOLOGY=v11`). v2, v9 and v10 behave exactly as before.

## The file

| | |
| --- | --- |
| File | `contracts/yappr-social-contract-v11.json` |
| sha256 | `374745b4d3bc7768a32b77aab3126650e6ad157bc3fbf0fc65876f7a1693b556` (design M; the D1/D3/D4-only cut was `e0d38f62…`) |
| Signed create | **~19,639 B**: 361 B under the 20,000 B budget (the hard cap is 20,480 B). D1/D3/D4 alone were 17,295 B, and M adds 2,344 B, almost all of it the two `immutable` lists and `tombstoneIsBlank` |
| Parses | wasm-sdk and wasm-dpp2 under full validation; `auditNodeRules` clean; meta-schema v3 (5.0) clean |

`lib/contract-topology.test.ts` pins the whole diff against v10, which is exactly this:

| Type | v10 | v11 |
| --- | --- | --- |
| `like` | `byAuthorPostTime [postAuthor, postId, $createdAt]` → `$ownerId`, ranked at `[postAuthor, postId]` | **`byAuthorPost [postAuthor, postId]`** → `$ownerId`, same ranking and `rangeCountable` |
| `like` | `byTrendPost` (72h/24h), `byTrendHashtagPost` (24h/6h) | the same windows, **`outlivesDelete: true`** |
| `likeReply` | `byAuthorReplyTime [replyAuthor, replyId, $createdAt]`; `required` has `$createdAt` | **`byAuthorReply [replyAuthor, replyId]`**; `$createdAt` dropped from `required` (a type that requires it but indexes it nowhere still commits rows to it) |
| `post` | `moderatorAbilities: { delete: true }` | `{ delete: true, deleteKeepsFields: ["hashtag", "$createdAt"], deleteWithin: 604800, deleteSettled: { leader: true, approvals: 3 } }` |
| `reply` | `moderatorAbilities: { delete: true }` | `{ delete: true, deleteKeepsFields: ["rootPostId", "$createdAt"], deleteWithin: 604800, deleteSettled: { leader: true, approvals: 3 } }` |
| `post`, `reply` (M) | author-deletable, immutable | `canBeDeleted: false`, `documentsMutable: true`, `$updatedAt` required, a new optional boolean `deleted`, an `immutable` list (below) and the rule `tombstoneIsBlank`; post `notEmpty` admits a tombstone |
| every reference at post/reply (M) | `deletableDocument` | **`moderatedDocument`**: `like.postId`, `likeReply.replyId`, `reply.rootPostId`/`replyToReplyId`, `post.quotedPostId`/`quotedReplyId`, `bookmark.postId`, `report.postId`/`replyId` |
| `like`, `likeReply` (M) | trees built by the first like | **`preallocated`** on `like.byPost`, `byAuthorPost`, `byHashtagPost` and `likeReply.byReply`, `byAuthorReply`: built when the post or reply is created, paid by its creator |

**The tombstone.** A tombstone is a replace that sets `deleted: true` and leaves out every content field:

| Field | Post | Reply |
| --- | --- | --- |
| frozen by name, never changes | `hashtag` | `rootPostId`, `replyToReplyId`, `parentOwnerId` |
| frozen unless the replace sets `deleted` (`{ property, when: { absent: "deleted" } }`), and absent once it does | `content`, `mediaUrl`, `mediaHash`, `mediaFingerprint`, `sensitive`, `encryptedContent`, `keyGeneration`, `nonce`, `embedContractId`, `embedDocType`, `embedId`, `mentionedUserId`, `quotedPostId`, `quotedReplyId`, `quotedPostOwnerId` | `content`, `mediaUrl`, `mediaHash`, `mediaFingerprint`, `sensitive`, `encryptedContent`, `keyGeneration`, `nonce`, `mentionedUserId` |
| the flag | `deleted`: frozen once set (`when: { present: "$old.deleted" }`); `tombstoneIsBlank` requires it to be true (booleans compare as 1/0) | the same |

- **Nothing else is mutable.** An edit without the flag is refused (40128), a tombstone that keeps any content is refused (10422 `tombstoneIsBlank`), and so is one that changes or drops a frozen field (40128). A tombstone can never be undone or refilled.
- **Why it's final.** The probes show that a flag that could be turned back off is legal, so freezing it once set is the cut's choice: undoing a tombstone would revive a post whose content is gone.
- **Why `hashtag` is frozen by name.** The preallocated `byHashtagPost` tree, the like's `where`, and the removal record all key on it. A conditional freeze also registers, but the trees would stay keyed by the created value.

**Undo and redo a repost.** A repost is a bare quote, and the unique `ownerAndQuotedPost`/`ownerAndQuotedReply` allow one per author and target. Undoing it is a tombstone, which clears `quotedPostId`/`quotedReplyId`/`quotedPostOwnerId`. That removes the unique entry, so the repost count drops natively and the slot is free: a redo is a new bare quote. Each undo leaves a content-less shell, since authors cannot delete.

**What else the rules admit, and what M tried.**
- **Preallocation.** It is allowed only on indexOnly types and never with a `timeRange`, so the five untimed like and likeReply indexes are all of it. The quote and reply count trees (`quotesOfPost`, `repliesOf`) live on stored types and cannot be preallocated.
- **Derived index properties.** Each was probed:
  - `quotedPostId.$ownerId` is refused, because a tombstone can clear the quote, so the reference is not fixed once written. `quotedPostOwnerId` stays copied.
  - `postId.$ownerId` on `like` is refused, because like is indexOnly. `postAuthor` stays copied (it costs nothing, since it lives only in index keys).
  - `rootPostId.$ownerId` on a reply is legal. It was not adopted: it would replace `parentOwnerRecent` with two windows (one more windowed read per poll) to save about 0.1-0.2M per reply.

Everything else, including the elected declaration (which already gives the team `deleteDocuments` on post and reply), is v10's.

**Why it works.** A delete stops committing to `$createdAt` only when every like index involving it outlives deletes (`index/outlives_delete.rs`). That is why the author index loses its time, not only the windows (the probe "the trend windows outlive deletes while the author index keeps $createdAt" registers but saves nothing). Each window's key minus `$createdAt` contains `byPost`'s whole key (`[postId] → $ownerId`), as the key rule requires. `approvals: 3` with `leader: true` is the leader and two other members. The declared team can hold the leader, 15 elected members and 10 added ones (26), so the rule always fits.

## Measured costs

The steady-case marginal cost is the case where the liker, post, author and tag were all seen before. It is `documentCreateCost` with known index values, plus 27,000 credits per byte for elements that are new on every write (a `$createdAt` level, or a path that pins both the target and the liker). This is the rule behind the 40.2M design-C figure. It was measured on the committed v10 file, the D1/D3/D4 cut ("v11 pre-M", sha `e0d38f62…`) and the final file with the npm 5.0.0-beta.1 SDK. Posts and replies are the known-values total (a 140-character post, author seen before). Prices are at $60/DASH, where 1M credits = $0.0006 = 0.06¢.

| Write | v10 | v11 pre-M | **v11 (M)** | M vs pre-M |
| --- | ---: | ---: | ---: | ---: |
| like, untagged, steady | 40.2M (2.41¢) | 30.4M (1.83¢) | **30.4M (1.83¢)** | 0 |
| like, tagged, steady | 66.8M (4.01¢) | 56.9M (3.42¢) | **56.9M (3.42¢)** | 0 |
| reply like, steady | 27.7M (1.66¢) | 19.3M (1.16¢) | **19.3M (1.16¢)** | 0 |
| **first** like of a post (new values) | 95.3M (5.72¢) | 85.1M (5.11¢) | **= steady, 30.4M** | −54.7M, now paid by the post |
| first tagged like | 158.5M | 148.2M | **= steady, 56.9M** | −91.3M |
| first reply like | 57.1M | 48.2M | **= steady, 19.3M** | −28.9M |
| unlike | a `$createdAt` lookup, then the delete | the delete alone | the delete alone | 0 |
| post, plain | 116.7M (7.00¢) | 116.7M (7.00¢) | **156.8M (9.41¢)** | +40.1M (+2.41¢, +34%) |
| post, tagged | 127.0M (7.62¢) | 127.0M (7.62¢) | **187.6M (11.26¢)** | +60.6M (+3.64¢, +48%) |
| quote or repost | 140.8M (8.45¢) | 140.8M (8.45¢) | **181.9M (10.91¢)** | +41.1M (+2.47¢, +29%) |
| reply to the root | 56.0M (3.36¢) | 56.0M (3.36¢) | **74.3M (4.46¢)** | +18.3M (+1.10¢, +33%) |
| reply to a reply | 57.0M (3.42¢) | 57.0M (3.42¢) | **75.4M (4.52¢)** | +18.4M |
| author delete / tombstone | a delete, storage refunded | the same | **a tombstone replace: about 0 for a 140-character post, up to 4M for a short one, measured live** | |
| moderator removal | | +0.5M to 2M for kept fields | the same | 0 |

- **Where M's extra cost comes from.** Moderated references and the tombstone fields are nearly free: priced without preallocation they add +0.4M per post, +1.4M per quote and +0.3M per reply. The rest is preallocation: the post now pays the trees its first like paid on pre-M (byPost and byAuthorPost, plus byHashtagPost when tagged; byReply and byAuthorReply for a reply). Trend windows cannot be preallocated, so a post's first like still builds its window entries, which are processing only.
**Live fees** (`scripts/measure-social-fees.mjs`). Each figure is the credits the signer's balance lost per confirmed write, on sakura, with at least 3 samples per row (6 for the later likes). The SDK returns no fee, so balance diffs are the only source.

- Two throwaway contracts: M (`EN8z6tqf…`, from the M file) and pre-M (`En76yf3W…`, from `e0d38f62…`).
- Each holds post, reply, like and likeReply as declared, without YAPP costs or action fees. On the real contract those add a fixed 80M moderators fee per post and 16M per reply, plus YAPP.

| Write | Pre-M live | **M live** | Estimator on M (new / known) |
| --- | ---: | ---: | ---: |
| first like, untagged | 66.0M (3.96¢) | **22.8M (1.37¢)** | 85.1M / 30.4M |
| later like, untagged | 23.6M (1.42¢) | 24.0M (1.44¢) | 30.4M |
| first like, tagged | 97.1M (5.82¢) | **36.1M (2.17¢)** | 148.2M / 56.9M |
| later like, tagged | 35.5M (2.13¢) | 35.4M (2.12¢) | 56.9M |
| first reply like | 40.7M (2.44¢) | **17.3M (1.04¢)** | 48.2M / 19.3M |
| later reply like | 17.6M (1.06¢) | 17.5M (1.05¢) | 19.3M |
| unlike (refund) | −11.9M | −11.4M | — |
| post, plain | 51.4M (3.08¢) | **97.1M (5.82¢)** | 129.1M / 76.8M |
| post, tagged | 62.6M (3.75¢) | **126.7M (7.60¢)** | 194.0M / 107.6M |
| quote | 93.8M (5.63¢) | **144.8M (8.69¢)** | 177.9M / 101.9M |
| repost | 88.9M (5.34¢) | **144.6M (8.68¢)** | 173.2M / 97.2M |
| reply | 75.6M (4.54¢) | **103.9M (6.23¢)** | 121.4M / 58.3M |
| tombstone (140-character post) | — | −0.1M (≈0¢) | — |

What the live fees show:
- **A steady like costs the same on both cuts.** It is about 24M untagged, 35M tagged and 17.5M on a reply. The estimator's steady figures are 25-60% above what the chain charged.
- **Preallocation does what it says.** The first like costs no more than a later one.
- **The post pays instead.** A post costs +45.7M (+64.1M tagged), a quote +51M, a repost +56M and a reply +28M. That is about what the first like used to cost (−43M, −61M, and −23M for a reply like). So total spend only breaks even when nearly every post is liked; otherwise posters pay for trees nobody uses.
- **Creates vary.** Each create's first sample is its high end, because it builds the author's own new paths.
- **Does storage drop? No.**
  - A steady like stores exactly what it did.
  - The first like's trees move from the liker to the poster. A post that is never liked now carries trees it never uses, so total storage rises with the share of unliked posts. By the estimator the break-even is about 73% of posts liked (66% for tagged posts). By the live fees below, the post's extra cost about equals the first like's old cost, so the break-even is nearly every post.
  - A tombstone keeps the post's storage (minus the cleared text), where pre-M's author delete removed it and refunded the unpaid part.
  - The derived properties that could have dropped copied fields are refused on likes and on the clearable quote fields, and on replies they would not pay (above).
  - Referential integrity buys correctness, not storage: no reference ever dangles, and a moderator's removal leaves the document's likes, replies and quotes valid and counted.

The plan quoted 1.82¢ / 3.41¢ for 30.43M / 56.94M, rounded down; rounded to the nearest, they are 1.83¢ and 3.42¢.

**Moderators (D3, D4).** Removing a post costs the same as before M. The removal record carries the kept fields: about 20 B for a short tag plus the time, and up to about 75 B for a 61-character tag or a reply's 32-byte root. That is about 0.5M to 2M credits (0.03¢ to 0.12¢) per removal, paid by the moderator. A team deletion also costs each member its approval transition, and the proposer the action, which is refunded when it runs (the closed copy is paid by the approval that ran it). The trees that hold actions refund nobody.

## What users and moderators will notice

These were accepted with the decisions:

- **Authors no longer delete; they tombstone.**
  - "Delete" turns a post or reply into a "Deleted by its author" placeholder that keeps its place: a thread keeps its shape, and the post's likes and replies stay.
  - It cannot be undone, and the storage is not refunded.
  - Feeds, profiles, tag pages, mentions, notifications and rankings hide tombstones.
  - Reply counts, tag counts and like totals still include them, because those trees are keyed by fields the tombstone keeps.
  - Consensus would still accept a like, reply or quote of a tombstoned post. The client offers none.
- **Undo repost works by tombstone.** The repost count drops at once, and reposting again is allowed. Each undo leaves an empty shell.
- **Posts cost more** (above): a post pays for its own like trees, so its first like costs no more than any other.
- **A moderator-removed post's likes, replies and quotes stay valid and counted.** Its removal record says what it was. New likes and replies of a removed post are refused.
- **Fresh posts rank at zero.** A post with no likes now appears in profile Top, top creators and hashtag Top all-time with a count of 0; the client drops zero rows.

- **Like notifications are timeless.** They read "Alice and 3 others liked your post", with no "5 min ago", and they are dated when this device first noticed them.
  - A new device starts from a silent baseline, so it shows no backlog of old like alerts.
  - Likes are diffed per recent post (see the client section). An unlike plus a new like by someone else between two polls leaves the count unchanged, so that new like is not announced.
- **An unliked like keeps counting in trending** until its window passes: up to 72 h for top posts and 24 h for trending tags. It still counts once per liker per window. A re-like within the window writes over the kept entry and is not counted twice.
  - The all-time counts drop at once: the like count, the heart, profile Top, top creators and hashtag Top all-time.
- **Moderation.**
  - For 7 days after a post or reply is written, any one moderator removes it, as on v10, and can restore it within a week.
  - After 7 days a single moderator is refused (41116). The interim owner is refused too.
  - Before a team is seated, nobody can remove a settled post (41205).
  - Once a team is seated, a member proposes, the others approve, and the deletion runs when the leader and two members have approved. It can never be restored (41209), not even by the leader.
- **Removed posts say what they were.** The removal record keeps the post's hashtag and time (a reply's thread and time), so a quote, a thread or a reply parent shows "Removed by moderators · #tag · posted Sep 30".
  - The records are not indexed, so a hashtag page still cannot list removed posts.
  - Likes of a removed post are indexOnly and nobody can remove them, so the client keeps filtering removed ids out of Top and trending, as on v10.

## Live proof on sakura (5.0.0-beta.1)

Throwaway contracts were registered by battery bots, never the maker. The final design-M runs used these actors:

- A: bot idx 2, `AXNuko2P…`, which registers the contract and is the interim owner;
- B: bot idx 1, `7ardkprL…`;
- C: bot idx 0, `AtXXnY4f…`;
- D: persona 99, `EoAQ31Gm…`, never on the team.

The D1/D3/D4 cut was proven first (runs 1-3 on `9DvxGGj3…` and `CsBuw7dq…`); the M runs repeat every one of those checks. The published v11 contract is the migration's job and was not touched.

**1. `prove-merged-counts.mjs --contract-file contracts/yappr-social-contract-v11.json`.** The script registers a throwaway contract with v11's post, reply, follow, followRequest, like and likeReply types. It copies the indexes, rules and references, but leaves out fees and token costs, and it keeps v11's moderator abilities and an elected declaration over post and reply. Four week-long values get minute-long stand-ins, so that settling and expiry happen within one run:

- `deleteWithin` 90 s;
- election windows 60 s;
- the trend grids 6 min/2 min (posts) and 4 min/1 min (tags), at the real 3:1 and 4:1 ratios;
- no owner protection.

The contract also keeps design M as the file declares it: moderated post and reply, `moderatedDocument` references, preallocated like trees and tombstones.

On sakura, throwaway contract `EjLbaiLvLbiUkqUcn8h1Zrg59d6kYzm9WgT1bWGyqLGN`: **all 109 checks passed.** One quorum rotation mid-run was absorbed by the script's reconnect.

**Design M (M-\*):**
- **Preallocated trees.**
  - M-pa1: a fresh, unliked post is already listed at 0 in profile Top and hashtag Top all-time, and its like count is 0.
  - INFO M-pa2: a grouped count returns the post's group at 0.
  - M-pa3: its FIRST tagged like cost 35.7M, against 34.3M for the second.
  - INFO M-pa0: the tagged post that paid for the trees cost 182.6M on the proof contract.
- **Tombstones refused:**
  - M-tb1: an author delete is refused (10404, "can not be deleted").
  - M-tb2: a text edit without the flag (40128).
  - M-tb3: a tombstone that keeps the text (10422 `tombstoneIsBlank`).
  - M-tb4: a hashtag change (40128).
  - M-tb4b, M-tb4c, M-tb4d: adding a field the post never had (a mention, `sensitive`, or a hashtag on an untagged post) is refused (40128). "Differs" covers a value the stored post lacked.
- **Tombstones allowed.**
  - M-tb5: the tombstone lands with `deleted`, the hashtag kept and no content.
  - M-tb6 and M-tb7: it can be neither undone nor refilled.
  - M-tb8: the reply under it stays, counted.
  - M-tb9, M-tb10 and M-tb11: a reply edit is refused, as is a reply tombstone that drops its root (10101). A reply tombstone that keeps its linkage lands.
- **Undo and redo a repost.**
  - M-rp1: B tombstones its bare repost, so the quote count drops by one and B's own-repost read is empty.
  - M-rp2: B reposts again. The slot is free and the count is back.
  - M-rp3: a second live repost is still 40105.
- **A moderator-removed post.**
  - M-mr1: its record keeps the hashtag.
  - M-mr2: its like, its reply and its quote stay readable and counted (1 each).
  - M-mr3: the hashtag ranking still lists it at 1.
  - M-mr4: a new like of it does not land, and a new reply is refused (its reference resolves to a removal record).
  - M-mr5: a quote of it and a reply under it can still be tombstoned by their authors.

**Every check carried from the D1/D3/D4 runs also passed:**
- **Every v10 shape still holds:**
  - u1-u3: 40105 on a second quote or repost; 10422 `notEmpty`;
  - q1-q4: quote counts;
  - a1-a3: author counts and the ranked top authors;
  - r1-r8: `repliesOf`;
  - f1-f5: follows;
  - c1-c6, c2x/c3x and c5x: composites, including the For You page and the path-rule refusals;
  - w1/w2, o1/o2: bare reposts and the viewer's own quote;
  - n1-n3, n6x, n7x, n8: the notification windows and the permanent bundle;
  - t1/t2, l1/l2, g1 and rm1.
- **Hearts and feed slots, unchanged from v10:** dc-a1/a3 and dc-b1 read the heart state and the feed composite's viewer-likes slot.
- **Rankings on `byAuthorPost`:**
  - ol-c: top creators.
  - ol-d: a profile's Top.
- **Likers without a time:**
  - ol-e1: one post's likers, `postId ==` ordered `[postId, $ownerId]`.
  - ol-e2: the `$ownerId >` keyset walks both likers once.
  - ol-e4/ol-e6: several posts' or replies' likers in one author-pinned `in` read.
  - ol-e3x/ol-e5x: the target-only `in` is refused.
- **Recent posts that gained likes:** dc-f1, dc-f2, dc-f3 and ol-f4 (`postAuthor ==`, `postId in`, grouped). dc-g2: reply like counts.
- **Trending.**
  - ol-t1: top posts in the oldest open window, with C's already-unliked T3 still counted.
  - ol-t2: trending tags.
  - ol-t3: a tag's top posts in its window.
  - ol-t4: hashtag Top all-time.
- **Unlikes without `$createdAt`.**
  - ol-u0, ol-h1 and ol-h2: the count and the heart drop, and so does the profile Top, while the 3-day window keeps the entry. The like and the reply like both work this way.
  - ol-h3: unliking a tagged like drops hashtag Top all-time to 1, while the 24h tag window stays at 2.
  - ol-h4: a re-like while the kept entry stands counts once, so the window still shows 1.
  - INFO ol-h0: a `$createdAt` an unlike carries is dropped by the SDK.
- **Expiry.**
  - ol-x1: once its window passed, C's unliked tag entry is gone, while B's later live like stays (tag 1, Th 1).
  - ol-x2: C's unliked T3 has left the 3-day window.
  - ol-x3: the permanent indexes are untouched.
- **D4, kept fields.**
  - kf-1: the interim owner removes D's tagged post within the window. The record keeps `{hashtag: "kept", $createdAt}`, equal to the post's own `$createdAt`.
  - kf-2: a reply's record keeps `{rootPostId, $createdAt}`.
  - kf-3: `documentRemovals` by id returns the same.
- **D3 before seating.**
  - tm-0a: past the 90 s window, the interim owner's lone delete is refused (41116).
  - tm-0b: a team proposal is refused, since no team is seated (41205).

The node taught three things on the way:
- Run 1 refused the `postId in` liker reads, which became ol-e3x and ol-e5x.
- An expiry check that trusted the local clock became a poll.
- On M, a quorum rotation that faulted a fixture write is now recovered: a readback, and a resend only for non-unique writes.

The ranked like checks drop zero rows, since preallocated trees rank every post.

**2. Seating the team.** For each throwaway contract, the ops election tooling (`ops/election` in the sakura ops directory) seated a team with a single applicant and no votes:

- `file-charter.mjs`: the leader B with reasons SPM and ABU (SPM is `8P94zE6z…`);
- `join-request.mjs`: C and A;
- `file-charter.mjs --apply`: the 0.5 DASH election fund.

The seat was awarded when the 60 s join window closed.

`prove-merged-counts.mjs --team-proof EjLbaiLv… --reason-doc 8P94zE6z…` (design M) passed **all 15 checks**. Two earlier attempts on this contract lost writes to a quorum rotation; the script now waits out the quorum service. Earlier passes: the M contract `D3LWLRwn…` 15/15, and the pre-M `CsBuw7dq…` and `9DvxGGj3…` 15/15 each. D writes fresh targets for each run and they settle, so the phase can be repeated. Action counts are compared as deltas, because they reset only when the pot pays out.

- **tm-1, the team.** The leader is B, the members C and A. `seats(10)` = 13, so a settled deletion needs min(3, 13) = 3 approvals, the leader's among them. D is not on the team.
- **tm-2:** a member's lone delete of the settled S1 is refused (41116).
- **Proposal and reads.**
  - tm-3: C proposes. The action is active, holding C's own approval.
  - tm-4: `teamActions(active)` shows `approvalCount` 1 with C as proposer, and `teamActionSigners` = [C].
  - tm-5: C approving again is refused (41208).
- **Approvals and the deletion.**
  - tm-6: A approves. The action is 2 of 3 and still active, because the leader is required, and S1 still exists.
  - tm-7: the leader approves. The action runs and closes with 3 approvals and 3 signers, and S1 is gone.
- **tm-8, the record.** The moderator is the leader, whose approval ran the deletion. It carries the proposal's reason and `keptFields {hashtag: "settle", $createdAt}`.
- **tm-9:** restoring a team deletion is refused, even for the leader (41209).
- **Action counts.**
  - tm-10: +1 for each of the three approvers.
  - tm-13: after the later steps, leader +2, first member +2, second member +3.
- **Inside the window.**
  - tm-11a: a proposal for a fresh post is refused (41206).
  - tm-11b: a lone member delete of it works, and the record keeps `hashtag: "fresh"`.
- **tm-12, a settled reply:** the leader proposes and two members approve (active, active, closed). The record keeps `rootPostId` and `$createdAt`.
- **tm-14:** approving a closed action is refused (41210).

**3. `verify-v10.mjs --contract-file contracts/yappr-social-contract-v11.json`** ran against a full design-M draft, with YAPP costs and action fees. The draft `A8bUbVFT3iky9dcyDQqqiyNHWfzjGpoM71vVBcm1pNVA` was registered from the M file (sha `374745b4…`) by bot 2 with `register-social-v3-draft.mjs`, which also funded the bots with YAPP. Bot 2, the draft's owner, was the interim moderator.

It passed 217 checks, and its one failure was a fixture bug: x1t gave one author a quote and a repost of the same post, which 40105 refuses. With that fixed, `--only x1,r1` passed **46/46**. Those 46 include:
- x1ta-x1tq, the design-M tombstone case: no author delete (10404); edits, adding a mention, keeping text, or changing or dropping the hashtag all refused; the tombstone of a short post (4.25M; a longer post refunds more of its text); no undo or refill; undo and redo of a repost; and a removed post's like, reply and hashtag ranking staying, with new likes and replies of it refused;
- r1, whose "gone" post is now a moderator removal.

The pre-M draft `C94i8Hwr…` passed 221 checks earlier. Its 4 SKIPs and 3 transport FAILs are explained below.

- **SKIPs:**
  - x3a and y1f-y1g need a fresh identity with no DashPay profile and no starter claim (`--fresh-bot`). The only such bot is reserved for the migration's battery.
  - r2 needs a seated team.
  - k2 needs a bot with no YAPP.
- **FAILs:** the 3 were transport faults, not v11 behaviour. r1i and r1j hit "Quorum not found in cache" during a quorum rotation, and s1b's proved status read came back from a lagging node. The re-run of r1 and s1 alone (`--only r1,s1`) passed all 33 checks.

The v11 switches all passed:

- **m1k:** an interim removal keeps the untagged post's `$createdAt`, and no hashtag.
- **t2h-t2o:**
  - an unlike with no `$createdAt`;
  - the 24h tag window and the 3-day window still count it;
  - the all-time `byHashtagPost` drops it;
  - a re-like counts once.
- **n2b-n2g:**
  - the author-pinned liker read has no time;
  - the heart state;
  - unlikes with no time, for a post and a reply.

Every carried v10 case passed, the action-fee, token, ban, warning and report cases included.

**What the node taught us** (the client follows all of these):

- **Several targets' likers in one read must pin the author.**
  - `like` where `postAuthor == me && postId in [...]`, ordered `[postAuthor, postId]`, works on `byAuthorPost`; the same holds for `likeReply` on `byAuthorReply`. Rows come back without a time.
  - `postId in [...]` alone on `byPost` is refused: "an `in` clause on an indexOnly prefix property requires an EQUALITY clause on the terminal". The heart state form, `postId in` + `$ownerId ==`, is unaffected.
- **One target's likers are paged by a keyset on the terminal:** `postId == T && $ownerId > <last>`, ordered `[postId, $ownerId]`. An id cursor is still refused on indexOnly.
- **The SDK drops a `$createdAt` an unlike carries on a type that outlives deletes**, so the delete is accepted either way. The client never sends one.
- **Block time trails the local clock by up to a block or two.** Window-expiry checks poll instead of trusting the local clock, and the client already treats the minute around a deletion window's end as undecided (the node rules).
- **`deleteSettled` on a type the team cannot delete** passes both wasm parsers. The node refuses it with 10900, so `auditNodeRules` now flags it.

## Client (topology v11)

**Topology** (`lib/contract-topology.ts`):

- `v11` reuses every v10 surface; `isV10()` is true on v10 and v11.
- New helpers:
  - `isV11()`;
  - `IndexOnlyLikeShape.deleteNamesCreatedAt` (false on v11) and `authorTimeIndex: null`;
  - `likeNotificationsAreTimeless()`;
  - `settledDeletionFor(docType)` (`{ windowSeconds, leaderRequired, approvals }`), `moderatorDeleteWindowSeconds(docType)` and `removalKeptFieldsFor(docType)`.
- Contract-derived values (windows, grant, fees, election) read the v11 JSON.

**Likes** (`like-service.ts`, `notification-service.ts`, `lib/like-notification-snapshot.ts`):

- **Unlike.** The client reads the heart state (`byPost`/`byReply`, `$ownerId ==`), then deletes by values: the like's content properties only, with no `$createdAt` and no tuple recovery or cache. Unliking something that isn't liked is a no-op.
- **Notifications.**
  1. Find the user's recent posts and replies with like counts. This is the v10 composite count slot, kept as `getRecentTargetLikeCounts`.
  2. Compare the counts with this device's snapshot.
  3. For targets whose count changed, read the likers with one author-pinned `in` read per kind. A full page falls back to per-target keyset pages.
  4. Diff against the stored likers. New likers become one notification per target, "Alice and N others".
- **Snapshot.** Scoped storage key `yappr_like_notifications:<userId>`. It keeps only the recent targets and keeps batches for 7 days, at most 100.
  - The first poll per kind is a silent baseline.
  - The snapshot also keeps a horizon: the time of the oldest recent target per kind. An older post that re-enters the recent window (for example after a newer one is deleted) is recorded silently.
  - Stored likers are merged with each read unless the count fell. A read that lists fewer likers than the count stores the lower count, so a node a block behind is read again next poll. A liker already named in a kept batch is not named again.
  - Each target tracks at most 200 likers. Past that it stops naming new ones.
  - A poll whose snapshot did not save creates no new batch.
  - Two tabs serialize through `navigator.locks` where the browser has it; otherwise a poll that sees another tab's save keeps that one and diffs again next time.
  - Batches count as delivered only after a poll succeeds.
  - The user is never their own liker.
  - Like notifications stay out of the poll watermark.
- **The notifications page** shows the aggregate and hides the relative time for these alone.
- **Unchanged.** Profile Top, top creators, trending and hashtag Top name no index and keep their v10 queries.

**Design M: tombstones** (`lib/services/tombstone-helpers.ts`, `post-service`/`reply-service` `deleteOwnPost`/`deleteOwnReply`, `lib/feed/hidden-tombstones.ts`, `components/post/*`):

- **Topology.** `deletesAreTombstones()` is true on v9 and v11.
  - `tombstoneKeepsEmptyContent()` is v9 only. v9 writes `content: ''`; v11 leaves every content field out.
  - `tombstonesAreHidden()` is v11 only: hide the tombstone and show a stub, where v9 shows a deleted card in place.
  - `repliesOutliveTheirParent()` is true on v10 and v11. A moderator's removal still leaves a hole on v11, and the thread stubs it.
  - `likeTreesArePreallocated()` is v11 only.
- **Delete and undo repost.**
  - A delete is a tombstone: a post's is `{ deleted: true, hashtag? }`, a reply's `{ deleted: true, rootPostId, replyToReplyId?, parentOwnerId }`, a bare repost's `{ deleted: true }`.
  - Undo repost tombstones the bare repost, clears the viewer's own-repost state and drops the count optimistically. Redo is a new bare repost.
  - Tombstoning an already-tombstoned document is a no-op on every topology.
- **Rendering.**
  - A tombstone renders as "This post was deleted by its author", which is distinct from the moderator stub ("Removed by moderators · #tag · posted <date>").
  - It offers no like, reply, quote, repost, bookmark or menu.
  - In a thread, a tombstoned reply with live children stays as a stub so the thread keeps its shape, and one with none is dropped.
- **Hiding.** Tombstones are hidden from:
  - For You, Following, the new-posts poll, profile posts and replies, hashtag Latest and Top, search and explore;
  - bookmarks, mentions, and the reply, quote and like notification targets;
  - every Top list.
- **Zero groups.** The ranked readers drop zero-count rows on every topology. Preallocated trees make them common on v11; elsewhere the result is unchanged.

**Moderation** (`moderation-service.ts`, `components/moderation/*`):

- **Removal records** carry `kept` (`hashtag`, `rootPostId`, `createdAt`), shown on removed-post stubs and in the removal list.
- **A post's deletion phase** is `open`, `closing` or `settled`. `closing` covers the 60 s either side of the window's end: the single delete is still offered there, and a 41116 switches to the team route. The Remove menu reads "Remove post (settled: team only)" for a settled post.
- **For a settled post, a seated member gets "Propose team removal".**
  - The reason must be one the team's charter lists.
  - The modal says it needs the leader plus N members and cannot be undone.
  - If another member already proposed the same post, it offers "Approve the proposed removal" instead, or "You already approved (n of m)" to a member who signed it.
  - When no team is seated, or the viewer is not on it, the modal explains that.
  - `seats()` counts unfilled added seats, so a team smaller than the rule (a leader with one member) could never meet it, and a proposal never lapses. The modal and the panel then warn that the team must add a member, and Propose is disabled.
- **The team removals panel** lists the newest 20 active proposals with "2 of 3 approvals", whether the leader is still needed, who signed, the post, the reason, and Approve or "You approved". Signers and liveness are read for the shown rows only, and a proposal whose post is already gone is dimmed with no Approve. Closed actions are one page, labelled a sample when there are more (action ids carry no time order). There is no restore button.
- **v2, v9 and v10** resolve the single delete synchronously, and read team seats only on v11.
- **Team seats and per-member action counts** show beside the moderators pot (`moderationActionCounts`). The pot's action share splits by these counts.
- **Errors** 41116 and 41204-41211 have messages, plus `DOCUMENT_GONE` for an approval whose document is already deleted.

## Tooling

- **`scripts/validate-contract-offline.mjs`** passes v11 with `--strict-size --cost`.
  - The probes add a v11 control and 14 v11 probes: the `outlivesDelete` key rule, ttl and stored-type refusals, the partial-adoption control, the `deleteSettled` bounds 1-26 and its need for `deleteWithin`, a 0 s window, and `deleteKeepsFields` naming `$id`, an unknown property, an unrequired time, or a record kept nowhere.
  - Design M adds 10 probes. The wasm-sdk refuses:
    - a `deletableDocument` reference at the moderated post;
    - a preallocated `byHashtagPost` whose hashtag the record does not keep;
    - preallocation on a window, or on a stored type's count index;
    - a derived quote owner on a clearable quote, and a derived post owner on `like`.
  - `auditNodeRules` (node: 40143) flags a moderated reference at an author-deletable post.
  - Three M probes are recorded as legal: an undoable tombstone flag, a conditional freeze on the hashtag, and a derived root owner on a reply.
  - `auditNodeRules` adds two rules: a `deleteSettled` type the team cannot delete (10900), and `deleteSettled` without an elected team (10231).
  - The `propertyConstraints` cases run against the v11 file: v10's rules plus 9 tombstone cases (`tombstoneIsBlank`).
- **`scripts/prove-merged-counts.mjs`**:
  - `--contract-file` selects the cut.
  - v11 replaces the time-based like reads (dc-e, dc-h, dc-k) with the `ol-*` checks, drops zero rows from rankings (preallocated trees), and adds `M-*` (design M), `kf-*` and `tm-0*`.
  - `--team-proof <contractId> --reason-doc <id>` runs the team phase.
  - It takes a fourth identity, D. Phase 1 writes its targets to a `--state-file` for the record. The team phase writes fresh targets and compares action counts as deltas, so it can run again.
  - A quorum rotation rebuilds the SDK instance and re-runs the read (as verify-lib does); writes that must not be sent twice are not retried.
- **`scripts/verify-v10.mjs`**:
  - `--contract-file contracts/yappr-social-contract-v11.json` switches t2, n2 and m1 to the v11 behaviour, x1 to the design-M tombstone case (x1t*), and the self-test to v11's pins. Fixture cleanups tombstone, and r1's "gone" post is a moderator removal.
  - `--moderator bot:<n>` accepts the bot that registered a draft, checked against the contract's owner.

## Publishing (the migration's job)

The file to publish is the final sha above, at about 19,639 B signed. That is under both the 20,480 B hard cap and the 20,000 B budget.

**E1, the elected moderation the contract fixes:**
- **Unchanged from v10:** join and vote windows of 3,600 s each; `seatContestable: false`; `maxAddedModerators: 10`; interim `contractOwner`; `ownerProtected: true`; the team holds `deleteDocuments`, `ban`, `suspend` and `warn` on post and reply, `deleteDocuments` and `changeDocumentFields` on report, and `deleteDocuments` on yapprProfile.
- **New on post and reply:** `deleteWithin: 604800` and `deleteSettled: { leader: true, approvals: 3 }`.
- **The team needs a leader and at least two members**, or a settled post can never be removed. `seats()` counts unfilled added seats, so the client warns when the team is too small.
- **Until a team is seated, nobody can remove a post or reply older than 7 days (41205).** Seat E1 promptly after publishing.
- The charter should list SPM, ABU and REP, as for v10.

**Also:**
- A new social id means storefront, blog and pollr are published again, since they embed the social id for YAPP prices. DM, key exchange and the vaults are reused.
- Set `NEXT_PUBLIC_CONTRACT_TOPOLOGY=v11` with the new id.
