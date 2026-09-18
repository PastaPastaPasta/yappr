# Yappr Data Contracts

Dash Platform data contracts used by the Yappr dapp. The JSON here is the
source of record for what was registered; deployed contract ids live in
`lib/constants.ts` (testnet defaults) and the `.env.*` files (per-deployment
overrides).

## Social contract

| File | Status |
|------|--------|
| `yappr-social-contract-v2.json` | **Deployed** on testnet (`9oDC6xdg…`, staging/prod). 16 document types + the YAPP token. Topology `v2`: replies chain through a polymorphic `parentId`; like/repost/bookmark/quote share one `postId` keyspace. The on-chain copy has since gained the optional `post.embedContractId`/`embedDocType`/`embedId` fields via `scripts/update-social-contract.mjs`, and its YAPP token carries `keepsHistory` (transfer/freeze/mint/burn/pricing/purchase, all true — verified on chain 2026-09-18) which this file predates; `lib/contracts/bundled/testnet.json` is the faithful snapshot. |
| `yappr-social-contract-v7.json` | **Deployed** on the moutai devnet (`/devnet`). Topology `v7`: flat threads, `refersTo` everywhere, indexOnly likes, one optional inline `post.hashtag`, ranked + daily-windowed aggregates with the `beat` doctype, `$ownerId` property agreements and consensus-`immutable` property lists. Needs protocol v14 on **4.2.0-beta.2**. See [docs/SOCIAL_CONTRACT.md](../docs/SOCIAL_CONTRACT.md) and [docs/PLATFORM_BETA2_UPGRADE.md](../docs/PLATFORM_BETA2_UPGRADE.md). |

The topology differences are wired into the app through
`lib/contract-topology.ts` and selected per deployment with
`NEXT_PUBLIC_CONTRACT_TOPOLOGY`. `scripts/validate-contract-offline.mjs` parses
a contract JSON through full wasm validation — and, for the social contract,
re-checks its structural invariants — without touching the network.

As with the feature contracts, superseded social cuts (v3 through v6, and the
earlier drafts) are **not** kept in the tree: each was fully replaced on chain,
and neither they nor the generators and batteries that produced them describe
anything registrable. Recover them from git history.

## Feature contracts

- `yappr-profile-contract.json` — unified profile contract (avatar/banner live here, not in the social contract)
- `yappr-dm-contract.json` — encrypted direct messages (`conversationInvite`, `directMessage`, `readReceipt`). **This file is the beta.2 re-cut, registered on the moutai devnet; testnet (`J7MP9YU1…`) still runs the previous cut.** It adds `rangeCountable` on `directMessage.conversation` (unread is a count query, not a 100-message download), `refersTo: {type: identity}` on `conversationInvite.recipientId`, and an `immutable` list per doctype. See `docs/NON_SOCIAL_CONTRACTS.md`
- `yappr-blog-contract.json` — long-form blog posts, comments, follows. **This file is the beta.2 re-cut, registered on the moutai devnet; testnet (`9jfarXPw…`) still runs the previous cut.** It adds the refersTo chain (post→blog, comment→post with a `blogPostOwnerId` agreement against the post's `$ownerId`, follow→blog), countable/ranked comment and follower trees, a daily-grid `followersByDay`, frozen `blogId`/write-once `publishedAt`, and YAPP-priced comments
- `yappr-storefront-contract.json` — stores, items, orders, reviews, shipping. **This file is the beta.2 re-cut, registered on the moutai devnet; testnet (`2AUBj86M…`) still runs the previous cut.** It adds proved rating averages/rankings, item reviews, and a refersTo chain with writer gates (only a store's owner lists under it, only an order's seller posts its status, only its buyer reviews it), frozen `storeId`, countable orders, YAPP-priced reviews
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
