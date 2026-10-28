# Yappr

A decentralized social network and marketplace on Dash Platform. Posts, profiles, likes, follows, bookmarks, direct messages, private feeds, blogs, polls, stores and orders are all documents on chain, owned by the identity that wrote them. There is no server: the site is a static export that talks to Dash Platform directly from the browser.

<img src="public/yappr.png" alt="Yappr" width="200">

Live at [yap.pr](https://yap.pr). A second copy at [yap.pr/testing](https://yap.pr/testing/) runs the same code against dedicated test contracts and is what the end-to-end suite drives; [yap.pr/devnet](https://yap.pr/devnet/) runs the Sakura contract set in `.env.devnet`. The [testnet release record](docs/TESTNET_RELEASE.md) tracks the planned clean-start release and its cut-over gates.

## What it does

- **Social**: up to 1,000-character posts on modern cuts with media, replies and threads, quotes, likes, reposts, follows, bookmarks, blocking (with shared block lists), @mentions and #hashtags, an explore page with trending tags and ranked posts.
- **Private feeds**: followers-only posts encrypted with XChaCha20-Poly1305, epoch-based key derivation, grant and revoke without re-uploading content. See `docs/YAPPR_PRIVATE_FEED_SPEC.md` and `/about/private-feeds`.
- **Direct messages**: end-to-end encrypted, on a separate contract.
- **Blogs (Beta for the release)**: long-form posts with a block editor, chunked on chain, embeddable in the feed.
- **Polls**: native polls on the Pollr contract, embedded in posts.
- **Storefront (Beta for the release)**: stores, items with variants, cart, checkout with shipping zones, encrypted orders, order status, reviews, encrypted saved addresses.
- **Payments**: payment-URI tips for Dash and other coins. Release YAPP is a non-transferable starter grant for sponsored social writes, not a purchasable currency.
- **Identity**: self-custodied keys and DPNS usernames. The release signs in through App Connect ([the protocol profile](docs/APP_CONNECT_PROFILE.md)), the wallet's recovery phrase (not on mainnet) or a private key; a passkey can sign a session back in ([passkey vault](docs/PASSKEY_VAULT.md)). Password backup and legacy wallet key exchange are retired at cut-over.

## Getting started

```bash
npm install
npm run dev          # http://localhost:3000
```

Everything the app needs is in the browser; there is nothing else to run. Contract ids and the network live in `lib/constants.ts` and can be overridden with `NEXT_PUBLIC_*` variables.

| Command | What it does |
|---------|--------------|
| `npm run build` | Production static export into `out/` |
| `npm run build:subpath` | The same, for a `/yappr` sub-path (GitHub Pages) |
| `npm run build:testing` | Export against the test contracts in `.env.testing` under `/testing` |
| `npm run build:devnet` | Export against `.env.devnet` under `/devnet` |
| `npm run contracts:snapshot` | Snapshot the network's deployed contracts into `lib/contracts/bundled/` (`NETWORK=devnet`, or `NETWORK=testnet CONTRACT_IDS=…`). The app seeds the SDK from the bundle on load and revalidates it in the background once the SDK supports it |
| `npm run lint` | ESLint over `app components contexts hooks lib types`; warnings fail |
| `npm run test` | Vitest specs next to the pure modules in `lib/` |
| `npm run lint:dead` | knip: unused files, exports and dependencies |
| `npm run test:e2e` | Playwright against the `/testing` export on real testnet (see `docs/TESTING.md`) |

CI runs lint, type check, unit tests, knip and the build on every pull request; the end-to-end suite runs when the secrets are present.

## How it is built

| | |
|---|---|
| Framework | Next.js 14 App Router, `output: 'export'`, no dynamic routes (query parameters instead) |
| Chain | `@dashevo/evo-sdk` + `@dashevo/wasm-sdk`, trusted mode, direct DAPI |
| Crypto | `@noble/hashes`, `@noble/ciphers`, `@noble/secp256k1` |
| UI | Tailwind, Radix primitives, Framer Motion, Heroicons, Zustand |
| Editor | BlockNote for blogs |

### Layout

```
app/            one folder per route; query params carry ids (/post?id=…)
components/     by feature: post, compose, profile, feed, store, blog, poll, auth, settings, layout, ui
hooks/          React hooks; the *-modal hooks are zustand stores built by lib/modal-store.ts
contexts/       auth (wraps the vendored platform-auth controller) and SDK readiness
lib/
  services/     singleton services per document type; all reads and writes go through here
  feed/         feed loaders and post resolution (quotes, reply parents, reposts)
  compose/      turning a draft thread into documents
  link-preview/ URL recognition, HTML meta parsing, proxied fetch
  crypto/       AES-GCM, ECDH, WIF, identity-key matching, HPKE (passkey vault)
  caches/       TtlMap and the status caches the hooks share
  stores/       app-wide zustand stores
  contract-topology.ts   which contract shape this build targets and what it allows
  constants.ts           contract ids and network
types/          domain types
contracts/      the deployed data contracts (JSON); older shapes are kept for reference
vendor/         platform-auth, the shared login controller
e2e/            Playwright: smoke (read-only) and write (needs E2E_SEED_PHRASE)
docs/           private-feed spec, App Connect profile, testing guide, deployment runbooks
```

### Contract topology

The planned release uses an App Connect anchor/group with social **v17**,
blocks, **DM v5**, **blog v9**, **storefront v10** and **pollr v8**. The
passkey-vault work package adds its own member. The release is a clean start:
no legacy contracts are registered and old data is not migrated.

The release set is registered on testnet (2026-10-21) and pinned in
`.env.testnet`, which `npm run build` uses for `/staging` and, after the
staging→master merge, for root. Until that merge, master's root still uses
**social v2**, **DM v3** and the old feature contracts. `/devnet` uses
**social v16**, **DM v5**, **blog v8**, **storefront v9** and **pollr v7** on
Sakura beta.6, with App Connect enabled. Those paths stay supported until the
legacy cleanup; authored contract JSONs are not a deployment record. See [the contract index](contracts/README.md),
[non-social features](docs/NON_SOCIAL_CONTRACTS.md) and
[cut-over deferrals](docs/RELEASE_CLEANUP.md).

`lib/contract-topology.ts` resolves schema capabilities for the selected build.
`/about` reports its configured topology, which the smoke suite checks.
[Historical designs and upgrade records](docs/archive/README.md) are archived;
the current devnet v16 and release v17 references remain in `docs/`.

### Documents

Ownership is the platform's `$ownerId`. A schema may also require a target's owner, such as `like.postAuthor`, bound by a `refersTo.where` rule on modern cuts. Notifications are derived client-side from other documents, not stored. Deletes are tombstones where the shape makes posts permanent.

### Writes

`lib/services/state-transition-service.ts` signs and broadcasts every write. DAPI's confirmation wait often times out even when the transition landed, so the app treats a successful broadcast as success, records the document as unconfirmed, and settles that record before anything references it (`lib/unconfirmed-writes.ts`).

### Storage in the browser

A typed-in private key lives in local storage under the `yappr_secure_` prefix (a CRITICAL key typed in on an App Connect build stays in the tab only); a wallet sign-in's keys live in an AES-GCM-wrapped key ring in IndexedDB (`lib/app-connect/key-ring-store.ts`). Session metadata and preferences are in local storage. Every sub-path build (`/testing`, `/devnet`, `/staging`) prefixes its keys with its own scope so deployments sharing an origin never read each other's sessions (`lib/storage-scope.ts`). `/cookies` describes this to users.

## Contributing

Run `npm run lint`, `npm run test`, `npm run lint:dead` and `npm run build` before opening a pull request; CI enforces all four. Pure modules under `lib/` get a Vitest spec beside them. Anything that needs the SDK or a browser belongs in `e2e/`. See `CLAUDE.md` for the conventions the codebase follows.

## License

MIT
