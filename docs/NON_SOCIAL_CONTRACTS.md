# Non-social contracts: storefront, blog, DM, pollr, tips

The four feature contracts outside the social graph, re-cut for **Platform
4.2.0-beta.2 / protocol 14**, plus YAPP tipping (which needs no contract of its
own). Each JSON in `contracts/` is the source of record; `docs/` carries no
per-contract file any more.

All four are registered on the **moutai devnet** (2026-09-18), alongside social
v7 `7R7vo8DE2pka17wAgXMnUMWpSox2z8eaLLdZNYJcWraG` whose YAPP token prices the
doctypes that cost YAPP:

| Contract | moutai devnet id |
| --- | --- |
| storefront | `6D1UPEqaYDwrnzy7c7STbMM6HBmksbp3zzMgSqr68Bi1` |
| blog | `G2SebukaFvvgBWS1Q61Me8sWc3TMzAhXt2QvAktuYvvf` |
| DM | `HBwg5hptWu1Ppgi9NadLad8cAYHHoQjHpUUb1t5w4cjF` |
| pollr | `7qVgjaNoZexX5xioVgVF8aZh1RsZv7hqtuXGhLtGT9n2` |

**Testnet and production still run the previous cuts**, which is why every
client path is selected at runtime by a topology env var
(`NEXT_PUBLIC_{STOREFRONT,BLOG,DM,POLLR}_TOPOLOGY`, resolved in
`lib/constants.ts`) and why the old-topology code cannot be deleted yet.
Repointing a contract id orphans the documents in the old one — references
cannot cross contracts — so a re-cut is a fresh start, not a migration.

Note for anything writing to the social contract: **v7 removed `post.author`**
and sets `additionalProperties: false`, so a write still carrying it is rejected
with *"Additional properties are not allowed ('author' was unexpected)"*, and
`hashtag` must be omitted entirely rather than sent as `''` when untagged.

## Deploy and verify

```bash
# Inspect what will be registered (offline, full wasm validation; prints
# indexes, references, token costs and the parsed immutable lists).
NETWORK=devnet node scripts/register-feature-contract.mjs --file yappr-blog-contract.json --dry-run

# Publish under a seed persona (or --bot <n> --owner <id>).
NETWORK=devnet node scripts/register-feature-contract.mjs --file yappr-blog-contract.json --persona 260

# Live batteries (each also takes --self-test, which runs offline and asserts
# the checked-in JSON still declares every rule the battery relies on).
NETWORK=devnet node scripts/verify-storefront.mjs
NETWORK=devnet node scripts/verify-blog.mjs
NETWORK=devnet node scripts/verify-dm.mjs
NETWORK=devnet node scripts/verify-pollr.mjs
NETWORK=devnet node scripts/verify-tips.mjs [--tipper 240] [--creator 241] [--amount 5]

# Seed browsable content (deterministic and resumable; --dry-run is offline).
NETWORK=devnet node scripts/seed/seed-non-social.mjs --which storefront|blog|dm|pollr|tips
```

Contracts priced in YAPP name the **social** contract in
`tokenCost.create.contractId`; the registration script substitutes the
`SOCIAL_CONTRACT_ID` placeholder with its 32-byte array form, so the social
contract id is an input to every registration.

---

## Storefront

`contracts/yappr-storefront-contract.json` — `store`, `storeItem`,
`shippingZone`, `storeOrder`, `orderStatusUpdate`, `storeReview`, `itemReview`,
`savedAddress`. Client gate: `NEXT_PUBLIC_STOREFRONT_TOPOLOGY=v2`.

| Doctype | Shape | Serves |
| --- | --- | --- |
| `store` | `canBeDeleted: false` (`closed` is the tombstone) | permanentDocument target |
| `storeItem` | `canBeDeleted: false`; `storeId`→store **writer-gated**; `immutable [storeId]` | item reviews, ghost-store rejection, seller-only listings |
| `shippingZone` | `storeId`→store **writer-gated**; `immutable [storeId]` | seller-only zones |
| `storeOrder` | permanent; `storeId`→store `{sellerId: $ownerId}`; countable buyer/seller indexes; ranked `storeOrderCount` | order badges, "most ordered stores", consensus-true seller |
| `orderStatusUpdate` | `orderId`→storeOrder **writer-gated to the seller**; `buyerId` bound to the order's `$ownerId` | buyer status feed carrying only the seller's updates |
| `storeReview` | `orderId`→storeOrder **writer-gated to the buyer**; `storeRating` avg+count ranked; `sellerRating` avg ranked; `storeRatingDistribution` grouped count; 3 YAPP | averages, distribution, top rated |
| `itemReview` | one per (order, item); `itemId`→storeItem `{storeId}`; `orderId` **writer-gated**; `itemRating`, `storeItemRating` avg ranked; 1 YAPP | item averages, top items |

