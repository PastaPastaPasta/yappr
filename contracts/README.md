# Yappr Data Contracts

Dash Platform data contracts used by the Yappr dapp. The JSON here is the
source of record for what was registered; deployed contract ids live in
`lib/constants.ts` (testnet defaults) and the `.env.*` files (per-deployment
overrides).

## Social contract

| File | Status |
|------|--------|
| `yappr-social-contract-v2.json` | **Deployed** on testnet (`9oDC6xdg…`, staging/prod). 16 document types + the YAPP token. Topology `v2`: replies chain through a polymorphic `parentId`; like/repost/bookmark/quote share one `postId` keyspace. The on-chain copy has since gained the optional `post.embedContractId`/`embedDocType`/`embedId` fields via `scripts/update-social-contract.mjs`, and its YAPP token carries `keepsHistory` (transfer/freeze/mint/burn/pricing/purchase, all true — verified on chain 2026-09-18) which this file predates; `lib/contracts/bundled/testnet.json` is the faithful snapshot. |
| `yappr-social-contract-v10.json` | **The 4.2.0-beta.7 cut** for the bonsia devnet (topology `v10`, not yet registered). v9's interaction surfaces in the beta.7 grammar (`moderatorAbilities`, `refersTo.where`/`findBy`), with real deletes of immutable posts and replies instead of tombstones, content up to 1000 characters / 2000 bytes, no `language` (one global `timeline`), `mediaHash` + `mediaFingerprint` required with `mediaUrl`, `keyGeneration` for the private feed, no `beat` (rolling trending on `like.byTrendHashtagPost` 24h/6h and `like.byTrendPost` 72h/24h), `skipIfAbsent` on every stored index over an optional property, reports the moderators resolve (`status`/`resolution` through `changeFields`), the `yapprProfile` extension of the DashPay profile (the profile contract is retired on v10), and a YAPP that starts paused with no price or unpause authority. Counts read from the list indexes (made `rangeCountable`; no count-only twins), one `repliesOf` index carries threads and their counts, and reposts are content-less quotes (no `repost` doctype; one quote or repost per author per target; a post must have a body). A post or reply carries at most one mention (`mentionedUserId`, shaped like `hashtag`; no `postMention` doctype), the reply and quote notification indexes are 3.5-day windows written once and kept a week (processing only); mentions and likes keep permanent indexes; likes have no `byLiker` (the heart state reads `byPost`, and one time-last author index serves counts, rankings, notifications and the unlike). 17,110 B signed. See [docs/SOCIAL_V10.md](../docs/SOCIAL_V10.md). |
| `yappr-social-contract-v11.json` | **The 5.0.0-beta.1 cut**, was live on the sakura devnet until its 2026-10-06 wipe (topology `v11`). v10 plus D1: the like trend windows `outlivesDelete`, and the author indexes drop `$createdAt`, so an unlike names no time. D3: past 7 days only the seated team (the leader plus two members) deletes a post or reply. D4: removal records keep hashtag or root and `$createdAt`. Then **design M**: post and reply are moderated (`canBeDeleted: false`); every reference at them is `moderatedDocument`; the like trees are `preallocated` by the post's creator; and an author deletes with a tombstone (`deleted`, every content field cleared, conditional `immutable`). About 19,639 B signed, sha256 `374745b4…`. See [docs/SOCIAL_V11.md](../docs/SOCIAL_V11.md). |
| `yappr-social-contract-v12.json` | **The 5.0.0-beta.2 cut**, live on the sakura devnet since its 2026-10-06 wipe as `78osKsoZ…` (topology `v12`). v11 plus: `like.byAuthorPost`, `like.byHashtagPost` and `likeReply.byAuthorReply` are `summableOffCountIndex` counters of `byPost`/`byReply` (one counter per post instead of an entry per like; counts and rankings read the same, likers only through the target index), and `retractedWhen: {present: "deleted"}` on post and reply, so a banned or suspended author can still tombstone. 19,877 B signed, sha256 `5b9cf0cc…`. See [docs/SOCIAL_V12.md](../docs/SOCIAL_V12.md). |
| `yappr-social-contract-v9.json` | Was **deployed** on the moutai devnet (retired; topology `v9`), and cannot be read by a beta.7 SDK (it uses the removed beta.6 grammar). Kept while the client still has a `v9` topology. The 4.2.0-beta.4 cut: flat threads with `likeReply`, posts-only repost/bookmark and dual quote fields, all `refersTo`-checked; indexOnly `like`/`likeReply`/`beat` with ranked, count and daily-windowed axes; an optional inline `post.hashtag`; permanent post/reply with consensus `immutable` lists (tombstone deletes); contract moderation with an elected team (the owner moderates until one is seated) and a warning list; optional YAPP costs with contract-owner gas sponsorship, a 100 YAPP once-per-identity starter grant and credit action fees on post/reply; `distinctFrom: $ownerId` on relationship identifiers; private-feed writer gates; and `blockFollow.followedBlockers` as a typed identifier array. Needs protocol v14 on **4.2.0-beta.4**. See [docs/SOCIAL_V9.md](../docs/SOCIAL_V9.md). |

