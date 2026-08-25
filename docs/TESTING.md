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

   Both are owned by e2e bot identity 0 and were published by
   `scripts/register-test-contracts.mjs`.

2. **Scoped storage.** `next.config.js` sets `NEXT_PUBLIC_STORAGE_SCOPE` from
   `BASE_PATH`, and `lib/storage-scope.ts` prefixes every persisted key with it.
   The `/testing` build therefore writes `testing:yappr_session`,
   `testing:yappr_secure_pk_<id>`, and so on. Production has no base path, so
   its keys keep their historical unprefixed names.

Because `.env.testing` only holds public data (contract IDs, identity IDs) it is
checked in. Private key material — the seed phrase — lives in the gitignored
`.env.local` and in the `E2E_SEED_PHRASE` GitHub Actions secret, never here.

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

// sessionStorage
sessionStorage.setItem('testing:yappr_skip_dpns', 'true')
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

2. **Provision each identity.** The script requests an asset lock from the
   faucet, registers the identity, and optionally registers a DPNS name:

   ```bash
   node scripts/provision-test-identity.mjs 0 --dpns yappr-e2e-0
   ```

   Identity IDs are **not** derivable (they come from the asset-lock outpoint),
   which is why they are recorded in `.env.testing`. The script prints the ID to
   append to `E2E_IDENTITY_IDS`.

3. **Register the test contracts** (owner defaults to identity index 0):

   ```bash
   node scripts/register-test-contracts.mjs
   ```

   It clones the production contracts' on-chain schemas verbatim under the new
   owner and prints the `.env.testing` lines to paste.

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
- On **429**, stop. The script prints `retryAfter` — honour it; do not retry
  automatically. The limit is roughly three requests per IP per hour (see
  `rateLimitPerHour` in `/api/status`).
- On **503** the faucet wallet is low on funds, has no suitable UTXO, or an
  InstantSend lock timed out. If a txid was reported the funding transaction may
  already be broadcast — check before requesting again. Otherwise wait.
- A **captcha** may be required. Solve it in the web UI and pass the token:

  ```bash
  node scripts/provision-test-identity.mjs 2 --dpns yappr-e2e-2 --cap-token <token>
  ```

  When the token cannot leave the browser, split the flow: generate the
  asset-lock key locally, fund it from the faucet page, and feed the response
  back in.

  ```bash
  node scripts/provision-test-identity.mjs --gen-asset-lock-key /tmp/al.key
  # prints assetLockPublicKey; POST it to /api/asset-lock-proof from the faucet
  # page (its CAP widget runs there), save the JSON response to /tmp/al.json
  node scripts/provision-test-identity.mjs 2 \
    --asset-lock-key-file /tmp/al.key \
    --funding-proof-file /tmp/al.json \
    --dpns yappr-e2e-2
  ```

### Top-ups

CI pre-checks balances and fails fast with an actionable message when the pool
is depleted. To do it by hand:

```bash
node scripts/provision-test-identity.mjs --check-balances
node scripts/provision-test-identity.mjs --topup <identityId>
```

## 5. Resetting test state

There is no per-test cleanup (deletes cost credits and flake), so the test
contracts accumulate documents. To wipe the slate:

```bash
node scripts/register-test-contracts.mjs
```

New contracts start empty and the old ones are simply abandoned. Paste the
printed IDs into `.env.testing` and commit — the next `build:testing` (local and
deployed) picks them up.

## 6. Adding a pool identity

Index 2 (`yappr-e2e-2.dash`) is reserved but not yet registered — provisioning
hit a faucet UTXO outage. CI already spreads runs over a three-slot pool
(`GITHUB_RUN_ID % 3`) and the fixtures wrap the index modulo the pool's real
size, so the missing slot is harmless until it is filled. To add it:

```bash
node scripts/provision-test-identity.mjs 2 --dpns yappr-e2e-2
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
Register test copies first (`scripts/register-test-contracts.mjs` is the
pattern — extend it), fill in the corresponding `NEXT_PUBLIC_*_CONTRACT_ID` in
`.env.testing`, and only then write the specs.

### Session restore does not run the profile gate

The `profile-required` intent is only applied by the interactive login path
(`applyIntent` in `contexts/auth-context.tsx`). `restoreSession()` does not go
through it, so a seeded profile-less identity is *not* bounced to
`/profile/create` — except on the own-profile page (`app/user/page.tsx`), which
redirects on its own. Do not rely on the redirect to prove a profile exists.

### The DPNS gate fires on optional-auth pages too

In `withAuth`, the `needsDPNS` branch runs even when `options.optional` is set:
if a user object exists without a DPNS username, the effect pushes to
`/dpns/register`. Always seed `testing:yappr_skip_dpns = "true"` for identities
without a DPNS name.

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

### Instant locks go stale

Asset-lock instant lock proofs expire when the signing quorum rotates. If
provisioning fails with `Instant lock proof signature is invalid`, wait for the
funding transaction to be confirmed and re-run with the block height it landed
in:

```bash
node scripts/provision-test-identity.mjs 2 \
  --asset-lock-key-file /tmp/al.key \
  --funding-proof-file /tmp/al.json \
  --chain-lock <tx block height>
```

### Nothing prints key material

`derive-identities.mjs` withholds WIFs unless `--reveal` is passed, and the
provisioning scripts redact WIF-shaped strings from error output. Keep it that
way — CI logs are public.
