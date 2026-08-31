# v5 contract deploy runbook (wipe day)

Operator playbook for cutting the moutai devnet over to the **v5 social
contract** (`contracts/yappr-social-contract-v5.json`, built by
`scripts/build-v5-contract.py`) after the platform wipe + upgrade to
**v4.2.0-dev.7**. v5 requires a #4543-inclusive build — registration on dev.6
or earlier is REJECTED (the plain `byAuthorTimePost` sibling next to the
at-chained `byAuthorPost` needs the count-exempt sibling admission).

Design provenance: the exact like-index shape was validated end-to-end (scratch
e2e) against the merged platform code that shipped in dev.7, including the
mandatory hashtag `maxLength: 61` (63 is rejected by the ranked-key-ceiling
validation). See `PLAN_DEV6_V5.md` (D-V5-1 RESOLVED) for the design record.

Everything here happens on the **devnet only**. Nothing touches testnet or
production contracts.

## 0. Preconditions

- [ ] A checkout of this branch (or `staging` after it merges) with `npm ci`
      run.
- [ ] Repo-root `.env.local` contains `E2E_SEED_PHRASE` (gitignored — copy the
      line from another worktree if this is a fresh one; every script below
      derives its keys from it).
- [ ] `@dashevo/evo-sdk` pinned to **4.2.0-dev.7** (or later) in
      `package.json`. The ranked picker/path modules are shared with the proof
      verifier, so a dev.5/dev.6 SDK fails *inside proof verification* on the
      new query shapes — a confusing error, not a clean "unsupported".
- [ ] The **pre-wipe id list** at hand for the collision check in step 2: the
      old `.env.devnet` contract ids (git history has them) — as of the last
      cut: social `Aux325if…`, profile `6L6qmKAx…`, DM `DNNibJtg…`, storefront
      `GVSCnyrb…`, keyBackup `ABzVw5Fj…`, keyExchange `BoRY8pEw…`, vault
      `DMktR8HR…`, authVault `A6x2T19W…`, blog `4ZxGLZw4…`, pollr `HhKqccdm…`,
      plus every superseded id named in `.env.devnet` comments.
- [ ] `.devnet-locks.local` (gitignored asset-lock key ledger) preserved from
      before the wipe. **Never delete it** — after the 2026-08-28 wipe it is
      what allowed the identities to be restored with their original ids.
- [ ] The contract JSON is fresh and self-consistent:

```bash
python3 scripts/build-v5-contract.py --self-test   # must print all-PASS
```

## 1. Confirm the network is up on dev.7

1. Core chain: `https://insight.moutai.networks.dash.org` responds and blocks
   are advancing. After a re-genesis the chain can take a while to ingest its
   FIRST chainlock (~1h last time) — identity funding waits genuinely see
   `coreChainLockedHeight=0` until then.
2. Warm the quorum service before any SDK connect (cold hits take ~10s and the
   wasm prefetch dies on them):

```bash
curl -s https://quorums.moutai.networks.dash.org/ > /dev/null
```

3. Platform: confirm the software version and protocol version. Any proved
   read works; the battery prints the ratcheted protocol version at connect
   (`protocol version ratcheted via epoch query: PV<n>`):

