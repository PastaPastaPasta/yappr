# The Yappr social contract

Two social contracts exist on chain, and the repo keeps exactly those two:

| Deployment | File | Topology | Notes |
|---|---|---|---|
| staging / production (testnet) | `contracts/yappr-social-contract-v2.json` | `v2` | `9oDC6xdg…`. Polymorphic `parentId`; like/repost/bookmark/quote share one `postId` keyspace. The on-chain copy has since gained the optional `post.embedContractId`/`embedDocType`/`embedId` fields via `scripts/update-social-contract.mjs`. |
| `/devnet` (moutai) | `contracts/yappr-social-contract-v7.json` | `v7` | Needs protocol v14 on 4.2.0-beta.2. |

Superseded cuts are not retained: each one was fully replaced on chain, and a
contract nobody can register is not documentation. Git history has them.

## What `v7` is

- **Flat threads.** A reply names its thread root (`rootPostId`) and, when
  nested, its presentational parent (`replyToReplyId`). Reply likes live in
  their own `likeReply` doctype; repost and bookmark accept post ids only;
  quotes of posts and of replies use separate fields. Every identifier is
  `refersTo`-checked, so a write naming a parent that has not landed is
  rejected (and charged for).
- **Permanent documents.** `post`/`reply` are `canBeDeleted: false`; a "delete"
  is a tombstone replace that blanks the content and sets `deleted: true`.
- **indexOnly likes.** `like`/`likeReply`/`beat` have no stored body:
  uniqueness is structural, an unlike is a delete-by-values carrying the whole
  value tuple (`$createdAt` included), and a like document's `$id` is
  meaningless (create-time and query-synthesized ids differ).
- **One inline, optional hashtag.** `post.hashtag` (`^[a-z0-9_]{1,61}$`);
  untagged means the property is ABSENT. `like.byHashtagPost` is
  `skipIfAbsent`, so untagged likes write no per-tag index entries.
- **Ranked and windowed aggregates**, below.
- **Consensus-owned invariants** — `$ownerId` property agreements and
  `immutable` property lists. See
  [`PLATFORM_BETA2_UPGRADE.md`](./PLATFORM_BETA2_UPGRADE.md).

## Windowed rankings and the `beat` doctype

Each windowed index is a twin of an all-time index — same properties, same
`terminal`, same at-levels, with a bucketed `$createdAt` prepended
(`range == step == 86400`, so `newest` is the current UTC day). Both twins stay
in the contract; the windowed one answers the same question inside a time bound.

| Index | Query it serves | All-time twin |
|---|---|---|
| `like.byDayPost` | most-liked posts today | `like.byPost` → Explore "Top" |
| `beat.byDayHashtagPost` | trending hashtags today (rank at `hashtag`), and top posts for one tag today (pin `hashtag`, rank at `postId`) | `like.byHashtagPost` → trending widget, tag-page "Top" |
| `like.byDayAuthorPost` | top creators today (rank at `postAuthor`), and top posts by one author today (pin `postAuthor`) | `like.byAuthorPost` → Explore "Creators", profile "Top" |
| `beat.byRollingHashtagPost` | the same as `byDayHashtagPost` on an overlapping 24h/6h grid | — (overlap test material) |

Two validation rules force the shape:

1. **`preallocated` is illegal on a bucketed index.** Bucket paths derive from
   the like's own `$createdAt` at write time, so they cannot be created ahead
   of time from the referenced post. The windowed twins drop the flag; their
   all-time twins keep it.
2. **An optional property may only be the FIRST property of a `skipIfAbsent`
   index.** Under a `timeRange` the first position is the timestamp, so a
   windowed hashtag index cannot live on `like` (whose `hashtag` is optional).
   Both escape hatches are refused too: `skipIfAbsent` with `$createdAt` first
   ("system properties are always present"), and making `hashtag` required
   again (then `byHashtagPost` "could never skip").

Hence **`beat`**: an indexOnly, tagged-only doctype with `hashtag` **required**
and `postId` `refersTo` `post` under `propertyAgreement {hashtag: hashtag}`, so
consensus enforces `beat.hashtag == post.hashtag`. The client writes one `beat`
beside every like of a TAGGED post — as a **second transition** after the like,
because the network caps a document batch at one transition — and deletes it
beside the unlike. Untagged likes write no beat, which is the `skipIfAbsent`
economy by other means.

`like.byDayPost`, `like.byDayAuthorPost`, `beat.byDayHashtagPost` and
`beat.byRollingHashtagPost` carry `ttl: 604800`. Expired buckets outside that
seven-day horizon are not valid historical queries; cleanup advances with later
writes. The permanent `beat.byPost`/`beat.byPostTime` indexes remain — the
latter is what locates a beat for deletion when a like is removed.

The `timeRange` module doc prescribes a grouped count in the newest bucket with
the client ordering the groups. Yappr cannot ship that: the response carries one
entry per distinct group in the window — every hashtag used today, every author
liked today — which is fine in a test and degrades badly in production.