**The 4.2.0-beta.5 re-cut** (moutai was wiped) edits v9, storefront, blog and
pollr in place with `propertyConstraints` co-occurrence rules and keeps every
other file byte-identical; no topology label moves and no contract takes a
document `ttl`. See [docs/CONTRACTS_BETA5.md](../docs/CONTRACTS_BETA5.md) for
the rules, the rejected candidates (key-exchange TTL among them) and the
sha256 of every file.

**The 4.2.0-beta.6 re-cut** (moutai was wiped again) edits only social v9 and
blog in place. v9 gains the `report` type (readers report a post or reply to
the moderators, who dismiss a report by deleting it), one-hour election
windows for devnet, quote and nested-reply owner bindings, and countable
tombstone buckets for quote and reply counts. Blog (topology `v5`) refuses a
comment on a comments-off post and a post by anyone but the blog's owner.
Every other file is byte-identical to beta.5. See
[docs/CONTRACTS_BETA6.md](../docs/CONTRACTS_BETA6.md).

**The 4.2.0-beta.7 re-cut** for the new devnet bonsia (a fresh chain) adds
social v10 above, translates blog, storefront and pollr to the beta.7 grammar
(beta.7 removed `canBeDeletedByModerators`, `propertyAgreement` and `lookup`),
and fixes QA D-25 in storefront (topology `v5`: an order copies its store's
`status` and only an active store takes one). DM, key exchange and the vault
files are unchanged. See [docs/SOCIAL_V10.md](../docs/SOCIAL_V10.md) for the
design, the sizes and the sha256 of every file.

**The 5.0.0-beta.1 re-cut** edits only blog, in place (**blog v6**, client
topology `v6`). 5.0 refuses `immutableAllowSetting` on every parse, so
`blogPost.publishedAt` becomes the conditional entry
`{"property":"publishedAt","when":{"present":"$old.publishedAt"}}`. `blog` and
`blogPost` are now moderated-kind (only moderators remove them, keeping records),
so the three references at them are `moderatedDocument` (40144 at registration as
`deletableDocument`). A comment no longer copies its post's owner:
`postOwnerAndTime` indexes `blogPostId.$ownerId`, read through that reference.
The beta.7 blog loads on neither a 5.0 SDK nor a 5.0 node,
and the beta.7 SDK cannot read v6. Every other file is byte-identical. See
[docs/PLATFORM_V5_BETA1_UPGRADE.md](../docs/PLATFORM_V5_BETA1_UPGRADE.md).