**Writer gates.** beta.2 lets the *referring* side of a `propertyAgreement` be
`$ownerId`, which turns a reference into a gate: only the identity the
referenced document names may create — or replace — the referring document.
Checked on create and on every replace, so it cannot be slipped past by writing
first and editing later. The four declarations are
`storeItem.storeId`/`shippingZone.storeId` → `{$ownerId: $ownerId}` (only a
store's owner lists under it), `orderStatusUpdate.orderId` → `{$ownerId:
sellerId}` (only the seller posts a status), `storeReview.orderId`/
`itemReview.orderId` → `{$ownerId: $ownerId}` (only the buyer reviews), and
`storeOrder.storeId` → `{sellerId: $ownerId}` (`sellerId` is the store's real
owner).

Consequences the client no longer enforces: every review on chain is a verified
purchase; a stranger cannot burn an order's single review slot; `getLatestStatus`
is one row rather than a walk through pages of spoofable updates; and the
attested copies `storeOrder.buyerId`, `orderStatusUpdate.sellerId` and
`storeReview.buyerId`/`itemReview.buyerId` are gone.

```js
// Store average: {count, sum}; the client divides.
sdk.documents.average({ dataContractId, documentTypeName: 'storeReview',
  where: [['storeId', '==', S]] }, 'rating')
// 1..5 distribution in one call (keys are hex of 0x80 + rating).
sdk.documents.count({ dataContractId, documentTypeName: 'storeReview',
  where: [['storeId', '==', S], ['rating', 'in', [1,2,3,4,5]]], groupBy: ['rating'] })
// Top stores by average (`value / valueScale`). Same grammar with
// aggregate {type:'count'} on storeOrder = most ordered stores; on itemReview
// with groupBy 'itemId' + where storeId = top items in one store.
sdk.documents.ranked({ dataContractId, documentTypeName: 'storeReview',
  groupBy: 'storeId', aggregate: { type: 'avg', property: 'rating' }, limit: 20 })
// documents.having takes the same shape plus having:{operator:'>=',value:3}.
// Buyer orders page in one proof: orders + store join + review-exists + status.
sdk.documents.composite({ dataContractId, documentType: 'storeOrder',
  where: [['$ownerId', '==', me]], orderBy: [['$createdAt', 'desc']], limit: 50,
  subQueries: [
    { documentType: 'store', bind: { sourceProperty: 'storeId', field: '$id' } },
    { documentType: 'storeReview', bind: { sourceProperty: '$id', field: 'orderId' } },
    { documentType: 'orderStatusUpdate', bind: { sourceProperty: '$id', field: 'orderId' }, limit: 100 },
  ] })
