# Testing: the `/testing` deployment and the e2e suite

Yappr has no backend and no mock layer, so the only honest way to test it is to
run the real static export against real Dash testnet state. That is what the
`/testing` deployment is for: a second copy of the app, built from the same
commit as production, pointed at **dedicated test data contracts** and using a
**separate browser-storage namespace**, so automated writes can never touch
production state.

- Production: `https://yap.pr/` (master, production contracts)
- Testing: `https://yap.pr/testing/` (same master commit, test contracts)
- Staging: `https://yap.pr/staging/` (staging branch, production contracts)
- Staging-old: `https://yap.pr/staging-old/` (staging branch, the D36 rehearsal contracts and their seeded data; QA only, not monitored)
- Beta: `https://yap.pr/beta/` (staging branch, a rehearsal copy of the "hide, don't delete" social v18, blog v10 and storefront v11 with seeded data; QA only, not monitored)

## 1. Architecture

### Isolation

Two independent mechanisms keep the testing deployment from colliding with
production:

1. **Dedicated contracts.** `lib/constants.ts` reads every contract ID from a
   `NEXT_PUBLIC_*_CONTRACT_ID` env var and falls back to the production ID when
   it is unset. `npm run build:testing` sources the checked-in `.env.testing`,
   which overrides the social and profile contracts:

   | Contract | Test ID |
   |----------|---------|
   | social (`NEXT_PUBLIC_YAPPR_CONTRACT_ID`) | `2qvaZNJJU2KQxSn7SB7eTyyWtjvGD8wx3cpVHZSPC4mn` |
   | profile (`NEXT_PUBLIC_YAPPR_PROFILE_CONTRACT_ID`) | `HpQGZcLJMCTE27vFHmwdPGTUVzzcqsPpD6urGsapsBk` |

   Both are owned by e2e bot identity 0.

2. **Scoped storage.** `next.config.js` sets `NEXT_PUBLIC_STORAGE_SCOPE` from
   `BASE_PATH`, and `lib/storage-scope.ts` prefixes every persisted key with it.
   The `/testing` build therefore writes `testing:yappr_session`,
   `testing:yappr_secure_pk_<id>`, and so on. Production has no base path, so
   its keys keep their historical unprefixed names.

Because `.env.testing` only holds public data (contract IDs, identity IDs) it is
checked in. Private key material — the seed phrase — lives in the gitignored
`.env.local` and in the `E2E_SEED_PHRASE` GitHub Actions secret, never here.

### Devnet specs (local only)

The devnet E2E CI job and the `/devnet` site are retired: devnet-sakura is gone.
No CI job replaces it, so the devnet-only specs (topology, DM v5, storefront
variants, username entry) have no CI coverage until they are pointed at a
modern testnet set; they remain and run locally against a devnet build (`npm run build:devnet`, which reads `.env.devnet` and
exports under `/devnet` into `out/`; nothing deploys it). They need a live
devnet whose contracts and bot pool match `.env.devnet`, and a dedicated seed in
`E2E_DEVNET_SEED_PHRASE` (gitignored `.env.local`). Playwright does not load
`.env.local`, and the write specs read only `E2E_SEED_PHRASE`, so export the
devnet seed under that name in the shell that runs them. This reads it from
the environment or `.env.local` without echoing it, and exports nothing when
it is missing or fails its checksum:

```bash
E2E_SEED_PHRASE="$(node --input-type=module -e "import { loadMnemonic } from './scripts/derive-identities.mjs'; process.stdout.write(loadMnemonic('E2E_DEVNET_SEED_PHRASE'))")" \
  && export E2E_SEED_PHRASE || unset E2E_SEED_PHRASE
```

Without it the write specs skip. Never reuse the testnet seed for a devnet pool.

After a devnet reset, provision the bot pool in derivation-index order and
update only the public `E2E_IDENTITY_IDS` in `.env.devnet`. Verify that each
derived authentication key matches an enabled key on its registered identity
before running write tests. Fund the identities' credits and YAPP balances
separately from the contract maker. The SDK cannot connect without the
devnet's quorum service (`NEXT_PUBLIC_QUORUM_URL` in `.env.devnet`, or
`https://quorums.<NEXT_PUBLIC_DEVNET_NAME>.networks.dash.org` when that is
empty), so check that it answers `/quorums` and `/previous` before a run.