**Known gap:** "most-liked recent posts by people I follow" needs a pin drawn
from a SET (`postAuthor In [...]`), which ranked routing does not accept. The
per-author rankings are already materialized; the server would k-way-merge F
sorted lists. The storage and proof substrate exists (`prove_query_many`); the
routing does not.

## Measured write costs

Least-squares fit of per-op credit cost over the 2026-09-01 devnet re-seed (426
ops across 10 identities, per-identity balance deltas, residual 0.1%), on the
pre-windowed contract:

| Op | Credits | DASH |
|---|---|---|
| post / quote | ~188 M | 0.0019 |
| reply | ~175 M | 0.0018 |
| like | ~59 M | 0.0006 |
| likeReply | ~54 M | 0.0005 |
| repost | ~66 M | 0.0007 |
| follow | ~46 M | 0.0005 |

The windowed twins add roughly one bucket level per ranked twin (~12–15 M
each), so an untagged like lands around 85–95 M and a tagged like — which also
pays for its `beat` row — around 125–140 M. These are estimates, not
measurements of the deployed contract. At the YAPP layer nothing changes
(1 YAPP per like); the credits come out of the identity.

## Registration-day runbook (devnet only)

Nothing here touches testnet or production contracts.

### 0. Preconditions

- `npm ci` run on this branch.
- Repo-root `.env.local` holds `E2E_SEED_PHRASE` (gitignored); every script
  below derives its keys from it.
- `@dashevo/evo-sdk` and `@dashevo/wasm-sdk` pinned to the release the target
  network runs. The ranked picker/path modules are shared with the proof
  verifier, so an older SDK fails *inside proof verification* on the new query
  shapes — a confusing error, not a clean "unsupported".
- The **pre-wipe contract id list** at hand for step 2 (git history of
  `.env.devnet`, including every superseded id in its comment block).
- `.devnet-locks.local` (gitignored asset-lock key ledger) preserved. **Never
  delete it** — it is what lets identities come back with their original ids.
- `node scripts/validate-contract-offline.mjs contracts/yappr-social-contract-v7.json`
  prints `OK` and all invariants pass.

### 1. Confirm the network

Core: `https://insight.moutai.networks.dash.org` responds and blocks advance.
After a re-genesis the chain can take ~1h to ingest its first chainlock;
identity funding genuinely sees `coreChainLockedHeight=0` until then. Warm the
quorum service before any SDK connect (cold hits take ~10s and the wasm
prefetch dies on them):

```bash
curl -s https://quorums.moutai.networks.dash.org/ > /dev/null
NETWORK=devnet node scripts/provision-test-identity.mjs --check-balances
```

Every later script prints the ratcheted protocol version at connect
(`protocol version ratcheted via epoch query: PV<n>`); expect **at least 14**.

### 2. The fresh-chain nonce hazard (read before registering ANYTHING)

**Contract id = hash(owner, identityNonce).** A wiped platform chain resets
identity nonces to zero while the core chain — and therefore the identities,
when restored from their original asset-lock outpoints — keeps the same ids. So
re-registering **reproduces the pre-wipe contract ids byte-for-byte, attached to
whatever is registered first, in whatever order.** This bit us on 2026-08-28:
the old social id landed on the authVault clone, the old pollr id on
keyExchange, and every cached reference silently pointed at a different schema.

1. After each publish, check the returned id against the pre-wipe list. An
   exact match means that id is poisoned; do not use it.
2. If ids collide, **burn nonces** — register throwaway contracts until
   publishes return never-before-seen ids, then do the real registrations.
3. Record every id, used AND burned; the burned ones belong in the
   `.env.devnet` comment block so the next wipe's list is complete.
4. Never trust a pre-wipe id again, even if it "exists" on chain.

### 3. Bot identities

Three identities derived from `E2E_SEED_PHRASE` (`scripts/derive-identities.mjs`):
**maker = seed index 9**, bots = indices **0** and **1**. Identity *ids* are not
derivable — they come from the asset-lock outpoint.

If the core chain persisted, rebuild chain asset-lock proofs from the keys in
`.devnet-locks.local` and re-register; the identities come back with their
original ids and no faucet is involved. Otherwise, per identity:

```bash
# 1. one-shot asset-lock key, appended to .devnet-locks.local BEFORE anything
#    is broadcast, so funds can never be stranded
node scripts/provision-test-identity.mjs --gen-asset-lock-key /tmp/lock-key-0

# 2. fund the printed P2PKH address from the devnet faucet
#    (https://faucet.moutai.networks.dash.org/ — no CAP; a direct POST works)

# 3. wrap the faucet UTXO in a DIP-2 type-8 asset-lock special tx. GOTCHA:
#    moutai nodes run a very low -maxtxfee (~1k duffs) — a normal 10k fee is
#    rejected with -25 "Fee exceeds maximum"; use ~500 duffs.
node scripts/build-asset-lock.mjs   # see its header for arguments

# 4. wait for the lock to be buried under a CHAINLOCK, then register.
#    InstantSend proofs are REFUSED on devnet (dashpay/platform#4399 — an
#    IS-funded lock silently burns the funds).
NETWORK=devnet node scripts/provision-test-identity.mjs 0 \
  --asset-lock-key-file /tmp/lock-key-0 --funding-outpoint <txid>:0
```