```

Cold-load DAPI budgets: `/store` directory 1 + 50 review scans → 1 + 50 averages
(6 at a time); `/store/view` ≥ 7 + ⌈reviews/100⌉ → 7 fixed; `/orders` 1 + 4N →
1 composite + N decrypts; `/orders/seller` 1 + 2N → 1 + ⌈N/100⌉ + 1 DPNS batch;
manage badge 1 capped (wrong) page → 1 count.

Not adopted: sums of order amounts (orders are encrypted to the seller, so there
is no plaintext amount — order counts rank stores instead); stock decrement on
purchase; buyer-initiated status updates, which would need a second doctype
gated the other way rather than a loosened gate; `immutable` on
`store`/`savedAddress`, every property of which the owner edits.

---

## Blog

`contracts/yappr-blog-contract.json` — `blog`, `blogPost`, `blogComment`,
`blogFollow`. Client gate: `NEXT_PUBLIC_BLOG_TOPOLOGY=v2` (`blogIsV2()` reads
`process.env` at call time so unit tests can stub it).

| Doctype | Shape | Serves |
| --- | --- | --- |
| `blog` | `canBeDeleted: false`, `canBeDeletedByModerators` | deletableDocument target (its owner can never delete it; a moderator can) |
| `blogPost` | `blogId`→blog (deletableDocument); `immutable [blogId, publishedAt]` with `publishedAt` under `immutableAllowSetting`; `canBeDeletedByModerators` | ghost-blog rejection; a post cannot change blogs or be re-dated |
| `blogComment` | `blogPostId`→blogPost (deletableDocument) with `{blogPostOwnerId: '$ownerId'}`; ranked `commentCount [blogPostId]`; `postOwnerAndTime`; 1 YAPP; `canBeDeletedByModerators` | exact counts, "most discussed", unforgeable "comments on my posts" |
| `blogFollow` | `blogId`→blog (deletableDocument); ranked `followerCount [blogId]`; `followersByDay [$createdAt, blogId]` on the daily grid with a 7-day ttl | exact follower counts, "most followed", "trending today" |

**v3 (4.2.0-beta.3) is the moderated cut.** The contract config declares
`moderation: { banlist, suspensions, moderators }` (see `docs/SOCIAL_V8.md`
for the grammar), and `blog`, `blogPost` and `blogComment` carry
`canBeDeletedByModerators`, so the moderation team can take an abusive blog,
post or comment down. Two consequences: every reference at those types is a
`deletableDocument` reference (a moderator-deletable type counts as deletable;
`permanentDocument` at it is refused with 40122), so a reader must expect
`blogPost.blogId`/`blogComment.blogPostId`/`blogFollow.blogId` to resolve to
nothing after a takedown; and **the edit-history feature is gone** —
`documentsKeepHistory` was dropped from `blog` and `blogPost`, because Drive
refuses moderator deletes on a history-keeping type. `blogPost.$revision > 1`
still marks an edited post, but the previous revisions are no longer stored
and `documents.history` has nothing to return.

`blogPost` carries no `author`: the author IS `$ownerId`, which the comment
agreement binds to directly and which `ownerAndTime` already indexes. Because
`blogPostOwnerId` must agree with the referenced post's `$ownerId` (40127),
`postOwnerAndTime` is safe to read as a notification source — nobody can inject
a row into someone else's feed — and a comment on a post that does not exist is
impossible (40120). `blog-comment-service.ts` still fetches the post before
commenting, not to decide whom to trust but because the write must carry that id
verbatim and the caller's copy may be stale. There is deliberately **no writer
gate** here: anyone may comment on anyone's post — that is the feature.

```js
// Comment count for one post, and for a whole post list in one request.
sdk.documents.count({ dataContractId, documentTypeName: 'blogComment',
  where: [['blogPostId', '==', P]] })
sdk.documents.count({ dataContractId, documentTypeName: 'blogComment',
  where: [['blogPostId', 'in', [P1, P2]]], groupBy: ['blogPostId'] })
// Most followed blogs, and trending today (drop the timeRange for all-time;
// the same shape on blogComment/blogPostId gives most discussed posts).
sdk.documents.ranked({ dataContractId, documentTypeName: 'blogFollow',
  groupBy: 'blogId', aggregate: { type: 'count' }, direction: 'desc', limit: 20,
  timeRange: [{ field: '$createdAt', selector: 'newest', grid: { range: 86400, step: 86400 } }] })
// Comments on my posts since last seen (notification source).
sdk.documents.query({ dataContractId, documentTypeName: 'blogComment',
  where: [['blogPostOwnerId', '==', me], ['$createdAt', '>', lastSeen]],
  orderBy: [['blogPostOwnerId', 'asc'], ['$createdAt', 'desc']], limit: 100 })