The SDK recovery smoke spec (`sdk-offline-recovery`) still runs in the testnet
job, but it skips when testnet's endpoint pool survives ten failed reads. The
devnet job was the only run with `E2E_REQUIRE_SDK_EXHAUSTION=1`, so CI no longer
proves recovery after the pool is exhausted; set it locally on a configuration
whose pool is small enough to exhaust.

The DM v5 specs (`e2e/write/dm-v5-*.spec.ts`) need slots 1-8 of that pool:
up to five identities talk to each other, each device on its own browser
context, and some also sign documents from Node (a squatted tag, a forged
grant, bulk history). Every slot has the seed-derived ENCRYPTION key (key index 4) and a
`yappr-dm-e2e-<n>` DPNS name the group pickers search for. Each file sets up
what it needs (1:1 = 1-2, history = 5-6 with 1-2 as partners, groups = 1-5,
recovery = 7-8), so a file can run alone:

```bash
npm run build:devnet
E2E_BASE_PATH=/devnet E2E_ENV_FILE=.env.devnet NETWORK=devnet \
  npx playwright test --project=write --trace=off dm-v5
```

On an App Connect build (`NEXT_PUBLIC_LOGIN_PROTOCOL=app-connect`) only an
ENCRYPTION key bound to the `yappr-app` anchor counts, so the fixture switches
each bot to its anchor key: the one the app's "Set up messaging" derives from
the bot's AUTHENTICATION/HIGH key (`lib/crypto/derive-encryption-key.ts`). That is the typed-key developer derivation (D38), not what a wallet derives: a wallet's key is the DIP-13 `7'` key of [APP_CONNECT_PROFILE.md](APP_CONNECT_PROFILE.md) rule 7, so do not copy this as the wallet rule. The
sakura ops script `ops/add-anchor-messaging-keys.mjs` registered it on slots
1-8; a slot without it fails at once instead of timing out. Slot 0 is kept
without one on purpose: `e2e/write/messaging-setup.spec.ts` uses it for the
"hasn't set up messaging yet" state and for the "Set up messaging" wallet
request (decoded, never signed), and skips itself on legacy builds or when slot
0 has a key. To run the DM files against an App Connect build:

```bash
NEXT_PUBLIC_LOGIN_PROTOCOL=app-connect npm run build:devnet
NEXT_PUBLIC_LOGIN_PROTOCOL=app-connect E2E_BASE_PATH=/devnet E2E_ENV_FILE=.env.devnet NETWORK=devnet \
  npx playwright test --project=write --trace=off dm-v5 messaging-setup
```

A wallet sign-in cannot be tapped through in these specs. The Node test-wallet responder in `mobile/tools/` answers an App Connect request the way a wallet does (see `mobile/tools/README.md`); `docs/PASSKEY_VAULT.md` describes the responder-driven flow the passkey spec uses.