Repeat for 1 and 9, then `--check-balances`. The resulting ids become
`E2E_IDENTITY_IDS` (0,1) and `DEVNET_MAKER_IDENTITY_ID` (9).

### 4. Register the contracts

All registrations are signed by the devnet maker via `--bot 9` /
`--owner-index 9` with the id passed explicitly — NOT `--maker`, whose key file
is the *testnet* maker and owns nothing here.

```bash
# 4a. the social contract. register-social-v3-draft.mjs is v3-named but
#     file-agnostic: it publishes the JSON verbatim via DataContract.fromJSON,
#     tokens block included. It defaults to the v7 file.
NETWORK=devnet node scripts/register-social-v3-draft.mjs --bot 9 \
  --owner <makerId> \
  --contract-file contracts/yappr-social-contract-v7.json \
  --fund <bot0Id>,<bot1Id>

# 4b. the profile contract, cloned from the testnet staging copy's on-chain
#     schemas. --only profile: this script's social source is a chain clone of
#     the OLD topology, never the file above.
NETWORK=devnet node scripts/register-test-contracts.mjs \
  --source-network testnet \
  --from-profile FZSnZdKsLAuWxE7iZJq12eEz6xfGTgKPxK7uZJapTQxe \
  --only profile --owner <makerId> --owner-index 9

# 4c. the remaining feature contracts; prints the .env.devnet lines to paste
NETWORK=devnet node scripts/register-feature-contracts.mjs \
  --owner <makerId> --owner-index 9
```

`--fund` is mandatory in practice: a fresh contract mints the whole YAPP
`baseSupply` to the maker, and every bot's first token-priced write is refused
until it holds YAPP (post 10, reply 3, like/likeReply/repost 1). Nonce-check
every returned id. Contracts whose testnet originals carry a legacy v0 `config`
block are rejected with "config version 0 is not supported" — 4c migrates them,
but check if a new feature contract joins the list.

### 5. YAPP price and top-ups

```bash
NETWORK=devnet node scripts/set-yapp-price.mjs \
  --contract <newSocialId> --owner-index 9 --owner <makerId>
```

Sets the tiered direct-purchase price (1,000,000 credits/token, minimum 100 per
purchase — the anti-spam bond). Without it, in-app YAPP purchase fails. Later
top-ups without republishing:

```bash
NETWORK=devnet node scripts/register-social-v3-draft.mjs --bot 9 \
  --owner <makerId> --fund-only <newSocialId> --fund <bot0Id>,<bot1Id>
```

### 6. Re-cut `.env.devnet`

One commit, all together — **the ids and the topology flag must move as a
unit.** `.github/workflows/deploy.yml` rebuilds `/devnet` from `.env.devnet` on
every push to `staging`, and a client pointed at the wrong cut fails totally
rather than degrading.

- `NEXT_PUBLIC_YAPPR_CONTRACT_ID`, `NEXT_PUBLIC_CONTRACT_TOPOLOGY=v7` — a
  value naming a retired cut makes `next build` and the seeder throw rather
  than fall back, so these two genuinely cannot drift apart silently
- `NEXT_PUBLIC_YAPPR_PROFILE_CONTRACT_ID` and the feature ids from 4c
- `DEVNET_MAKER_IDENTITY_ID` / `NEXT_PUBLIC_YAPP_TOKEN_AUTHORITY_ID` /
  `E2E_IDENTITY_IDS`, only if the identity ids changed
- move the superseded ids into the comment block (they feed the next wipe's
  collision list)

### 7. Run the battery

```bash
node scripts/verify-v7.mjs --self-test                          # no network
NETWORK=devnet node scripts/verify-v7.mjs --contract <newSocialId>
```

Both bots need YAPP (step 5) or the run aborts with a funding message. Expect
all checks green before anything deploys, and record the output — the captured
rejection texts are the live error surface. Case list:
[`PLATFORM_BETA2_UPGRADE.md`](./PLATFORM_BETA2_UPGRADE.md).

### 8. Deploy and run the deployed e2e

```bash
npm run lint && npm run build && npm run build:devnet
# deploy the static export to yap.pr/devnet, then:
E2E_BASE_PATH=/devnet E2E_ENV_FILE=.env.devnet NETWORK=devnet npx playwright test
```

The `/testing` deployment (`.env.testing`, testnet) is unaffected: testnet's
protocol is too old for this grammar and keeps the v2 contract.