```

Cold-load budgets: blog home goes from 1 posts page + a full cursor scan per
100+-comment post to 1 posts page + 1 grouped count per 100 posts; the follower
badge from ⌈followers/100⌉ to 1 count; `/blog` discovery rankings were not
affordable at all before. `blogStatsService.mostDiscussedPosts()` is proved and
exposed but has no page — the ranked axis is global, so it cannot be pinned to
one blog, and the app has no cross-blog post feed yet.

---

## Direct messages

`contracts/yappr-dm-contract.json` — `conversationInvite`, `directMessage`,
`readReceipt`. Client gate: `NEXT_PUBLIC_DM_TOPOLOGY=v4`.

**DMs must stay cheap**, and that constraint — not a lack of ideas — is what
makes this the smallest re-cut: two additive flags, no new doctypes, no ranked
or timeRange indexes, no indexOnly rewrite, no token costs. Deliberately not
adopted for the same reason: `refersTo`/`propertyAgreement` on
`directMessage`/`readReceipt` (a read per write on the hottest path), ranked and
`timeRange` indexes, an ephemeral `presence` doctype, `immutableAllowSetting`
anywhere, and a `countable` flag on `conversationInvite.inbox`.

| Doctype | Change | Frozen |
| --- | --- | --- |
| `conversationInvite` | `recipientId` refersTo `{type: identity}` — a ghost recipient is refused at write time (40120) | `recipientId`, `conversationId`, `senderPubKey` |
| `directMessage` | `conversation [conversationId, $createdAt]` gains `rangeCountable` | `conversationId`, `encryptedContent` |
| `readReceipt` | — | `conversationId`, so a replace can only move `$updatedAt` |

`immutable` is checked only when a replace is validated: it adds nothing to the
create path every message takes, which is why it is the one beta.2 feature DMs
adopt. `senderPubKey` is frozen plain rather than allow-setting, so a sender who
later rotates to a hash160 key cannot add it to an existing invite (40128 on an
add) and must delete and recreate — an invite whose sender key appears later is
a different claim about a moment that has passed.

```js
// Total messages, and unread after the viewer's read receipt. One call each.
sdk.documents.count({ dataContractId, documentTypeName: 'directMessage',
  where: [['conversationId', '==', C]] })
sdk.documents.count({ dataContractId, documentTypeName: 'directMessage',
  where: [['conversationId', '==', C], ['$createdAt', '>', lastReadAt]] })
// Totals for the whole list in one call — NO range clause (see rule 3 below).
sdk.documents.count({ dataContractId, documentTypeName: 'directMessage',
  where: [['conversationId', 'in', [C1, C2]]], groupBy: ['conversationId'] })