The storefront v7 spec (`e2e/write/storefront-variants.spec.ts`) runs the
same way. Its seller creates a store (once per identity) and a variant listing from
Node, with the action fees the app agrees to (the file's store and item fees). Its
buyer then picks a combination, checks out, and the seller reads the order
with its SKU. It uses pool slots 7 and 8. `E2E_STOREFRONT_SLOTS=<seller>,<buyer>`
picks others in a smaller pool:

```bash
npm run build:devnet
E2E_BASE_PATH=/devnet E2E_ENV_FILE=.env.devnet NETWORK=devnet \
  npx playwright test --project=write --trace=off storefront-variants
```

Pass `--trace=off` to these runs: authentication fixture arguments include a
private key. Screenshots and the HTML report remain available.

Runs share the bot identities, so two runs at once break each other: they take
each other's identity nonces, pick the same next group number, and block or
message bots the other run is asserting on. Run one devnet write run at a time.

### Deployment

`.github/workflows/deploy.yml` builds one Pages artifact containing all three
sites. Master pushes deploy through a `workflow_run` gate: the deploy only runs
after the **CI** workflow for that push concludes successfully, so a failing e2e
run blocks production. The testing site reuses the master checkout (same commit,
same `node_modules`) and just rebuilds with `npm run build:testing` after moving
the production `out/` aside and deleting `.next`.

### Test suite

`playwright.config.ts` serves the already-built `out/` with
`scripts/serve-static.mjs` (which adds the COEP/COOP headers the WASM SDK needs
and the correct `.wasm` MIME type). The build is deliberately *not* part of
`webServer`, so the artifact under test is byte-identical to the one deployed.

Two projects:

| Project | Writes? | Needs `E2E_SEED_PHRASE`? |
|---------|---------|--------------------------|
| `smoke` | no — read-only public pages and a build-stamp check | no |
| `write` | yes — real state transitions on testnet | yes; self-skips without it |

`workers: 1` and `fullyParallel: false` are deliberate: DAPI rate-limits hard
and parallel SDK clients exhaust the available addresses. CI retries twice.

## 2. Local development loop

```bash
npm run build:testing        # sources .env.testing, builds with BASE_PATH=/testing
npm run test:e2e             # serves out/ on :3000/testing and runs both projects
```

Without a seed phrase this runs `smoke` only; the `write` project skips visibly
with a message naming `E2E_SEED_PHRASE`. To run the full suite, put the bot seed
in the gitignored `.env.local`:

```bash
echo 'E2E_SEED_PHRASE=<twelve or twenty-four words>' >> .env.local
npm run test:e2e
```

Useful knobs:

```bash
npx playwright test --project=smoke          # read-only subset
npm run test:e2e:ui                          # Playwright UI mode
E2E_IDENTITY_INDEX=1 npm run test:e2e        # pick a pool slot (wraps mod pool size)
E2E_PORT=4000 npm run test:e2e               # different local port
E2E_REQUIRE_SDK_EXHAUSTION=1 npx playwright test sdk-offline-recovery  # fail, not skip, if the SDK pool never exhausts
```

Retarget an already-deployed site instead of the local server (the `webServer`
still starts but nothing navigates to it):

```bash
E2E_BASE_URL=https://yap.pr/testing npx playwright test --project=smoke
```

`E2E_BASE_URL` also determines the storage scope the fixtures use: it is derived
from the URL's path, so `https://yap.pr/testing` and `http://localhost:3000/testing`
both yield `testing:`.

To browse the testing build by hand:

```bash
npm run build:testing
node scripts/serve-static.mjs --port 3000 --base /testing
# open http://localhost:3000/testing/
```

## 3. Driving the deployed app as a bot (no UI login)

The app restores a session purely from browser storage, so an agent or script
can log in by seeding three keys before the first navigation — no login modal,
no credits spent on the login path. This works identically against
`https://yap.pr/testing/` and a local `--base /testing` server, because both use
the `testing:` scope.

Get the identity's **AUTHENTICATION/HIGH** WIF (key index 2 — writes require
AUTHENTICATION at CRITICAL or HIGH):

```bash
node scripts/derive-identities.mjs 0 --reveal
```

Then seed, before any page script runs (Playwright: `context.addInitScript`):

```js
// localStorage
localStorage.setItem('testing:yappr_session', JSON.stringify({
  user: { identityId: '<identityId>', balance: 0, publicKeys: [] },
  timestamp: Date.now(),
}))
// The secure store JSON-encodes its values, so the WIF is *double* quoted.
// JSON.stringify(wif) — a bare WIF string will not load.
localStorage.setItem('testing:yappr_secure_pk_<identityId>', JSON.stringify(wif))

// "Skip choosing a username", remembered per identity (lib/username-skip.ts)
localStorage.setItem('testing:yappr_skip_dpns:<identityId>', '1')
```

Notes:

- Seed the private key on **every** navigation, not just the first. If it goes
  missing mid-session the app drops the session and opens the login modal.
- `yappr_secure_pk_<identityId>` — the suffix is the identity ID, and the
  `yappr_secure_` prefix comes from `lib/secure-storage.ts`.
- The canonical implementation of this recipe is `e2e/fixtures/auth.ts`; keep
  the two in sync.

## 4. Provisioning runbook

Rare, manual, never from CI. Everything below runs from the repo root.

1. **Generate a mnemonic** (any BIP39 tool) and put it in `.env.local`:

   ```bash
   echo 'E2E_SEED_PHRASE=<mnemonic>' >> .env.local
   ```

   Keys are derived at `m/9'/1'/5'/0'/<identityIndex>'/<keyIndex>'`, with:

   | Key index | Purpose | Security level |
   |-----------|---------|----------------|
   | 0 | AUTHENTICATION | MASTER |
   | 1 | AUTHENTICATION | CRITICAL |
   | 2 | AUTHENTICATION | HIGH |
   | 3 | TRANSFER | CRITICAL |
   | 4 | ENCRYPTION | MEDIUM |

   Inspect (public data only) with `node scripts/derive-identities.mjs <index>`;
   add `--reveal` to print WIFs.

