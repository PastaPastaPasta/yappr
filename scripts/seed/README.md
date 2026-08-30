# Devnet content seeding — ops runbook

Seeds the moutai devnet (v4 social contract, `NEXT_PUBLIC_YAPPR_CONTRACT_ID` in
`.env.devnet`) with synthetic users and content. Built for a 10-user /
~1100-op pilot first, but resumable and parallel from the start so the same
scripts scale to 500 users / 50k posts.

```
scripts/seed/
  CORPUS_FORMAT.md               personas + corpus file formats
  seed-lib.mjs                   shared pure logic (parsing, ledger, documents, SDK handle)
  asset-lock-lib.mjs             split tx + DIP-2 type-8 asset-lock construction, Insight API
  provision-seed-identities.mjs  treasury → funded/registered/profiled/named/YAPP'd identities
  run-seeder.mjs                 corpus executor (checkpointed, per-author sequential, parallel across authors)
```

Everything state-bearing lives in gitignored, chmod-600 files at the repo root.

**Never commit:** `.seed-treasury.local.key`, `.seed-identities.local*`,
`.seed-progress.local*`, `.seed-report.local*` (all covered by `.gitignore`).
The treasury key and the identity ledger contain PRIVATE KEYS.

## 0. One-time prerequisites

- `NETWORK=devnet` on every invocation (scripts read the rest of the wiring —
  DAPI pool, Insight URL, contract ids — from `.env.devnet`).
- YAPP funding (the v4 contract charges YAPP per post/reply/like create):
  - default `--yapp-source maker` transfers from the devnet maker (seed
    index 9) and therefore needs `E2E_SEED_PHRASE` in the environment or
    `.env.local`, plus `DEVNET_MAKER_IDENTITY_ID` (already in `.env.devnet`);
  - `--yapp-source purchase` has each identity buy YAPP with its own credits,
    but requires a direct-purchase price on **this** contract first — as of
    2026-08-30 the v4 draft (`Aux325if…`) has **no price set**; set one with
    `NETWORK=devnet node scripts/set-yapp-price.mjs --contract <id> --owner <makerId> --owner-index 9`.

## 1. Fund the treasury

```bash
NETWORK=devnet node scripts/seed/provision-seed-identities.mjs --treasury-address
```

Generates `.seed-treasury.local.key` (64-hex, chmod 600) on first run and
prints the P2PKH address (devnets use testnet prefixes). Send devnet DASH to it
from the moutai faucet: <https://faucet.moutai.networks.dash.org/> (faucet
etiquette: one request at a time, honour rate limits).

### Funding math (pilot: 10 identities, ~1100 ops)

| item | amount |
|---|---|
| credits per identity (`--credits-per` default) | 8,000,000 duffs → ~8.0 × 10⁹ credits after the 500-duff lock fee |
| 10 identities | 80,000,000 duffs = **0.8 DASH** |
| split-tx fee (~1000 duffs/kB — the devnet runs a low `maxtxfee`) | ~1,000 duffs |
| **send to treasury** | **1.0 DASH** (leaves ~0.2 DASH change buffer for re-runs/top-ups) |

Each identity's ~8 × 10⁹ credits cover its platform fees (~110 doc writes ≈
0.3 × 10⁹), DPNS registration, and — under `--yapp-source purchase` — a 600-YAPP
buy (0.6 × 10⁹ credits at the 1,000,000-credits/YAPP price), with several× headroom.

YAPP per identity: `run-seeder.mjs` prints the corpus's exact total and
worst-case per-author cost (post/quote 10, reply 3, like/likeReply/repost 1).
The `--yapp` default of 600 covers a ~110-op/author mix comfortably; for the
full-scale run compute it from the printed numbers.

Full scale (500 identities at the default credits): 500 × 0.08 DASH = 40 DASH
plus fees — either raise the faucet ask or lower `--credits-per` to the
corpus-derived need.

## 2. Provision identities

```bash
NETWORK=devnet node scripts/seed/provision-seed-identities.mjs \
  --personas scripts/seed/personas.pilot.json [--yapp 600] [--only 0,1,2]
```

Phases (per identity; each persists to `.seed-identities.local.json` BEFORE its
broadcast, so a crash never strands funds):

