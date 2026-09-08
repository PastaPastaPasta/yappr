# Yappr

A decentralized social network and marketplace on Dash Platform. Posts, profiles, likes, follows, bookmarks, direct messages, private feeds, blogs, polls, stores and orders are all documents on chain, owned by the identity that wrote them. There is no server: the site is a static export that talks to Dash Platform directly from the browser.

<img src="public/yappr.png" alt="Yappr" width="200">

Live at [yap.pr](https://yap.pr). A second copy at [yap.pr/testing](https://yap.pr/testing/) runs the same code against dedicated test contracts and is what the end-to-end suite drives; [yap.pr/devnet](https://yap.pr/devnet/) tracks the newest contract shape.

## What it does

- **Social**: 500-character posts with media, replies and threads, quotes, likes, reposts, follows, bookmarks, blocking (with shared block lists), @mentions and #hashtags, an explore page with trending tags and ranked posts.
- **Private feeds**: followers-only posts encrypted with XChaCha20-Poly1305, epoch-based key derivation, grant and revoke without re-uploading content. See `docs/YAPPR_PRIVATE_FEED_SPEC.md` and `/about/private-feeds`.
- **Direct messages**: end-to-end encrypted, on a separate contract.
- **Blogs**: long-form posts with a block editor, chunked on chain, embeddable in the feed.
- **Polls**: native polls on the Pollr contract, embedded in posts.
- **Storefront**: stores, items with variants, cart, checkout with shipping zones, encrypted orders, order status, reviews, encrypted saved addresses.
- **Payments**: tips by QR code, payment URIs for Dash and other coins, YAPP token purchases that pay for writes.
- **Identity**: self-custodied keys, DPNS usernames, optional password-encrypted on-chain key backup, passkey unlock, wallet sign-in through key exchange.

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
  crypto/       AES-GCM, ECDH, WIF, identity-key matching, vault
  caches/       TtlMap and the status caches the hooks share
  stores/       app-wide zustand stores
  contract-topology.ts   which contract shape this build targets and what it allows
  constants.ts           contract ids and network
types/          domain types
contracts/      the deployed data contracts (JSON); older shapes are kept for reference
vendor/         platform-auth, the shared login controller
e2e/            Playwright: smoke (read-only) and write (needs E2E_SEED_PHRASE)
docs/           private-feed spec, testing guide, deployment runbooks
```

### Contract topology

The social contract has been re-cut several times as Platform gained features (v2 on testnet and production; v5 and v6 on devnet with proved rankings and a beat doctype). `lib/contract-topology.ts` answers questions like "can a reply be reposted here" and "is the hashtag inline on the post", and everything that differs between shapes dispatches on it rather than on a version string. `/about` prints the topology a build was compiled with; the e2e suite checks it.

### Documents

Ownership is the platform's `$ownerId`; documents never carry their own author field. Notifications are derived client-side from other documents, not stored. Deletes are tombstones where the shape makes posts permanent.

### Writes

`lib/services/state-transition-service.ts` signs and broadcasts every write. DAPI's confirmation wait often times out even when the transition landed, so the app treats a successful broadcast as success, records the document as unconfirmed, and settles that record before anything references it (`lib/unconfirmed-writes.ts`).

### Storage in the browser

The private key lives in session storage for the tab; session metadata and preferences in local storage. Every sub-path build (`/testing`, `/devnet`, `/staging`) prefixes its keys with its own scope so deployments sharing an origin never read each other's sessions (`lib/storage-scope.ts`). `/cookies` describes this to users.

## Contributing

Run `npm run lint`, `npm run test`, `npm run lint:dead` and `npm run build` before opening a pull request; CI enforces all four. Pure modules under `lib/` get a Vitest spec beside them. Anything that needs the SDK or a browser belongs in `e2e/`. See `CLAUDE.md` for the conventions the codebase follows.

## License

MIT