2. **Provision each identity.** The faucet pays plain Core addresses only (its
   old `/api/asset-lock-proof` endpoint is gone), so fund the asset lock
   yourself, then register the identity and optionally a DPNS name:

   ```bash
   NETWORK=testnet node scripts/provision-test-identity.mjs --gen-asset-lock-key /path/al-0.key
   # send ~1-3 tDASH to the printed assetLockAddress (faucet, or the dash-faucet skill)
   # the faucet's vout: Insight /addr/<assetLockAddress>/utxo
   NETWORK=testnet node scripts/build-asset-lock.mjs --key-file /path/al-0.key --outpoint <faucetTxid>:<vout>
   NETWORK=testnet node scripts/provision-test-identity.mjs 0 \
     --asset-lock-key-file /path/al-0.key --funding-outpoint <assetLockTxid>:0 --dpns yappr-e2e-0
   ```

   The last step waits for the asset-lock transaction to be chain-locked
   (a few minutes) before it registers the identity.

   Identity IDs are **not** derivable (they come from the asset-lock outpoint),
   which is why they are recorded in `.env.testing`. The script prints the ID to
   append to `E2E_IDENTITY_IDS`.

   A profile is optional (see §7): `post-lifecycle.spec.ts` creates one on its
   first run by editing the bot's own `/user` page, and the DM specs create one
   from Node. The same applies after a chain rollback that wipes documents but
   keeps identities.

3. **Register the test contracts.** Not available right now. The script that
   cloned the current /testing pair (social v2 and profile, above) is retired.
   Its replacement is the App Connect set, registered from a test-owned maker
   (never the production one) with `scripts/register-app-connect-contracts.mjs`.
   That set has different contracts (social v16 and the v5+ feature contracts),
   so `.env.testing` has to move with it: the contract and group ids the
   publisher prints, and the topology settings that select those contracts
   (`NEXT_PUBLIC_CONTRACT_TOPOLOGY` and the feature topologies; see
   `.env.devnet`). Until that migration lands, re-registering /testing with the
   publisher would pair the app's v2 defaults with v16 contracts.

4. **Update `.env.testing`** with the new contract IDs and identity IDs, and
   commit it.

5. **Publish the secret** so CI can run the write project:

   ```bash
   gh secret set E2E_SEED_PHRASE < /path/to/mnemonic.txt
   ```

### Faucet etiquette (https://faucet.thepasta.org)

- Check status before requesting; trust the live values rather than hard-coding:

  ```bash
  curl -fsS https://faucet.thepasta.org/api/status | jq .
  ```

- **One request at a time.** Never loop or parallelise.
- On **429**, stop. Honour `retryAfter`; do not retry automatically. The limit is roughly three requests per IP per hour (see
  `rateLimitPerHour` in `/api/status`).
- On **503** the faucet wallet is low on funds, has no suitable UTXO, or an
  InstantSend lock timed out. If a txid was reported the funding transaction may
  already be broadcast — check before requesting again. Otherwise wait.
- On **404** from `provision-test-identity.mjs` the script tried the retired
  proof-serving endpoint: use the `--gen-asset-lock-key` route in step 2.

### Top-ups

CI pre-checks balances and fails fast with an actionable message when the pool
is depleted. To top up by hand, fund and build an asset lock as in step 2, then:

```bash
NETWORK=testnet node scripts/provision-test-identity.mjs --check-balances
NETWORK=testnet node scripts/provision-test-identity.mjs --topup <identityId> \
  --asset-lock-key-file /path/al.key --funding-outpoint <assetLockTxid>:0
```

## 5. Resetting test state

There is no per-test cleanup (deletes cost credits and flake), so the test
contracts accumulate documents. Wiping the slate means registering fresh
contracts, which waits on the App Connect migration described in step 3 of the
provisioning above. Until then the current /testing contracts cannot be reset.

### Test content on the public devnet

#### The social timeline

The devnet has no test copy of the social contract: the batteries and the
devnet specs use the published one, so a test post sits on Recent beside real
people's. Test runs therefore take their posts and replies
down again, with the author's own delete. From social v11 a post or reply
cannot be deleted; its author replaces it with a tombstone (`deleted: true`
plus the fields the contract freezes: a post's tags, a reply's `rootPostId`,
`replyToReplyId` and, up to v13, its stored owners), which every feed hides
(`tombstonesAreHidden()`). Each
test identity signs and pays for its own tombstones, and they refund the
content's storage. The maker's moderator delete is never used for this, and the
cleanup refuses the maker and the contract owner outright.