1. **SPLIT** — one tx pays every planned identity's fresh one-shot asset-lock
   key from the treasury UTXOs, change back to the treasury.
2. **LOCK** — per identity, the DIP-2 type-8 asset-lock special tx (OP_RETURN
   burn output + `AssetLockPayload.creditOutputs`; proof outpoint = `txid:0`).
3. **REGISTER** — waits for ChainLock coverage of every lock tx concurrently
   (Insight block height + DAPI `getStatus` `core_chain_locked_height`;
   InstantSend proofs are REFUSED on moutai and would silently burn funds),
   then creates each identity with 5 fresh random keys (same purpose/security
   layout as the e2e bots; auth key id 1 signs everything).
4. **PROFILE** — profile document on the unified profile contract, fields
   validated against its maxLengths.
5. **DPNS** — registers the persona handle.
6. **YAPP** — maker transfer (default) or direct purchase, up to `--yapp`.

Ends with a table: personaIdx, state, handle, identityId, credits, YAPP.

**Resume semantics:** re-run the same command. The ledger records each
identity's state (`planned → funded → locked → registered → profiled → named →
ready`); completed phases are skipped, broadcast-but-uncredited steps are
re-probed on Insight/Platform first (never double-paid), and per-identity
errors are appended to the ledger's `errors` array without blocking the others.
Exit code is non-zero while any selected identity is not `ready`.

## 3. Run the seeder

```bash
NETWORK=devnet node scripts/seed/run-seeder.mjs \
  --personas scripts/seed/personas.pilot.json \
  --corpus  scripts/seed/corpus.pilot.jsonl \
  [--concurrency 10] [--max-ops 50]
```

- Per-author ops are strictly sequential (identity contract nonce); different
  authors run in parallel behind a global in-flight cap (`--concurrency`).
- `--max-ops N` executes at most N new ops then stops cleanly (useful as a
  smoke slice of the pilot); resume with the same command.
- Checkpoint: `.seed-progress.local.json` (append-only JSON lines: one record
  per executed corpus line + the ref → `{id, ownerId, hashtag}` map). Re-runs
  skip completed lines and retry failures; nothing is ever duplicated —
  documents get stable ids per op, so a retry of a broadcast that DID land
  converges on the same document.
- Failure handling: 504/timeout on the confirmation wait → readback decides;
  indexOnly like/likeReply throws post-broadcast even on success → acceptance
  is an entry-existence query; quorum rotation / address-pool collapse → full
  SDK reconnect; nonce desync → reconnect + retry; consensus rejections are
  logged with their line numbers and the run continues.

## 4. Read the report

`.seed-report.local.json` (also summarized on stdout):

| field | meaning |
|---|---|
| `done` / `failed` / `skippedAlreadyComplete` / `deferredByMaxOps` | op outcomes for this run |
| `opsPerSec`, `wallClockMs`, `perType.*.avgMs` | throughput; use these to size the full-scale run |
| `identities[].creditsConsumed` / `yappConsumed` | per-identity cost of the run |
| `totalCreditsConsumed` / `totalYappConsumed` | the cost model: multiply out for 500 users / 50k posts before funding the treasury |
| `errors[]` | every failed line with its error text |

## Pilot → full scale

1. Pilot: 10 personas, ~1100 ops, `--concurrency 10`. Verify the report's
   failure count is 0 and eyeball yap.pr/devnet.
2. From the report, compute full-scale funding: credits/op × 50k-corpus op mix
   + YAPP totals printed by the seeder; size `--credits-per` and `--yapp`
   accordingly.
3. Provision in batches with `--only` if the faucet caps the treasury balance;
   the ledger keeps every batch's state.
4. Run the full corpus with `--concurrency` raised only as far as the devnet's
   DAPI pool tolerates (watch for reconnect log lines; each identity still
   only ever has one ST in flight).

## Self-tests (no network, nothing broadcast)

```bash
node scripts/seed/provision-seed-identities.mjs --self-test   # split/asset-lock construction, validation, ledger states
node scripts/seed/run-seeder.mjs --self-test                  # corpus parsing, ref resolution, scheduling, resume, max-ops
```