// conversationId is a plain 10-byte array, so operands are base64 and
// grouped-count keys are the hex of those bytes.
```

The switch changes **reads only** — v4 writes are byte-identical to v3's — so a
mismatch is never rejected by consensus, and is not harmless either: pointing
`v4` at a contract without the count flags makes every count fail, so unread
reads as 0 and the badge silently never appears. `countUnreadByConversation`
logs a warning naming that cause.

**Unread is not exactly v3's unread.** The `conversation` index carries no
`$ownerId`, so a count cannot exclude the viewer's own messages; adding that
axis would mean a second index branch on every message write, which is the cost
DMs are not allowed to pay. Two things keep it honest: a conversation whose
newest message is the viewer's own reports 0 (the count is skipped), and
otherwise the count can exceed the truth only by the messages the viewer sent
since their last receipt. With read receipts **disabled** no receipt exists at
all and the count would be the whole history, so `getUnreadTotal` returns 0 and
the global badge stays hidden; it returns **`null`**, not 0, when it cannot tell
(any count or page failed), since publishing 0 would read as "all caught up".
The badge rides the existing 30 s notification poll — no second timer — is
skipped while the tab is hidden, and never decrypts or resolves identities,
because `decryptMessage` prompts for a private key.

**Contract-bound encryption keys remain unusable**, and the note in
`lib/services/identity-update-builder.ts` blaming "SDK/tooling bugs" misplaces
the cause: Drive refuses a `SingleContract`-bounded ENCRYPTION key with
*"contract: key bounds expected but not present"* because such a key is only
accepted against a contract that declares `requiresIdentityEncryptionBoundedKey`
— and no identity can hold one until the contract requires it. Turning either
`requiresIdentity{Encryption,Decryption}BoundedKey` on would therefore break DMs
for every existing identity on the day of the cut, so both stay unset. The
battery probes this and never fails on it.

---

## Polls (Pollr)

`contracts/pollr-contract.json` — `poll`, `vote`, `multiVote`. Client gate:
`NEXT_PUBLIC_POLLR_TOPOLOGY=v4`.

| Doctype | Shape | Serves |
| --- | --- | --- |
| `poll` | `canBeDeleted: false`, no `author` | its `$ownerId` is the agreement source for `pollOwnerId` |
| `vote` | indexOnly; `pollId`→poll `{pollOwnerId: '$ownerId'}`; `byPoll` (preallocated) structural single ballot; `byPollChoice` count + ranked; `byPollOwner` (preallocated); `byVoterChoice` | body-less flat-priced ballots, ghost-poll rejection, O(log n) winner |
| `multiVote` | the same minus any `[pollId]`-terminating index | one entry per (poll, voter, choice) |

Ballots are free — no `tokenCost`. Structural uniqueness already caps what one
identity writes per poll, and pricing a vote would make polls useless.

**Single-choice is structural.** indexOnly types cannot declare `unique`
indexes — uniqueness is a property of the storage, one entry per value tuple and
terminal — so `byPoll [pollId] terminal $ownerId` *is* "one ballot per voter per
poll". A second ballot comes back as `duplicate unique properties ["pollId",
"$ownerId"]`, which the client routes by text (`isDuplicateVoteError`); a lot
hangs off that predicate, because a duplicate misread as an ordinary error would
be handed to the landed-write probe, which finds the voter's *earlier* entry and
reports the rejected write as cast. `multiVote` must NOT have that index — any
index terminating at `[pollId]` would make a second selection a duplicate — so
every `multiVote` index carries `choice`. The cost is that nothing counts
*distinct voters* on a multi-choice poll.

**No `$createdAt` anywhere.** Keeping no time index leaves `$createdAt` out of
`required`, so a ballot's delete tuple is just `{pollId, choice, pollOwnerId}`
and unvote is one hop (social-contract likes must first recover the consensus
`$createdAt` from a time-carrying projection). The price is no vote history: no
"recent votes", no "trending polls today".

```js
// Per-option tally (keys are hex of 0x80 + choice) and winner in O(log n).
// Ranked pages hand integer group values back DECODED.
sdk.documents.count({ dataContractId, documentTypeName: 'vote',
  where: [['pollId', '==', P], ['choice', 'in', [0, 1, 2]]], groupBy: ['choice'] })
sdk.documents.ranked({ dataContractId, documentTypeName: 'vote',
  groupBy: 'choice', aggregate: { type: 'count' }, where: [['pollId', '==', P]], limit: 1 })
// My choices on one poll (also the write-confirmation probe for an indexOnly
// ballot, with choice '==' and limit 1). An `in` on an indexOnly PREFIX
// property REQUIRES the matching orderBy or the query is refused outright.
sdk.documents.query({ dataContractId, documentTypeName: 'multiVote',
  where: [['pollId', '==', P], ['choice', 'in', [0, 1, 2]], ['$ownerId', '==', me]],
  orderBy: [['choice', 'asc']] })
```

**Confirming an indexOnly write.** `documents.get` cannot confirm a ballot —
there is no row under the id — so the landed-check always comes back empty and a
DAPI 504 yields `{success: true, confirmed: false}` whether or not the
transition was rejected. `castVote` therefore treats an unconfirmed success
exactly like a reported failure: it polls the entry probe and classifies on what
the chain shows, because a single-choice ballot is one-shot and reporting an
unverified one as cast would close the ballot on a vote that never landed. The
tally's last-resort path has the mirror-image constraint: `paginateFetchAll`
cursors on `$id` and an indexOnly type's synthesized ids address nothing, so it
keyset-walks the terminal (`countByChoiceKeyset`) and fails outright when no
cursor can be recovered rather than returning a truncated tally.

**The standalone Pollr app needs the same cut.** The testnet contract
(`GBCR8Jqt…`) is externally owned and is what
`https://pastapastapasta.github.io/pollr` reads; only the devnet clone is ours.
A v4 poll is written exactly like a v3 one, so that app's poll-create path needs
no change — only its ballot path does. `scripts/verify-poll-interop.mjs` works
against a v4 contract for the same reason.

---