```bash
NETWORK=devnet node scripts/provision-test-identity.mjs --check-balances
```

   Expect the seeds to answer and, once the contracts exist, every later
   script to report a protocol version of **at least 14** (the aggregate-index
   grammar PV). If DAPI reports a pre-dev.7 software version, STOP — v5
   registration will be rejected (see the #4543 note above).

## 2. The fresh-chain nonce hazard (read before registering ANYTHING)

**Contract id = hash(owner, identityNonce).** A wiped platform chain resets
identity nonces to zero while the core chain (and therefore the identities,
when restored from their original asset-lock outpoints) keeps the same ids. So
re-registering contracts replays the maker's nonce sequence and **reproduces
the pre-wipe contract ids byte-for-byte — attached to whatever is registered
first, in whatever order**. This bit us on 2026-08-28: the first post-wipe
registration pass landed the old social id on the authVault clone, the old
pollr id on keyExchange, etc. Any client, cache, or document that referenced a
pre-wipe id silently pointed at a different schema.

Discipline for every registration below:

1. After each `contracts.publish`, **check the returned id against the
   pre-wipe id list** (step 0). Exact match ⇒ that id is poisoned; do not use
   it.
2. If ids collide, **burn nonces**: register throwaway contracts (or simply
   accept and abandon the colliding registration) until publishes return
   never-before-seen ids, then do the real registrations. The 2026-08-28
   recovery burned maker nonces 11-12 this way (PR #320) — the burned
   registrations reproduced the old blog/pollr ids exactly, confirming
   id = hash(owner, nonce).
3. Record every id (used AND burned) as you go; the burned ones belong in the
   `.env.devnet` comment block so the next wipe's list is complete.
4. **Never trust a pre-wipe id again**, even if it "exists" on chain — it is
   bound to a different (or throwaway) schema.

## 3. Bot identity provisioning

Three identities, all derived from `E2E_SEED_PHRASE`
(`scripts/derive-identities.mjs`): **maker = seed index 9**, bots = indices
**0** and **1**. Identity *ids* are NOT derivable (they come from the
asset-lock outpoint) — they are whatever registration produces.

**If the core chain persisted through the wipe** (as in 2026-08-28): the
original type-8 asset-lock outpoints still exist, so rebuild chain asset-lock
proofs from the keys in `.devnet-locks.local` and re-register the identities —
they come back with their **original ids** and no faucet is involved. The
outpoints used last time are recorded in the memory note / `.devnet-locks.local`
(maker `2a5d1e45…d528:0`, bot0 `ca1ad260…9e41:0`, bot1 `a559fa3c…20c3:0`).

**If the core chain was wiped too** (fresh ids for everyone), per identity:

```bash
# 1. one-shot asset-lock key; the key is appended to .devnet-locks.local
#    BEFORE anything is broadcast, so funds can never be stranded
node scripts/provision-test-identity.mjs --gen-asset-lock-key /tmp/lock-key-0

# 2. fund the printed P2PKH address from the devnet faucet
#    (https://faucet.moutai.networks.dash.org/ — no CAP/captcha on the devnet
#    faucet; a direct POST from the page works). The faucet pays a PLAIN
#    P2PKH, which Platform refuses as a funding outpoint, so:

# 3. wrap the faucet UTXO in a DIP-2 type-8 asset-lock special tx
#    (OP_RETURN burn + credit payload). GOTCHA: moutai nodes run a very low
#    -maxtxfee (~1k duffs) — a normal 10k fee is rejected with -25
#    "Fee exceeds maximum"; use ~500 duffs.
node scripts/build-asset-lock.mjs   # see its header for arguments

# 4. wait for the asset-lock tx to be buried under a chainlock, then register.
#    InstantSend proofs are REFUSED on devnet (dashpay/platform#4399 — an
#    IS-funded lock silently burns the funds); only ChainLock proofs work,
#    and the script waits for the lock itself:
NETWORK=devnet node scripts/provision-test-identity.mjs 0 \
  --asset-lock-key-file /tmp/lock-key-0 --funding-outpoint <txid>:0
```

Repeat for indices 1 and 9. Then verify:

```bash
NETWORK=devnet node scripts/provision-test-identity.mjs --check-balances
```

Record the resulting ids — they become `E2E_IDENTITY_IDS` (indices 0,1) and
`DEVNET_MAKER_IDENTITY_ID` (index 9) in the re-cut `.env.devnet` (step 6).

## 4. Register the contracts

All registrations are signed by the **devnet maker = seed index 9 via
`--bot 9` / `--owner-index 9` with the id passed explicitly** — NOT `--maker`:
the `--maker` key file in `~/Downloads` is the *testnet* maker and does not own
anything on the devnet.

### 4a. The v5 social contract

`scripts/register-social-v3-draft.mjs` is v3-named but takes any
`--contract-file` (it publishes the JSON verbatim via `DataContract.fromJSON`,
tokens block included):

```bash
NETWORK=devnet node scripts/register-social-v3-draft.mjs --bot 9 \
  --owner <makerId> \
  --contract-file contracts/yappr-social-contract-v5.json \
  --fund <bot0Id>,<bot1Id>
```

- `--fund` is mandatory-in-practice: a fresh contract mints the whole YAPP
  `baseSupply` to the maker, and every bot's first token-priced write is
  refused until it holds YAPP (posts cost 10, replies 3, likes 1).
- **Nonce check (step 2) on the returned id before doing anything else.**
- If registration itself is REJECTED with a ranked-key-ceiling or at-level
  exclusivity error, the node is not running a #4543-inclusive build — stop
  and re-check step 1; the contract file is not the problem (its shape passed
  the dev.7 scratch e2e).
- Known cosmetic gap: the script's pre-publish schema audit only annotates
  `(u)`/`(c)` flags, so the ranked/skip flags don't show in the audit table.
  Trust `build-v5-contract.py --self-test` for the flag shape instead.

### 4b. The profile contract

Cloned from the testnet staging copy's on-chain schemas
(`--source-network testnet`):

```bash
NETWORK=devnet node scripts/register-test-contracts.mjs \
  --source-network testnet \
  --from-profile FZSnZdKsLAuWxE7iZJq12eEz6xfGTgKPxK7uZJapTQxe \
  --only profile --owner <makerId> --owner-index 9
```

(Do NOT let this script register the social contract — its social source is a
chain clone of the old topology, not the v5 file. `--only profile`.)

### 4c. The feature contracts

The remaining 8 (DM, storefront, keyBackup, keyExchange, vault, authVault,
blog, pollr — pollr is externally owned on testnet but the devnet clone is
maker-owned like everything else):

```bash
NETWORK=devnet node scripts/register-feature-contracts.mjs \
  --owner <makerId> --owner-index 9
```

It prints the `.env.devnet` lines to paste. Nonce-check every id. (Gotcha from
last time: contracts whose testnet originals carry a legacy v0 `config` block
are rejected with "config version 0 is not supported" — the script already
migrates them, but if a new feature contract joins the list, check.)

## 5. YAPP price + funding

```bash
NETWORK=devnet node scripts/set-yapp-price.mjs \
  --contract <newV5SocialId> --owner-index 9 --owner <makerId>
```

Sets the tiered direct-purchase price (1,000,000 credits/token, minimum 100
per purchase — the anti-spam bond). Without it, in-app YAPP purchase fails.

Top-ups later (battery re-runs, e2e churn) without republishing:

```bash
NETWORK=devnet node scripts/register-social-v3-draft.mjs --bot 9 \
  --owner <makerId> --fund-only <newV5SocialId> --fund <bot0Id>,<bot1Id>
```

If the 500-user seeding run follows, check the maker's remaining YAPP supply
first (~680k needed per the pilot math) — the seeding pipeline itself is NOT
in this repo yet (post-v5 work).

## 6. Re-cut `.env.devnet`

One commit, all together (the ids and the topology flag must move as a unit):

- `NEXT_PUBLIC_YAPPR_CONTRACT_ID=<newV5SocialId>`
- `NEXT_PUBLIC_CONTRACT_TOPOLOGY=v5`
- `NEXT_PUBLIC_YAPPR_PROFILE_CONTRACT_ID=<newProfileId>`
- the 8 feature contract ids from 4c
- `DEVNET_MAKER_IDENTITY_ID` / `NEXT_PUBLIC_YAPP_TOKEN_AUTHORITY_ID` /
  `E2E_IDENTITY_IDS` (only if the identity ids changed — they don't when the
  core chain persisted)
- move the superseded ids into the comment block (they feed the next wipe's
  collision list)

**Sequencing caveat:** the client v5 arm (compose omitting `hashtag`,
absence-aware unlike tuples, the proved trending/leaderboard/follow-count
surfaces) is a SEPARATE PR. `NEXT_PUBLIC_CONTRACT_TOPOLOGY=v5` must not reach
the deployed `/devnet` build before that client arm has merged — a v4 client
pointed at the v5 contract writes `hashtag: ''`, which v5 REJECTS (pattern
`^[a-z0-9_]{1,61}$`, minLength 1). Registering + verifying (steps 4-7) is safe
at any time; the env flip deploys with the client arm.

## 7. Run the verification battery

```bash
node scripts/verify-v5.mjs --dry-run          # shapes + args, no network
NETWORK=devnet node scripts/verify-v5.mjs --contract <newV5SocialId>
```

Full battery: the carried-over v4 topology/indexOnly cases (a1-a6, b1-b12,
rebased onto absent-hashtag semantics) plus the new v5 cases — c1 untagged
lifecycle across the skipIfAbsent index, c2 prefix rankings
(trending hashtags, preallocated-at-zero, drained groups, creator leaderboard,
per-author Top on the same index), c3 prefix-pinned counts, c4
byAuthorTimePost windows (tagged+untagged in one stream), c5 follow rankings.
Re-run subsets with `--only c1,c2,…`. Both bots need YAPP (step 5) or the
battery aborts in case 0 with a funding message.

Expect **all checks green** before anything deploys. Save the output (the
captured rejection texts + working query shapes sections document the live
error/query surface for the client PR) — `docs/V4_BATTERY_RESULTS.md` is the
precedent.

## 8. Deploy + deployed e2e

After the client v5 arm merges and `.env.devnet` is flipped (step 6):

```bash
npm run lint && npm run build
npm run build:devnet         # sources .env.devnet, BASE_PATH=/devnet
# deploy the static export to yap.pr/devnet (the usual pipeline)
# then the deployed e2e pass against yap.pr/devnet
```

The `/testing` deployment (`.env.testing`, testnet) is unaffected — testnet
cannot host v5 (protocol version too old) and keeps the current contracts.

## Script inventory (cross-checked against this branch)

| Step | Script | Status |
|---|---|---|
| 0, 4a | `scripts/build-v5-contract.py` | new in this PR (`--self-test`) |
| 1, 3 | `scripts/provision-test-identity.mjs` | exists; devnet flow via `--gen-asset-lock-key` / `--funding-outpoint` |
| 3 | `scripts/build-asset-lock.mjs` | exists; remember the ~500-duff fee cap |
| 4a, 5 | `scripts/register-social-v3-draft.mjs` | exists; v3-named but file-agnostic — no changes needed; audit table doesn't show ranked/skip flags (cosmetic) |
| 4b | `scripts/register-test-contracts.mjs` | exists; use `--only profile` on wipe day |
| 4c | `scripts/register-feature-contracts.mjs` | exists; prints the env lines |
| 5 | `scripts/set-yapp-price.mjs` | exists; `--owner-index 9 --owner <makerId>` |
| 7 | `scripts/verify-v5.mjs` | new in this PR |
| — | seeding pipeline (500-user run) | does NOT exist yet; separate work after v5 is live |
| — | `scripts/verify-v4.mjs` | kept as-is for the outgoing contract; not part of wipe day |