- **verify-v10** tombstones what its bots wrote since the run started, once
  every case has run (so cases that count posts or assert on tombstones are
  unaffected). Pass `--keep-content` to leave a run's content up for
  inspection. The cleanup takes everything the run's bots wrote since it
  began, so two batteries must not share a bot at the same time.
  `prove-merged-counts` and `measure-social-fees` need nothing:
  their writes land on a throwaway contract the app never reads.
- **The devnet specs** do not clean up after themselves. Record the start
  time before a local write run (`STARTED=$(node -p 'Date.now()')`) and pass it as
  `--since "$STARTED"` to both spec-pool commands below, so the cleanup takes
  only that run's posts and replies.

To take test content down by hand (both commands are idempotent; `--plan`
writes nothing and also reports who wrote the newest timeline posts):

```bash
# Spec pool (E2E_DEVNET_SEED_PHRASE, ids from .env.devnet)
NETWORK=devnet node scripts/clean-test-content.mjs --plan --ci-pool --since "$STARTED"
NETWORK=devnet node scripts/clean-test-content.mjs --live --ci-pool --since "$STARTED"

# Battery bots (E2E_SEED_PHRASE, ids from DEVNET_IDENTITY_IDS or index:id)
NETWORK=devnet DEVNET_IDENTITY_IDS=<bot0>,<bot1>,<bot2> \
  node scripts/clean-test-content.mjs --live --bots 0,1,2
```

`--since <ms|iso>` limits a run to documents created from then on. A live
run exits 1 when something could not be tombstoned; run it again, since it only
touches what is still live. The library behind both is
`scripts/test-content-cleanup.mjs`.

#### Pollr, blog and storefront

The feature batteries (`verify-pollr`, `verify-blog`, `verify-storefront`) act
as seed-ledger personas on the contracts `.env.devnet` lists. What each run
leaves is handled per contract (`scripts/surface-cleanup.mjs`):

- **pollr runs on a test contract.** A poll with a ballot can never be removed:
  `vote` is `canBeDeleted: false`, and `noBallots` counts a withdrawn ballot
  too. So by default the battery runs on the *pollr-test* contract, a copy of
  `contracts/pollr-contract.json` that the creator persona (230) registered once
  and every later run reuses. The app never reads it, so its polls stay there
  out of sight. The copy names no other contract, token or moderator, so the
  cases and their error codes are the same as on the published contract.
  Its id is recorded per network in the gitignored `.test-contracts.local.json`
  beside the sha256 of the file it was registered from. When none is recorded,
  the devnet was wiped, or the file has changed, the run stops and asks for
  `--register-test-contract`, which registers a new one for about 19×10⁹ credits
  (≈1,150¢). The creator pays, funded through the treasury like any persona;
  the maker never registers one. `--live-contract` aims the cases at the
  published contract instead. Its cleanup then deletes the run's polls that
  took no ballot and lists the rest as leftovers.
- **blog** cleans up after every run, once every case has run. Comments and
  follows go by their owners' deletes, and posts and drafts by the author's
  tombstone (the client's delete). The run's blogs go by the `--moderator`'s
  removal, since a blog's owner cannot delete it. On sakura that moderator is
  the maker, the contract's interim moderator, so run with `--moderator maker`
  (the battery acts as it for b13–b17 too). With a moderator that cannot
  remove them, the removals fail and the blogs stay; the cleanup prints them.
- **storefront** cleans up after every run, once every case has run. Reviews,
  digital kits and shipping zones go by their owners' deletes, and items by
  `status: 'deleted'`. A store cannot be deleted and is unique per owner, so
  a store the run created is closed. The app lists active stores only. The
  next run reopens it for its cases and then gives it its earlier status back.
  Orders, their status updates
  and deliveries are permanent. They are printed as leftovers; they are
  encrypted and only their buyer and seller read them.

`--keep-content` skips a battery's cleanup. A cleanup never changes a battery's
verdict; one that fails prints a WARNING. It removes everything the run's
personas wrote since the run started, so two runs must not share personas at
once.

By hand, keyed by the owners' persona indexes and a start time (`--since` is
required, since the same personas own seeded content; `--plan` writes nothing):