## Tips (a YAPP transfer, cited by a document on the social contract)

A tip is a **YAPP token transfer**. YAPP's token config sets
`keepsTransferHistory`, so consensus writes an immutable, undeletable
`transfer` document into the system token-history contract
(`43gujrzZgXqcKBiScLa4T8XTDnRhenR9BLx8GWVHjPxF`, the same id on every chain) as
part of applying the transfer. Its `$ownerId` (sender), `toIdentityId`,
`amount`, `tokenId` and `$createdAt` are therefore facts.

**What ties that payment to a post is a document, not a note.** From social v9
(docs/SOCIAL_V9.md) a `tip` / `tipReply` document CITES the transfer by id,
cross-contract, and the contract binds what it says about it: the writer must be
the transfer's sender, `amount` must equal the transfer's amount, and
`recipientId` must be both the transfer's recipient and the tipped document's
author. So a post's tips are an ordinary indexed query with proved amounts on
them, and the read path never touches token history at all.

Before v9 the link was the sender's `publicNote` (`lib/tip-note.ts`, encoding
`yappr:tip:v1:post:<id>`), which consensus never reads — so a post's tips could
only be found by scanning the author's newest 100 incoming transfers and parsing
notes. **Deployments below v9 show no tips**: the note is still written, for
wallets that display it, but nothing renders it as a tip on a post.

What is still not proved, and is the only caveat left: self-tipping from a
second identity — the money moves, it is just the tipper's own, which is why the
strip names who each tip came from rather than showing a bare total.

What CANNOT be had yet: a proved sum of amounts. `summable` on the tip's
`amount` is not expressible, because the agreement that makes the amount
trustworthy forces it to U64 and `summable` refuses U64
(docs/PLATFORM_SUMMABLE_AGREEMENT_GAP.md). Count trees give a proved lifetime
COUNT instead; a per-post total is summed from that post's own tips, which its
count tree says is all of them.

```json
{ "dataContractId": "<social v9>", "documentTypeName": "tip",
  "where": [["postId", "==", "<post>"]],
  "orderBy": [["postId", "asc"], ["$createdAt", "desc"]], "limit": 100 }
```

**Signing.** A batch carrying a token transition requires a **CRITICAL**
authentication key, which Yappr does not hold for wallet-login users, so the
transfer has two paths mirroring buy-YAPP: local
(`tipService.sendYappTipLocal`) when this browser holds one or the user pastes
one, otherwise an unsigned `TokenTransferTransition` in a `dash-st:` QR. Either
way the transfer document is then read back off the SENDER's own index — that
id is what the tip cites, and seeing it is the only evidence the transfer
landed.

**Never retry a tip blindly.** DAPI 504s on transitions that landed, and a tip
is money, so "the SDK threw" must never become a Try Again button. Every
confirmation-shaped failure funnels into `tipService.confirmYappTip`, which
polls the chain. Recording the tip is a SEPARATE write that can fail on its own
(a citation Drive cannot resolve yet is a paid 40120), and its retry re-records
the same transfer — reusing the reply already posted for it — rather than
sending anything. A 40105 on the unique `transferId` index means the tip is
already there.

A deployment whose social contract has no YAPP token has no YAPP tips: the
`/testing` social contract predates the token, so its YAPP tab reads 0.

---

## Platform rules these cuts established

1. **`rankedCountable: true` on an `averageable` index is refused at
   registration** with `"rangeCountable" is a required property`. The
   meta-schema's dependency rules run on the literal keys before the sugar is
   expanded, and the wasm validator (`DataContract.fromJSON(.., true, ..)`)
   compiles that check out — so it passes offline and fails on chain. Spell the
   `range*` axes out. Upstream: dashpay/platform#4809. beta.2 relaxes exactly
   one link: `rangeCountable: true` now implies `countable: "countable"`.
   Assume every other flag is required until the meta-schema says otherwise.
2. **`tokenCost.create.contractId` must be the 32-byte array form** in the
   registered JSON; base58 is refused at registration although the offline
   validator accepts it.
3. **`IN` + a range in one grouped count returns an EMPTY map, not an error.**
   Served on the no-proof path only; on the proved path it answers with no
   groups at all. A silent zero is worse than a rejection, so the client never
   uses that shape. The IN-only grouped count is proved and correct.