**Blog v7** (5.0.0-beta.2, client topology `v7`) edits only blog, in place,
for mainnet: per-contract elected moderation (interim: the contract owner);
action fees on `blog`/`blogPost` (80M) and `blogComment` (16M) instead of the
YAPP comment cost; `blog.timeline` and `blogPost.timeline`; the comment and
follower count twins merged into `postAndTime` and `followers`;
`followersTrend` and `discussedRecent` 72h windows; `blogPost.ownerAndTime`,
`blogComment.ownerAndTime` and `blogFollow.following` dropped; and an author's
post tombstone (`deleted`, `hasBody`/`tombstoneIsBlank`, `deleted` frozen,
`retractedWhen`). `publishedAt` may run at most 10 minutes past `$updatedAt`,
and image URLs must be https:// or ipfs://. Not registered yet. See
[docs/NON_SOCIAL_CONTRACTS.md](../docs/NON_SOCIAL_CONTRACTS.md#blog).

These are the social contract shapes the client knows (`v2`, `v9`, `v10`, `v11`, `v12`). The differences are wired into the app
through `lib/contract-topology.ts` and selected per deployment with
`NEXT_PUBLIC_CONTRACT_TOPOLOGY` (unset = `v2`; any other value fails the
build). `scripts/validate-contract-offline.mjs` parses a contract through full
wasm validation twice (the wasm-sdk, and `@dashevo/wasm-dpp2`, which alone runs
the meta-schema and the index-shape rules), audits the node-side rules both
parses skip, and measures the create transition against the 20,480-byte cap,
without touching the network.

Superseded social cuts (v3 to v8), their generators (`build-vN-contract.py`)
and their batteries are not kept in the tree; recover them from git history.
A new cut is edited in place as a new `yappr-social-contract-vN.json`, checked
with the offline validator, registered with
`scripts/register-social-v3-draft.mjs`, and proven live with the
`verify-v10.mjs` battery (`--contract-file` selects v10 or v11) and
`prove-merged-counts.mjs` (`verify-v8.mjs` covers the moderation grammar on a
v9 chain).

## Feature contracts

- `yappr-profile-contract.json` — unified profile contract (avatar/banner live here, not in the social contract). **Retired on v10**, where the DashPay `profile` plus social `yapprProfile` replace it; topologies v2 and v9 still read it. **This file is the beta.4 cut (v2): `paymentUris` and `socialLinks` are typed string arrays (`socialLinks` as `"platform:handle"`), where v1 (testnet/prod) stores JSON strings** — see [docs/SOCIAL_V9.md](../docs/SOCIAL_V9.md)
- `yappr-dm-contract.json` — encrypted direct messages (`conversationInvite`, `directMessage`, `readReceipt`). **This file is the beta.2 re-cut, registered on the moutai devnet; testnet (`J7MP9YU1…`) still runs the previous cut.** It adds `rangeCountable` on `directMessage.conversation` (unread is a count query, not a 100-message download), `refersTo: {type: identity}` on `conversationInvite.recipientId`, and an `immutable` list per doctype. See `docs/NON_SOCIAL_CONTRACTS.md`
- `yappr-blog-contract.json` — long-form blog posts, comments, follows. **This file is blog v7, the 5.0.0-beta.2 mainnet-ready cut (topology v7, not registered yet): elected moderation, action fees instead of YAPP comments (blog 80M, post 80M, comment 16M), `blog.timeline`/`blogPost.timeline`, merged count twins, 72h `followersTrend`/`discussedRecent` windows, and an author's post tombstone with `retractedWhen` ([docs/NON_SOCIAL_CONTRACTS.md](../docs/NON_SOCIAL_CONTRACTS.md#blog)).** Before it, blog v6, the 5.0.0-beta.1 re-cut (topology v6): `moderatedDocument` references at `blog`/`blogPost`, a conditional `immutable` entry for `publishedAt`, and no `blogComment.blogPostOwnerId` (`postOwnerAndTime` derives it as `blogPostId.$ownerId`) ([docs/PLATFORM_V5_BETA1_UPGRADE.md](../docs/PLATFORM_V5_BETA1_UPGRADE.md)).** Before it, the beta.7 translation of the beta.6 cut (topology v5, comments-off and owner gate kept). Before that, the beta.4 cut (v4): v3 plus a warning list and `labels` as typed string arrays ([docs/SOCIAL_V9.md](../docs/SOCIAL_V9.md)).** v3 (beta.3) was the moderated re-cut, with `blog`/`blogPost`/`blogComment` moderator-deletable and NO edit history any more (see [docs/SOCIAL_V8.md](../docs/SOCIAL_V8.md)); testnet (`9jfarXPw…`) still runs the v1 cut.** On top of the beta.2 cut, which adds the refersTo chain (post→blog, comment→post with a `blogPostOwnerId` agreement against the post's `$ownerId`, follow→blog), countable/ranked comment and follower trees, a daily-grid `followersByDay`, frozen `blogId`/write-once `publishedAt`, and YAPP-priced comments
- `yappr-storefront-contract.json` — stores, items, orders, reviews, shipping. **This file is the beta.7 cut (topology v5): v4 in the beta.7 grammar plus QA D-25 (`storeOrder.storeStatus`, `storeIsOpen`; [docs/SOCIAL_V10.md](../docs/SOCIAL_V10.md)).** Before it, the beta.4 cut (v4): v3 plus a warning list, `storeItem.tags`/`imageUrls` as typed string arrays and `storeReview.sellerId` distinct from the reviewer ([docs/SOCIAL_V9.md](../docs/SOCIAL_V9.md)).** v3 (beta.3) was the moderated re-cut, with `storeReview`/`itemReview` moderator-deletable (see [docs/SOCIAL_V8.md](../docs/SOCIAL_V8.md)); testnet (`2AUBj86M…`) still runs the v1 cut.** On top of the beta.2 cut, which adds proved rating averages/rankings, item reviews, and a refersTo chain with writer gates (only a store's owner lists under it, only an order's seller posts its status, only its buyer reviews it), frozen `storeId`, countable orders, YAPP-priced reviews
- `pollr-contract.json` — polls. **This file is the beta.7 translation (topology v4) of the beta.2 re-cut, which was registered on the moutai devnet; the testnet contract (`GBCR8Jqt…`) is externally owned and still runs the previous cut.** It adds a permanent poll, indexOnly `vote`/`multiVote` whose single-choice rule is structural rather than a `unique` index and whose `pollOwnerId` is bound to the poll's `$ownerId`, preallocated ballot trees, and the ranked winner query. The standalone Pollr repo needs the same cut before a shared testnet v4 exists
- `yappr-vault-contract.json` — contract-bound encryption keys + encrypted storage
- `yappr-auth-vault-contract.json` — auth vault + access grants
- `encrypted-key-backup-contract.json` — passphrase-encrypted key backups

  These three carry a legacy doctype key `mutable` that meta-schema v3 refuses
  (10101; the wasm-sdk drops it silently). Devnets publish them from the
  testnet snapshot (`source-contracts.json`) instead, which parses on beta.7.
- `key-exchange-v2.json` — QR login key-exchange protocol (deployed everywhere). An indexOnly + TTL re-cut was built and measured 2026-09-18: 42% more credits per response (93.8M vs 66.3M) because the payload must stay in a permanent index, so it was dropped

So for those four, this directory is the source of record for the **next**
registration, not for what testnet runs today; the client picks between them at
runtime with `NEXT_PUBLIC_{STOREFRONT,BLOG,DM,POLLR}_TOPOLOGY`. They are
published with `scripts/register-feature-contract.mjs --file <name>` and
verified live by the `scripts/verify-*.mjs` batteries. Superseded versions are
not kept in the tree; recover them from git history. Devnet ids and the full
per-contract reference are in `docs/NON_SOCIAL_CONTRACTS.md`.

## Legacy (merged into the social contract)

- `yappr-hashtag-contract.json`, `yappr-mention-contract.json`,
  `yappr-block-contract.json` — early standalone contracts whose document
  types were folded into the social contract
- `yappr-minimal.json` — minimal post+profile scratch contract for SDK testing