```bash
NETWORK=devnet node scripts/clean-test-content.mjs --plan --surface blog,storefront,pollr \
  --personas 200,201,202,210,211,212,230,231,232 --since 2026-10-13T15:42:00Z
NETWORK=devnet node scripts/clean-test-content.mjs --live --surface blog,storefront \
  --personas 200,201,202,210,211,212 --since 2026-10-13T15:42:00Z --moderator maker
```

`--personas p:<id>` names an identity when the seed ledger is not at hand,
which is enough for a plan; a live run signs with the ledger's keys.
`--moderator` removes the blogs the personas created in the window. Leftovers
do not fail a run; anything that could not be removed does (exit 1).

## 6. Adding a pool identity

Index 2 (`yappr-e2e-2.dash`) is reserved but not yet registered — provisioning
hit a faucet UTXO outage. CI already spreads runs over a three-slot pool
(`GITHUB_RUN_ID % 3`) and the fixtures wrap the index modulo the pool's real
size, so the missing slot is harmless until it is filled. To add it:

```bash
NETWORK=testnet node scripts/provision-test-identity.mjs 2 --dpns yappr-e2e-2
```

Append the printed identity ID to `E2E_IDENTITY_IDS` in `.env.testing` — **in
derivation-index order**, since the fixtures index the list positionally — and
commit.

## 7. Known quirks

Verified during implementation; each of these costs hours to rediscover.

### Only the social and profile contracts have test copies

**DM, storefront, blog, and encrypted key-backup still resolve to the
PRODUCTION contract IDs** on the `/testing` deployment, because `.env.testing`
leaves their overrides commented out and `lib/constants.ts` falls back to
production. Any e2e coverage of those features would write to production state.
Register test copies first (the App Connect set, once the migration in
step 3 of the provisioning runbook lands), fill in the corresponding `NEXT_PUBLIC_*_CONTRACT_ID` in
`.env.testing`, and only then write the specs.

### A profile is optional

No route requires a profile document. A signed-in identity without one sees
its DPNS label as its name (or `User <last 6 of id>` without a username), and
the first save from its own `/user` page (the in-place editor, the avatar or
the banner) creates the profile.

- `post-lifecycle.spec.ts` gives its slot a named profile that way on the
  first run, so a later test can assert the reply's parent author by name.
  The DM specs create one per devnet slot from Node before opening a device
  (`ensureProfile` in `e2e/fixtures/dm.ts`).
- The `withAuth` redirect to `/dpns/register` carries the requested route
  (pathname plus query, without the base path) as `?next=`, e.g.
  `/dpns/register?next=%2Fsettings%2F`. Registering or skipping returns the
  user there; merely dismissing the modal, or a registration that failed
  everywhere, goes to `/feed` instead, since `next` is then usually a page that
  needs a username and would reopen the modal. `lib/auth/return-to.ts` accepts
  only an app-relative path starting with a single `/` (no `//`, scheme,
  backslash, whitespace or control characters), strips a leading base path
  (`/testing`, `/staging`), and never returns to `/dpns/register` or `/login`.

### The DPNS gate respects `optional`

In `withAuth`, the `needsDPNS` branch used to run even when `options.optional`
was set, so a user object without a DPNS username got pushed to
`/dpns/register` on optional-auth pages (`/feed`, `/post`, `/blog`,
`/followers`, `/following`). That is fixed: the gate no longer fires when
`options.optional` is true.

Non-optional pages still redirect, so keep seeding
`testing:yappr_skip_dpns:<identityId> = "1"` (localStorage) for identities without a DPNS name whenever a
test touches one of those pages.

### Playwright `baseURL` drops the base path

`baseURL` has no trailing slash, so `page.goto('/feed/')` resolves against the
origin and loses `/testing`. Use `appUrl()` from `e2e/fixtures/app.ts` for every
navigation.

### DAPI flakiness is normal

`wait_for_state_transition_result` 504s routinely even when the transition
landed. The app broadcasts, assumes success, and updates the UI optimistically.
Tests mirror that: assert the optimistic UI right after the action, then use
`reloadUntilVisible()` from `e2e/fixtures/eventual.ts` for anything that has to
come back out of a chain query (the app caches query results per page load, so
reloading beats waiting). `workers: 1` is part of the same story.

### Nothing prints key material

`derive-identities.mjs` withholds WIFs unless `--reveal` is passed, and the
provisioning scripts redact WIF-shaped strings from error output. Keep it that
way — CI logs are public.
