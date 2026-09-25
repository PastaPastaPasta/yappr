# Yappr Data Contracts

Dash Platform data contracts used by the Yappr dapp. The JSON here is the
source of record for what was registered; deployed contract ids live in
`lib/constants.ts` (testnet defaults) and the `.env.*` files (per-deployment
overrides).

## Social contract

| File | Status |
|------|--------|
| `yappr-social-contract-v2.json` | **Deployed** on testnet (`9oDC6xdg…`, staging/prod). 16 document types + the YAPP token. Topology `v2`: replies chain through a polymorphic `parentId`; like/repost/bookmark/quote share one `postId` keyspace. The on-chain copy has since gained the optional `post.embedContractId`/`embedDocType`/`embedId` fields via `scripts/update-social-contract.mjs`, and its YAPP token carries `keepsHistory` (transfer/freeze/mint/burn/pricing/purchase, all true — verified on chain 2026-09-18) which this file predates; `lib/contracts/bundled/testnet.json` is the faithful snapshot. |
| `yappr-social-contract-v9.json` | **Deployed** on the moutai devnet (`.env.devnet`, topology `v9`). The 4.2.0-beta.4 cut: flat threads with `likeReply`, posts-only repost/bookmark and dual quote fields, all `refersTo`-checked; indexOnly `like`/`likeReply`/`beat` with ranked, count and daily-windowed axes; an optional inline `post.hashtag`; permanent post/reply with consensus `immutable` lists (tombstone deletes); contract moderation with an elected team (the owner moderates until one is seated) and a warning list; optional YAPP costs with contract-owner gas sponsorship, a 100 YAPP once-per-identity starter grant and credit action fees on post/reply; `distinctFrom: $ownerId` on relationship identifiers; private-feed writer gates; and `blockFollow.followedBlockers` as a typed identifier array. Needs protocol v14 on **4.2.0-beta.4**. See [docs/SOCIAL_V9.md](../docs/SOCIAL_V9.md). |

These are the only two social contracts that exist on any chain, and the only
two topologies the client knows. The differences are wired into the app
through `lib/contract-topology.ts` and selected per deployment with
`NEXT_PUBLIC_CONTRACT_TOPOLOGY` (unset = `v2`; any other value fails the
build). `scripts/validate-contract-offline.mjs` parses a contract through full
wasm validation, audits the node-side rules the parse skips, and measures the
create transition against the 20,480-byte cap, without touching the network.

Superseded social cuts (v3 to v8), their generators (`build-vN-contract.py`)
and their batteries are not kept in the tree; recover them from git history.
A new cut is edited in place as a new `yappr-social-contract-vN.json`, checked
with the offline validator, registered with
`scripts/register-social-v3-draft.mjs`, and proven live with the
`verify-v8.mjs` / `verify-v9.mjs` batteries.

## Feature contracts

- `yappr-profile-contract.json` — unified profile contract (avatar/banner live here, not in the social contract). **This file is the beta.4 cut (v2): `paymentUris` and `socialLinks` are typed string arrays (`socialLinks` as `"platform:handle"`), where v1 (testnet/prod) stores JSON strings** — see [docs/SOCIAL_V9.md](../docs/SOCIAL_V9.md)
- `yappr-dm-contract.json` — encrypted direct messages (`conversationInvite`, `directMessage`, `readReceipt`). **This file is the beta.2 re-cut, registered on the moutai devnet; testnet (`J7MP9YU1…`) still runs the previous cut.** It adds `rangeCountable` on `directMessage.conversation` (unread is a count query, not a 100-message download), `refersTo: {type: identity}` on `conversationInvite.recipientId`, and an `immutable` list per doctype. See `docs/NON_SOCIAL_CONTRACTS.md`
- `yappr-blog-contract.json` — long-form blog posts, comments, follows. **This file is the beta.4 cut (v4): v3 plus a warning list and `labels` as typed string arrays ([docs/SOCIAL_V9.md](../docs/SOCIAL_V9.md)).** v3 (beta.3) was the moderated re-cut, with `blog`/`blogPost`/`blogComment` moderator-deletable and NO edit history any more (see [docs/SOCIAL_V8.md](../docs/SOCIAL_V8.md)); testnet (`9jfarXPw…`) still runs the v1 cut.** On top of the beta.2 cut, which adds the refersTo chain (post→blog, comment→post with a `blogPostOwnerId` agreement against the post's `$ownerId`, follow→blog), countable/ranked comment and follower trees, a daily-grid `followersByDay`, frozen `blogId`/write-once `publishedAt`, and YAPP-priced comments
- `yappr-storefront-contract.json` — stores, items, orders, reviews, shipping. **This file is the beta.4 cut (v4): v3 plus a warning list, `storeItem.tags`/`imageUrls` as typed string arrays and `storeReview.sellerId` distinct from the reviewer ([docs/SOCIAL_V9.md](../docs/SOCIAL_V9.md)).** v3 (beta.3) was the moderated re-cut, with `storeReview`/`itemReview` moderator-deletable (see [docs/SOCIAL_V8.md](../docs/SOCIAL_V8.md)); testnet (`2AUBj86M…`) still runs the v1 cut.** On top of the beta.2 cut, which adds proved rating averages/rankings, item reviews, and a refersTo chain with writer gates (only a store's owner lists under it, only an order's seller posts its status, only its buyer reviews it), frozen `storeId`, countable orders, YAPP-priced reviews
- `pollr-contract.json` — polls. **This file is the beta.2 re-cut, registered on the moutai devnet; the testnet contract (`GBCR8Jqt…`) is externally owned and still runs the previous cut.** It adds a permanent poll, indexOnly `vote`/`multiVote` whose single-choice rule is structural rather than a `unique` index and whose `pollOwnerId` is bound to the poll's `$ownerId`, preallocated ballot trees, and the ranked winner query. The standalone Pollr repo needs the same cut before a shared testnet v4 exists
- `yappr-vault-contract.json` — contract-bound encryption keys + encrypted storage
- `yappr-auth-vault-contract.json` — auth vault + access grants
- `encrypted-key-backup-contract.json` — passphrase-encrypted key backups
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