4. **A writer gate fails as the SAME consensus error a value pair does** —
   `ReferencedDocumentPropertyMismatchError`, state code 40127 — with the
   signing identity on the referring side. `$ownerId` on the LEFT is what tells
   them apart, which is how `isWriteGateError` in `lib/error-utils.ts`
   classifies it: a value mismatch means stale data (reload and retry), a gate
   means the wrong signer (retrying never helps).
5. **`immutable` rejects a replace that removes or adds a frozen property**, not
   only one that changes it (40128); `immutableAllowSetting` is the single
   exception and fires once. Audit every replace path before freezing anything:
   `update()` merges into a full replace and hands identifiers back as base58,
   so a re-encoded identifier is now rejected outright.
6. **`timeRange` (including `ttl`) is accepted on an ordinary doctype** — it
   does not require `indexOnly`; the ttl drains the index entries, the documents
   stay. Proved rather than assumed: an unfollow drops the all-time count, the
   ranked page and the windowed page together, and on a scratch registration
   with a 60 s grid / 120 s ttl a delete *after* the windowed count had fallen
   to 0 was **accepted and decremented the all-time count** — Drive does not
   require the drained entry to exist, so an unfollow a week later cannot
   strand a user.
7. **A ranked read on a bucket nothing landed in fails proof generation**
   instead of proving an empty ranking: *"a single-path axis read must produce
   exactly one axis descent"*. That error IS the empty answer; the stats
   services map it to `[]`.
8. **`preallocated` cannot cover an index with a non-reference property.** The
   flag promises the whole index path is a pure function of one referenced
   document, so every property must be the refersTo property or a
   `propertyAgreement` key (rs-dpp `index::preallocation`). Measured: a v4 poll
   create costs ~18M credits more than the same poll on the v3 clone.
9. **A ranked index's prefix may not also terminate an aggregating index**, and
   **`rangeCountable` does not give you a prefix count** — a bare
   `count where pollId == P` is refused on both ballot doctypes. The
   `rankedCountable: {at: […]}` form that social v5 uses is unavailable when a
   plain index terminates at the `at` level.
10. **A terminal must be `$ownerId` or a refersTo identifier**, so no index can
    be keyed (poll, voter) → choice.
11. **Composite lookups on a unique index take no `limit`**; lookups on a
    non-unique index take no `orderBy` (they inherit the page's direction).
    Count sub-results are keyed by the hex of the bound identifier's bytes.
12. **The prefix-overlap rule does not fire for a single-property ranked index**
    sitting beside a plain compound one (`commentCount [blogPostId]` next to
    `postAndTime [blogPostId, $createdAt]`).
13. **An indexOnly document cannot self-expire.** Tried on the key-exchange
    contract and dropped: IN_TIME_RANGE reads are refused on indexOnly types and
    raw where-clauses never route to a bucketed index, so the payload must live
    in a permanent index anyway and the TTL only buys an aggregate. Measured on
    moutai: 93.8M credits per response against 66.3M on the stored v2 contract
    (+42%), with no storage refund. `key-exchange-v2.json` stays.

## Not possible at 4.2 — do not design around these

Consensus-enforced poll expiry; stock decrement on another owner's document, or
any cross-owner mutation; pay-to-referenced-owner token effects and two-party
atomic transitions (the batch cap is one document transition); ranked reads with
an arbitrary pin set ("top stores among those I follow"); unique indexes on
indexOnly types; MIN/MAX; multi-clause HAVING; cursors on ranked/having/
composite; creating budgeted or contract-bound authentication keys from the JS
SDK; adding index flags to a live contract — every change above is a re-cut.

## Deferred

Sellable documents (`tradeMode`/`transferable` with `keepsPurchaseHistory`) and
sponsored writes (`gasFeesPaidBy`) are unexercised anywhere in Yappr. Scoped app
keys — a wallet-granted AUTHENTICATION key bound to the Yappr contract group
with `totalBudget` and `expiresAt` — are the right long-term login primitive but
are blocked on wasm-sdk key-creation options. `authVault`/`vault` would benefit
from `documentsKeepHistory` so a bad bundle overwrite is recoverable.
