# Yappr devnet QA report

Test target: `https://yap.pr/devnet/` (HTTP 200, build `4105c5d`, observed 2026-09-15 UTC). Tests used Playwright Chromium at desktop (1280x900) and mobile (390x844), plus direct route crawling and browser console/error capture.

## User-story inventory

| Story | Routes / UI exercised |
|---|---|
| Discover public content | Home, Explore, Feed, hashtag, mentions, search, post and engagement views |
| Account onboarding/authentication | Login, QR wallet login, passkey, password/private-key login, create identity, welcome |
| Identity/profile | Profile create, user/profile pages, DPNS registration, avatar/banner, social links, payment URI |
| Compose and manage content | Post/reply/thread composer, media upload, polls, visibility/private-feed selector, edit/delete |
| Social graph and moderation | Follow/follow requests, followers/following, likes, reposts, bookmarks, blocks, notifications |
| Private/encrypted feeds | Private-feed explainer, dashboard, access requests, encryption-key registration/recovery/backup |
| Messaging | Messages/DMs, key exchange and QR login |
| Commerce | Store discovery, item view, cart, checkout/address/payment, orders, seller inventory/manage/create |
| Blogs/embeds | Blog discovery/editor/viewer/comments/themes, post embed |
| Informational/settings | About, contract/schema, cookies/storage, privacy, terms, settings |

## Findings

### P1 – CSP blocks a script requested by the deployed page
Every page sends a Content-Security-Policy with `script-src 'self' ...`; Cloudflare injects `https://static.cloudflareinsights.com/beacon.min.js/...`, which Chromium reports as blocked. This creates a persistent console error and disables the deployment's own Insights telemetry. Either remove the injection or add the exact host to `script-src` (and keep the policy intentional).

**Reproduce:** open `/devnet/` in Chromium with console logging enabled; observe `violates the following Content Security Policy directive` for `static.cloudflareinsights.com`.

### P2 – Missing-parameter embed is rendered as an unstyled bare error
`/devnet/embed/` returns HTTP 200 and body text only `Missing post id.`. It has no Yappr shell, navigation, recovery link, or 4xx status. Shared links with a missing/truncated query therefore strand users and are poor for crawlers/accessibility.

**Reproduce:** navigate to `https://yap.pr/devnet/embed/`.

### P2 – Invalid/empty contextual routes silently present misleading empty states
Routes such as `/devnet/hashtag/`, `/devnet/mentions/`, `/devnet/followers/`, `/devnet/following/`, and `/devnet/item/` return HTTP 200 for absent identifiers and show generic states (`No hashtag specified`, `No user specified`, `@User's Followers`, `Item not found`). They do not explain the required query format or offer a focused recovery action. This is especially confusing when links are copied or deep links lose query parameters.

### P2 – Mobile icon-only controls are not accessible
On 390px viewport the home page exposes numerous buttons whose accessible names are empty (navigation/menu and post action icons). Screen-reader users cannot identify like/repost/reply/share controls, and automated keyboard users receive no tooltip/label. Add `aria-label`/visible tooltips and verify focus states.

**Evidence:** Playwright `getByRole('button').allTextContents()` returns multiple empty strings on `/devnet/`; same controls are icon-only on mobile screenshot.

### P3 – Sign-in CTA duplication and inconsistent onboarding labels
Home renders both `Sign in to see more`, `Create Account`, and a separate nav `Sign In`; login renders `Scan with your Dash wallet`, `Sign in with a passkey`, and `Sign in with a password or private key`. The duplicated CTAs do not communicate which path creates/provisions an identity, and the “Create Account” action is visually equivalent to sign-in. A first-time user can enter a dead-end without knowing that an asset lock/funding step is required.

### P3 – Devnet warning is easy to miss on small screens
The amber banner collapses to `DEVNET | Data may reset` at mobile width, omitting that this is a Dash Platform devnet and that state can be reset. The shortened copy is materially less informative while destructive/reset semantics remain.

## Platform/GroveDB observations

The SDK initializes successfully against devnet and seeds 9 bundled contracts. Public reads returned populated posts/users (2.6K posts shown) without page errors. No authenticated write identity was available in this run, so state-transition, GroveDB proof, eventual-consistency, duplicate-key, and insufficient-balance paths could not be responsibly claimed as tested. The repository's `docs/TESTING.md` contains the required provisioning runbook (mnemonic, derivation path, faucet, identity registration, contract registration, and browser storage seeding) for a funded follow-up run.

## Setup transcript distilled from `docs/TESTING.md`

1. Put a BIP39 mnemonic in `.env.local` as `E2E_SEED_PHRASE`.
2. Derive keys with `node scripts/derive-identities.mjs <index> --reveal`; writes use authentication/high key index 2.
3. Provision/fund an identity with `node scripts/provision-test-identity.mjs <index> --dpns <name>` (faucet is rate-limited; stop on 429/503).
4. Register test contracts using `node scripts/register-test-contracts.mjs`; place resulting IDs and identity IDs in `.env.testing`.
5. For browser QA, seed `testing:yappr_session`, double-JSON-encoded `testing:yappr_secure_pk_<identityId>`, and `testing:yappr_skip_dpns=true` before every navigation (canonical recipe: `e2e/fixtures/auth.ts`).

## Test limitations

Authenticated writes and cross-identity stories (posting, replies, likes, follows, private feeds, DMs, commerce checkout/order transitions) require a funded devnet identity and private key. Agent retries for parallel authenticated probes were rate-limited (HTTP 429), so those paths remain explicitly unverified rather than being marked pass/fail.
