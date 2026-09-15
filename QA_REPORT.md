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

## Authenticated follow-up (current seeded devnet)

The current seeded devnet corpus is available under `/Users/pasta/.local/share/yappr-seed-20260915-hour/` (100 identities; live topology-v6 contracts). Additional authenticated probing found:

- **P1 Blog creation gives no actionable failure.** With a valid signed session, submitting Create Blog logs `Error creating document: Identity not found`; the modal stays open and no visible toast/inline error appears. The user cannot tell whether to retry, change identity, or wait.
- **P1 Store creation exposes raw failure but cannot recover.** Store create submission returns `Identity not found` inline while retaining the form; there is no guidance or retry state. This is a deployment/data identity mismatch surfaced through Yappr's write path.
- **P2 Store management routes lose context.** Authenticated `/store/inventory/` and `/store/manage/` with no store both render the Create Store form, rather than explaining that a store is missing or linking to the store selector.
- **P2 Store item deep link is blank.** `/store/view/` without an item id renders the shell/navigation with an empty center and no missing-id message or browse/recovery action.
- **P2 Blog dialog accessibility warning.** Create Blog's Radix `DialogContent` emits “Missing Description or aria-describedby”; the modal lacks an accessible description for screen readers.

These writes used a seeded persona against the current devnet contracts and captured the DAPI error text from the browser console/UI. Social, private/DM, and commerce agents are continuing with the current 100-persona corpus; their results will be merged here before completion.

### Critical authenticated DM finding

- **P0 DM send is silently lost.** Persona `carol9-sept` selected `paints-sasha9`, entered a message, and submitted. Yappr redirected to `/feed/` without success or error. A fresh session as the recipient showed the conversation shell but `No messages yet. Start the conversation!`; the message was not persisted. This is a destructive UX/data-loss failure in the primary messaging story. Reproduce with two seeded identities and inspect the recipient after confirmation.
- **P1 Encryption/Auth Vault controls absent.** Settings → Privacy & Security for the current seeded identity shows only the Privacy section; controls to create encryption keys, add a password/passkey, or configure Auth Vault are absent even though feature contracts are present. The private-feed/key-management story cannot be completed through the UI.

### Authenticated social findings (current seeded devnet)

- **P1 Write failures are invisible.** Compose Post with a balance below the required YAPP/credit cost fails DAPI broadcast (`Insufficient identity ... balance ... required ...`), but the modal remains populated with the blue Post button and no toast or inline error. Users are encouraged to retry without understanding funding/cost. Existing-post Like has the same hidden failure (`Like operation failed` only in console).
- **P1 Optimistic bookmark state is false.** Clicking Bookmark turns the icon blue, but a fresh `/bookmarks/` context still reports `0 saved posts` after the write fails. The UI does not roll back the optimistic state or report failure.
- **P2 Post action controls lack accessible names/state.** Reply, repost, like, bookmark, and share controls are icon-only with no usable `aria-label`/title; bookmark also lacks `aria-pressed`. This blocks discoverability and assistive technology use.

Evidence: `/tmp/postattempt.png` was inspected; it shows the failed compose still populated with the active Post button. DAPI error text and the fresh-context bookmark check were recorded by the social probe.

### Authenticated commerce/blog findings (current seeded devnet)

- **P1 Payment URI validation accepts malformed addresses.** Store → Add Payment Method accepts `yUvJf3g4Qw1QfFfR9o2d8mT5cX9kLmN7pQ` (invalid length/checksum), stores it as `tdash:yUv...`, and marks payment as configured. Buyers can be given an unusable payment destination; validate Dash URI/address network, checksum, and length before persistence.
- **P2 Duplicate payment-modal actions.** The Add Payment modal exposes duplicate controls named “Add Payment Method” plus a submit “Add Payment”, creating visual and automation ambiguity.
- **P2 Seller checkout ambiguity.** A seller account can add its own product to cart and reaches an enabled Checkout action; the UI does not explain or prevent self-purchase. Cross-identity buyer checkout still needs confirmation.
- **P2 Blog dialog lacks accessible description.** Radix reports `Missing Description or aria-describedby={undefined}` when Create Blog opens.

Positive coverage: seeded commerce QA successfully created a store, product, inventory entry, viewed the product, added it to cart, and created a blog with visible My Blogs entry and success toast. Orders/seller empty states rendered correctly.

Further DM verification confirms the loss is deterministic for the first message to a recipient with no prior conversation: the conversation shell is created, but the first message (`first-init-probe`) is absent after 20 seconds in a fresh recipient session. A later message succeeds once both sides have initialized keys, indicating a first-message/key-exchange race. The app still gives no error or retry guidance.

Additional mobile commerce observation: the settings screen visibly renders two stacked bottom-navigation rows (primary five-icon row plus Store/Blog/Profile/Notifications row), consuming roughly 100 px of viewport and creating a cluttered, ambiguous navigation hierarchy.

## Coverage disposition

| Area | Disposition |
|---|---|
| Public home/explore/feed/search/hashtag/profile/engagements | Exercised against live seeded corpus; reads and navigation work |
| Auth/session restoration | Verified with seeded key material; identity recognized and feed loads |
| Post/like/bookmark writes | Exercised; insufficient-balance errors are hidden and bookmark state is not rolled back |
| Follow/follower/notifications | Public/read surfaces inspected; authenticated transition needs a dedicated funded run to avoid spending seeded corpus budget |
| Private feeds/key onboarding | UI/settings inspected; key-management controls absent for current identity |
| First-message DM and subsequent DM | First message loss reproduced; subsequent initialized-key message succeeds |
| Store/product/inventory/cart | Store, product, inventory, view, add-to-cart and cart persistence verified |
| Checkout/order/review | Seller self-cart reached checkout; cross-identity payment/order transition remains unverified |
| Blog create/discovery | Blog creation and My Blogs persistence verified; dialog accessibility warning reproduced |
| DPNS/identity creation/passkey/wallet QR | Entry surfaces inspected; creating a new funded identity and external wallet/passkey ceremony require hardware/external funding and were not fabricated as passes |

The report deliberately distinguishes verified behavior from unverified flows requiring an external wallet ceremony or additional funded identities.
