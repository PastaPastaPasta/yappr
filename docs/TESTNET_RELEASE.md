# Yappr testnet release record

This is the committed record of Yappr's first true release on Dash testnet. It holds the goal, the owner's decisions, the ordered plan, the go/no-go checklist, the rollback and key-compromise outlines, and the issues that gate the release. It is a living document: later work packages append registration results (contract ids, hashes, fees) and runbook detail here or in the files it links.

- Written: 2026-10-16, against staging `4f8306f9` and Platform `5.0.0-rc.3` (protocol version 14).
- Conventions: **D-numbers** are the owner's release decisions (section 2). **R-numbers** are backlog items from the pre-release audit. Neither is related to the D-numbers in `docs/mobile/` (those are older, mobile-only decisions).
- **[O]** marks a step only the owner can do or approve. **[A]** marks work an agent does.
- **Monitoring and incident response:** [MONITORING.md](MONITORING.md) describes the scheduled site/chain probes, thresholds, incident issues, and recurring operator tasks. Production-chain coverage stays pending until `.env.testnet` contains the registered release IDs.

## 1. Goal and scope

**Goal.** Release Yappr properly on Dash testnet, with testnet treated as production. Every contract Yappr needs is registered once, as a single frozen set, and the web app (and the mobile betas) are pinned to it.

**Scope.**

- **Branches.** `staging` is merged into `master` with a merge commit (never squash or rebase). `master` is already a strict ancestor of `staging`, so the merge itself is mechanical. `yap.pr/` is the master build, and `yap.pr/staging/` is the staging build; both run against the same production (testnet) contracts. `/testing` and `/devnet` keep their own contract sets.
- **No backwards compatibility.** Today's master and its testnet contracts and data are not migrated. Nothing from them is read, linked, or announced to users. Pre-mainnet, we design the data model properly and carry no legacy shims.
- **Platform.** The release runs on Platform `5.0.0-rc.3` and moves to `5.0.0` final when that is published.
- **Archives.** The versioned Cloudflare Pages mirrors (`yappr-v2.pages.dev`, `yappr-v2.thepasta.org`, and any v1, v3, and so on) stay forever as archives of earlier Yappr. They run on their old contracts and SDKs and are left untouched.
  - Today's production commit `f42ce65` is tagged `legacy-testnet-f42ce65` before the merge, and the owner creates its own archive project from that tag (for example `yappr-v3.pages.dev`), built with its original settings. The tag doubles as the rollback target.
  - The main mirror `yappr` (`yappr.pages.dev`) must always serve exactly what `yap.pr` serves: master, with the release configuration.
- **Hosting (checked 2026-10-16).** `yap.pr` is GitHub Pages content behind Cloudflare DNS and proxy. The versioned mirrors are Cloudflare Pages projects.

## 2. Decisions

All decisions are the owner's, made on 2026-10-16. Where an item says "taken as recommended", it was a must-fix with no real alternative, and the owner can still object.

### 2.1 Contract shape (frozen at registration)

Once a contract is registered, the shape of its existing document types cannot change. Updates are owner-only and additive.

- **D1, moderation interim and election windows.** Social, blog and storefront register with the interim set to `notYetUsable`, the same mechanics as mainnet. Nobody can post or claim the moderation pot until an elected team is seated.
  - Testnet uses its own election windows: join 3600 s and vote 3600 s. This is not mainnet-legal; mainnet needs at least 86400 s for each, so the testnet files carry their own window values.
  - Yappr's charters for social, blog and storefront are filed in the block right after registration, and the owner's testnet masternodes vote. Posting opens about two hours after registration.
- **D3, YAPP authorities.** Manual mint, manual burn, freeze, unfreeze and destroy-frozen-funds are all set to `noOne`. YAPP supply comes only from the 100-YAPP once-per-identity claim. YAPP is non-transferable and bans already stop spending, so the owner needs none of these powers. The "Mainnet TODO" line at `lib/constants.ts:24` is removed if it concerns this.
- **D4, sponsorship.** Unchanged: post, reply, like and like-reply cost 10, 3, 1 and 1 YAPP with gas paid by the contract owner, and no size changes are made for this purpose. Storage refunds going to the document owner is by design in rc.3. Exposure is bounded at roughly 74 to 132¢ per identity because the 100-YAPP grant cannot be topped up. The maker balance is monitored.
- **D5, settled deletion.** Post and reply keep `leader: true, approvals: 3`. Yappr's charters always elect the leader plus at least two members, so three approvals is reachable.
- **D6, self-likes.** Blocked on chain: `like.postAuthor` gets `distinctFrom: $ownerId` (and the equivalent on like-reply if it carries an author). The like button is hidden on your own posts.
- **D7, tags.** The ASCII pattern `^[a-z0-9_]{1,61}$` stays. The client is fixed so a tag with non-ASCII characters stays plain text instead of being indexed as a truncated ASCII prefix.
- **D10, auth vault.** The current password-era vault does not go into the set. It is replaced by a new design, likely passkey-only, registered as a member of the App Connect group in the release set. The work runs in order: a dual design by Fable and Opus, a crypto review, then implementation. Password login is removed, and passkey sign-in returns with the new vault.
- **D11, reviews.** Status quo. Any order lets the buyer review the store and its items. Lying or spam reviews are handled by storefront moderation, since `storeReview` and `itemReview` are moderated types. This depends on the storefront moderation UI (R-M24).
- **D12, report box.** The broad scope stays: a report shares the feed's generation key, so a report lets moderators read that feed's earlier posts. This is disclosed plainly in Privacy and in private-feed setup.
- **D13, bookmarks.** Bookmarks stay public on chain. They are disclosed with one quiet, well-designed line (for example in the bookmark confirmation or on the Bookmarks page), not with warning banners. The owner's brief: do not make the UX look bad.
- **D14, media URLs (contract).** Post and reply `mediaUrls`, `bannerUri`, and the storefront and blog image fields allow only `^(https|ipfs)://.+$`. Plain http is dropped. The website link becomes https-only.
- **D14b, media URLs (app).** The app never loads arbitrary https media directly. Https media is shown through the public proxy wsrv.nl (images.weserv.nl). IPFS keeps using the gateway list. The same treatment applies to remote avatars, banners, and storefront and blog images, with a graceful fallback if wsrv is down. wsrv.nl is disclosed in the privacy page's third-party list.
- **D15, poll indexes.** Both `byCreatedAt` and `ownerAndTime` are dropped from pollr. Polls are reachable only through the posts that embed them. The `POLLR_APP_*` settings are retired unless the standalone Pollr app moves to this contract.
- **D16, store notifications.** `orderStatusUpdate.buyerFeed` stays, and issue #575 is built for the release. Sellers are notified of new orders and new reviews, and buyers are notified of status changes.
- **D17, follow indexes.** The current v16 shape stays: a unique pair index, `following [$ownerId, $createdAt]` rangeCountable, and followers. The owner does not want client-side paging. A sakura experiment (a throwaway contract) showed that merging the pair and following indexes works and is 21% cheaper to create, but it gives up the time-ordered "who X follows" list, so it was rejected.
- **D18, storeItem index.** Add `[storeId, status, $createdAt]` (+15 B). There is no cross-store discovery index now; a later document type can add one.
- **D19, storefront JSON fields.** No contract change; `contactMethods`, `postalPatterns`, `tiers` and `paymentUris` all stay JSON text. The app filters `paymentUris` on read against an allowed-scheme list and rebuilds the scheme and label from the URI itself. It also validates `contactMethods`, `postalPatterns` and `tiers`. The read-side payment filter is a must-have (R-M4).
- **D32, private feed grants.** The `recipient` index `[$ownerId, recipientId]` is replaced by a single unique `[recipientId, $ownerId]` index (the owner's idea), and the `leaf` index `[$ownerId, leafIndex]` stays unique. The owner's point lookups still resolve and the owner-side list uses `leaf`. This also enables "feeds I can read" on any device and approval notifications by diffing that list. Comments and queries that name the old index are updated.
- **D33, read-only members.** Not used. Contracts stay updatable; updates are owner-only and additive, and clients pin `id:version`.
- **R-M5, private feeds.** The direction: **multiple write-once private feeds per identity.** A new feed is opened for key rotation, compromise or full caps. Revocation within a feed stays a tree rekey. At launch there is one audience, so feeds are successive generations of "your private feed". The frozen shape must allow parallel audiences later without a re-cut. The detailed design is **pending owner review**: it lives outside the repository and is summarised only here. In short, a feed is identified by the owner and a per-owner counter, grants and rekeys bind to their feed on chain, caps come from stored values rather than client constants (R-M30), and an optional audience number ships now but launch never writes it. The design is brought back to the owner before the cut.
- **Taken as recommended (owner can object):**
  - A `live` marker on `post.timeline` and `post.tagAndTime` (R-M1), on the reply index (R-S1), and on the blog post timeline with a required `publishedAt` (R-S2). Without it, deleted posts keep flooding Recent, For You, tag pages and search.
  - The quote-owner rule is replaced by a count-present rule so a post cannot carry a quoted owner without a quote (R-M2).
  - No plaintext tracking number or message on order status updates; they move to an encrypted payload (R-M3).
  - Size limits on free-text fields (R-S3).
  - Registration is gated on elected moderation being proven on the final grammar (R-M7), and private-feed caps come from stored values (R-M30).

### 2.2 Operations, SDK and hosting

- **D2, production maker.** The production maker is the existing testnet identity `hbGEc…`, which owns the old contracts. Follow-ups: move its key out of `~/Downloads` into a 0600 file, top it up to cover roughly 263e9 credits for registration (about 15,800¢ at the $60/DASH reference; it held about 101e9 at audit time) plus a sponsorship float, and make the registration tooling sign from an explicit key source (R-M9).
- **D20, `/staging`.** Unchanged. `/` is the master branch and `/staging` is the staging branch, both against the production (testnet) contracts on the same `yap.pr` origin, which was accepted on 2026-10-06. The staging build uses the same `.env.testnet`.
- **D29, Cloudflare Pages.** The versioned mirrors stay as permanent archives and must not be deleted or have their environment changed. The main mirror `yappr` always serves exactly what `yap.pr` serves.
- **Archive of today's production.** Before the merge, tag `f42ce65` as `legacy-testnet-f42ce65`; the owner creates a Pages archive project pinned to it. This replaces the older "rollback tag only" plan.
- **D30, SDK.** `evo-sdk`, `wasm-sdk` and `wasm-dpp2` are bumped to `5.0.0-rc.3` together before registration, and to `5.0.0` final when it is published.
- **D31, where rc.3 batteries run.** On the testnet `/testing` contract set (Phase 3), which doubles as the rc.3 rehearsal. Sakura stays on beta.6.
- **Backlog items R-M9 to R-M36** go ahead as written in the audit backlog, adjusted by the decisions in this document.

### 2.3 Launch shape

- **D8, day-one sign-in.** Soft launch on the App Connect build. Newcomers onboard through the bridge plus a raw key, and the wallet QR is relabelled or demoted because no released wallet speaks App Connect v2 yet. The public announcement waits until a DashPay TestFlight or internal build signs in on testnet against the production anchor.
- **D9, legacy contracts.** None of key exchange, the old vault, key backup or DM v4 is registered. Their ids are blanked in the release environment and the legacy code paths are deleted.
- **D21/D22, migration.** Clean start with no notice. Browser storage starts clean under a new root scope, and old sessions and caches are ignored. There is no in-app notice on the old site, and no legacy link or archive link (`LegacyYapprLink` is dropped). The "Data may be reset" banner becomes a small Testnet pill (an audit recommendation the owner did not separately confirm).
- **D23, product flags.** Social, DM v5 and polls are fully released. Store and Blog carry a Beta pill. Credit tips are hidden until wallets can send them; payment-URI tips stay.
- **D24, uploads.** Bring-your-own Storacha or Pinata as-is for launch. Follow-up: model a Yappr-run bucket on R2 (paid by users or provided free). That needs costs, an abuse and takedown model, and an upload-authorisation path, and presigned uploads need a Worker, which is in tension with the "no backend" rule. Media from our own domain would not need the wsrv proxy (D14b).
- **D25, telemetry.** The Cloudflare Web Analytics beacon stays and is disclosed in Privacy and Cookies. No error reporting is added.
- **D26, mobile.** TestFlight and Play internal-testing betas of the testnet variant ship together with the web launch. That pulls into the release: the owner's Apple and Play organisation accounts and Team ID, the testnet engine environment (R-B1), mobile QA on testnet, rebuilds with the release contract pins, and `mobile-release` environment protection. The public store listing comes later.
- **D27, trust root.** The DCG quorum service is accepted silently for this release. No disclosure, and a second source is not required now.
- **D28, onboarding ops.** The bridge and faucet stay as they are. The roughly 200 tDASH per day budget is accepted.

### 2.4 Release gate

- **D34, issue gate.** The owner delegated the call to the agent's judgment. See section 5.

## 3. Release plan

Every PR goes to `staging` through the normal gates (lint, unit tests, build, dead-code, and a code review for complex changes). Production builds only come from `master`. **Nothing is broadcast for the production maker or the production contract set before Phase 4.** The only testnet writes allowed earlier are the Phase 3 rehearsal, which uses its own dedicated test maker and isolated `/testing` contracts. Write batteries never run against the production set. Read-only testnet queries are fine at any time. WP numbers refer to the audit's work packages.

### Phase 0: Decisions [done, except two items]

- The decisions in section 2 are recorded here (this document is gate G0).
- Still pending: the owner's review of the private-feed design (R-M5) before the cut.
- Still to be named by the owner: the leader and members of each charter. The mobile compliance docs say Yappr staff do not stand for a charter, so candidates must be recruited and funded (R-M13) before Phase 4.
- The auth vault redesign (D10) is not a decision but a work item, and it must finish before registration because the new vault is a frozen group member.

**Gate G0.** The contract-cut PR cites every decision above.

### Phase 1: Code on staging [A, parallel]

- **Registration tooling (WP1).**
  - An explicit publisher key source that fails closed and refuses group- or world-readable key files.
  - `--interim` required off devnet and recorded in the journal.
  - A balance check before signing.
  - `NETWORK` required, plus `--production` for maker-signed writes off devnet.
  - A mode-0600 journal.
  - The v2-era scripts are deleted or devnet-gated.
- **SDK bump (WP2).** rc.3 across all three packages, matchers re-checked, mobile licenses regenerated.
- **Contract cut (WP3).** The decided shape: social v17, storefront v10, blog v9, pollr v8 and DM v5, with the new vault in the App Connect set and the old one removed. SHA-256 values re-pinned, topology descriptors added, a query-to-index conformance spec added.
  - Done: [SOCIAL_V17.md](SOCIAL_V17.md), [STOREFRONT_V10.md](STOREFRONT_V10.md), and the blog v9 and pollr v8 sections of [NON_SOCIAL_CONTRACTS.md](NON_SOCIAL_CONTRACTS.md). Signed creates: social 18,019 B, storefront 18,704 B, blog 8,852 B, pollr 3,568 B. A throwaway copy of each was registered and probed on sakura (153/153 cases as expected). The `authVault` is out of the set; the passkey vault joins in its own PR.
- **Client (WP4).** Live-marker pins everywhere, new fields, private-feed caps from stored state, hidden self-like button, no plaintext tracking in the seller form, read-side payment filter.
- **Auth vault redesign (D10).** Dual design, crypto review, then implementation.
- **In parallel.** Auth hardening (password login removed, #616, #740, #738), safety and privacy fixes (blocks in notifications, EXIF stripping, link-preview proxies removed, media denylist, wsrv proxy, tip tab hidden, Beta pills), storefront and blog moderation UI, write-path reliability (#644), legal and user-facing copy, CI and deploy hardening, e2e on the release topology, store notifications (#575).
- **Mobile.** Testnet engine environment, mobile QA plan, and release-pin rebuild plan (D26).

**Gate G1.**
- The offline contract validator passes on every set file with the testnet network, strict size, probes and constraints, on rc.3.
- The registration tool's `--plan` and `--dry-run` pass with the chosen maker.
- Unit, build and devnet e2e are green.

### Phase 2: Sakura rehearsal [A]

- Register the cut on sakura from a throwaway maker or nonce and run the full battery set.
- Prove the new query shapes live: a deleted post leaves the timeline and the tag page, a moderator restore re-enters, and the live-marker queries are accepted.
- Wait for the sakura election seating (about 2026-10-20 14:53Z) and run battery r2: settled deletion with approvals, report resolution, pot payout.
- Rehearse scripted charter filing for social, blog and storefront for the block after registration, with a proved readback.

**Gate G2.** Batteries green or every failure explained in writing, r2 green, query shapes proven. If anything misbehaves, re-cut now. Sakura runs beta.6, so this does not validate rc.3 server behaviour; Phase 3 does.

### Phase 3: Testnet `/testing` set, the rc.3 rehearsal [O funds, A registers]

1. [O] Fund a dedicated test maker. It must not be the production maker, and its key must not be derivable from the production seed. About 3 tDASH from the faucet.
2. [A] Register the full release set (no legacy contracts) with `--plan`, `--dry-run`, `--signed-dry-run`, then `--live --journal`, using the test maker, the same pinned files, and the same interim and window values as production.
3. [A] Provision at least nine e2e pool slots (names, messaging keys, starter grants) and raise the minimum balance.
4. [A] Rewrite `.env.testing` with every id, topology and App Connect pin, with no fallbacks.
5. [A] Run the write batteries and the full Playwright smoke and write projects against it on rc.3, including the App Connect login responder. Measure live fees and size the sponsorship float. Mobile QA runs against this set too.

**Gate G3.** Batteries and e2e green on rc.3, fees recorded with ¢ figures, and `verify-appconnect --only g1,g2,g3,a1` reports 32/0.

### Phase 4: Production registration on testnet [O approves and signs, A drives]

1. [O] Prepare the maker `hbGEc…` (D2): move the key to a 0600 file outside `~/Downloads`, top up the balance to cover registration plus the sponsorship float, make two encrypted backups, and name the holders. Make every identity key change **before** the plan, because key changes consume identity nonces.
2. [A] Run read-only checks: the proved protocol version is 14, system contracts are present (App Connect anchor, DPNS, DashPay v2, token history, charters), and the maker's balance and nonce are as expected.
3. [A] Run `--plan` and record the app id and group id. **Start the maker nonce freeze.** [O] Send the app id and `https://yap.pr` to the DashPay iOS and Android brand maps.
4. [A] Run `--dry-run` then `--signed-dry-run`. Check that the interim, windows, app id, group id and member ids match the plan.
5. [O/A] Run `--live --journal --upto app`, read back the group (owner is the maker, no admins, name Yappr), then `--live` for the members.
6. [A/O] **Immediately after registration**, file each Yappr charter in the next block with a proved readback, for social, blog and storefront. Then watch for rival contenders. The first charter filed wins ties and seats are permanent on protocol 14. The owner's testnet masternodes vote. Posting opens about two hours later (1 h join plus 1 h vote).
7. [A] Run read-only `verify-appconnect g1,g2,g3,a1` (expect 32/0) and one proved query per index family. Snapshot the contracts and end the nonce freeze. [O] Write the anchor `appInfo` (name Yappr, url `https://yap.pr`).

**Gate G4.** All ids and hashes recorded in the runbook, charters seated, the journal at mode 0600 with an off-machine backup.

### Phase 5: Cut-over configuration PR on staging [A]

- A checked-in `.env.testnet` (ids are public) sourced by the `build` script itself, so every bare `npm run build` call site inherits it.
- A fail-closed check in `next.config.js`: on testnet or mainnet the build fails if any required id, topology, login protocol, token authority or App Connect pin is unset. The testnet fallbacks are removed from `lib/constants.ts`, and `dev` sources an explicit env file.
- The mobile engine's testnet variant and the contract snapshot tool read `.env.testnet`; the bundled snapshot is regenerated and pruned.
- A new root storage scope (D21), the `/staging` target (D20), and the docs (this document's results, `CLAUDE.md`, README, contracts README, `TESTING.md`, a new `TESTNET_DEPLOY.md`, stale PV13 comments).
- Alongside it, CI and deploy hardening: devnet e2e only on pull requests, a `production_ref` dispatch input, staging-triggered production builds use the last CI-green master commit, and an `npm audit` step.

**Gate G5.** CI is green on staging. A local `.env.testnet` build served locally shows the release ids and topology on `/about`, and the bundle contains the app id and social id. A `/testing` build is green against the new set. Note that `/staging` and `/devnet` redeploy as soon as this PR lands.

### Phase 6: Repository and hosting settings before the merge [O]

- Tag `f42ce65` as `legacy-testnet-f42ce65`, and create the Pages archive project from it (section 1).
- Master ruleset: required checks (Lint, Type Check, Unit Tests, Build, Dead Code, Browser Component Tests, End-to-End) and merge commits only.
- Create the `mobile-release` environment with a protected-branch policy before adding any signing secrets.
- Check that the `yappr` Pages project builds master and will serve the same build as `yap.pr`. Do not touch the versioned mirrors.
- Cloudflare response headers, scoped by path: `frame-ancestors 'none'` and `X-Frame-Options: DENY` everywhere except `/embed/*`, which stays frameable. HSTS and Referrer-Policy site-wide. The analytics beacon stays (D25).
- Mobile: Apple and Play organisation accounts, Team ID, and signing secrets (D26).

**Gate G6.** The go/no-go checklist in section 4 is signed by the owner.

### Phase 7: Merge and deploy [O merges, A verifies]

1. Open the PR from `staging` at the frozen commit into `master`. Wait for every check, including testnet End-to-End against the new `/testing` set. Merge with **Create a merge commit**.
2. Confirm the deploy workflow actually ran after the merge's CI. If CI ended `cancelled`, dispatch it by hand. Purge the Cloudflare cache, because HTML is cached for 600 s.
3. Verify:
   - the build id equals the merge short sha on `/`, on `/testing`, and on `yappr.pages.dev`;
   - `/about` shows the release ids;
   - the bundle contains no id of the old social contract (`9oDC6xdg…`);
   - the Playwright smoke passes against `https://yap.pr`, and the write e2e passes on `/testing`.
4. Manual pass on Chrome, Firefox, Safari and iOS Safari, with one fresh browser and one holding an old master session (which must start clean):
   - bridge, then identity and username, then raw-key login;
   - messaging setup;
   - post with 0, 1 and 4 tags, media, reply, quote, repost, like and delete;
   - hashtag, Explore, follow, block, and notifications;
   - DM v5 one-to-one and group;
   - private feed approve and revoke;
   - report;
   - starter claim exactly once;
   - store, item, checkout, status, review;
   - blog post and comment;
   - poll vote;
   - fees shown in ¢.
5. Tag `v1.0.0-testnet` and bump `package.json` to 1.0.0.

### Phase 8: Go-live and after [O, with A]

- **Soft launch** immediately (D8): the App Connect build with raw-key onboarding and the wallet QR relabelled. The mobile TestFlight and Play internal betas go out with it (D26).
- **Public announcement** only once a DashPay build (TestFlight or internal at least) completes App Connect v2 sign-in, renewal and revoke on testnet against the production anchor. The wallet must be on a platform build at rc.1 or later, because the Core V24 activation on testnet is pending and beta-era wallets break when it activates.
- [A] Scheduled monitoring every 30 to 60 minutes: a smoke test against `yap.pr`, a chain probe of contract ids and hashes, DAPI and quorum health, maker and pot balances, rival charter contenders, and post and report rate. Failures open a GitHub incident issue.
- Recurring work: watch the charter seats, pot claims by the seated teams, App Connect 90-day renewals, and every contract update following the same choreography (update, `id:version` pin, web deploy, mobile rebuild). The testnet update tool must exist before the first update.
- After release: the "after release" issues in section 5, the Yappr-run upload bucket (D24), the public store listing, and account deletion before that listing.

## 4. Go/no-go checklist

The owner signs this before Phase 7. Every line is yes or no.

**Contracts and registration**
- [ ] The full set is registered on testnet from `hbGEc…`, the journal is mode 0600 and backed up off the machine, and all ids and hashes are in the runbook.
- [ ] The registered files match the pinned SHA-256 values, with the testnet window values (3600 s and 3600 s), and `verify-appconnect g1,g2,g3,a1` reports 32/0.
- [ ] Charters for social, blog and storefront are seated, with no rival contender, and posting works.
- [ ] No legacy contract (key exchange, old vault, key backup, DM v4) is registered or referenced.
- [ ] The private-feed design has been reviewed by the owner (R-M5), and the new auth vault has passed its crypto review (D10).
- [ ] The maker balance covers registration reserve plus sponsorship float, and its alert is live.

**Build and config**
- [ ] `.env.testnet` is committed and sourced by `build`, the fail-closed check passes, and the master bundle carries no old ids.
- [ ] The SDK is on `5.0.0-rc.3` (or final) in all three packages.
- [ ] CI is green on staging, and `/testing` e2e is green against the new set on rc.3.
- [ ] The gate issues in section 5 are closed.

**Hosting and repository**
- [ ] The `legacy-testnet-f42ce65` tag and its Pages archive project exist and load.
- [ ] The master ruleset has its required checks and merge-commit-only.
- [ ] Anti-framing, HSTS and Referrer-Policy headers are live, with `/embed/*` still frameable.
- [ ] `yappr.pages.dev` builds master and will match `yap.pr`. The versioned mirrors are untouched.
- [ ] The `mobile-release` environment is protected.

**Product and legal**
- [ ] Terms, Privacy and Cookies are rewritten and linked from the footer, the mobile menu and sign-in. They disclose the analytics beacon, wsrv.nl, public bookmarks, the report-box scope, moderation and key storage. The DCG quorum service is deliberately not disclosed in this release (D27).
- [ ] Password login is gone, and a fresh user can sign in with a raw key after onboarding through the bridge.
- [ ] A static media denylist exists, and there is a takedown contact and runbook.
- [ ] Credit tips are hidden, Store and Blog carry Beta pills, and the Testnet pill replaces the data-reset banner.

**Mobile (D26)**
- [ ] TestFlight and Play internal builds of the testnet variant are QA'd on testnet, rebuilt with the release pins, and ready to upload with the web launch.

**Not required for the soft launch**
- A released wallet that speaks App Connect v2 (needed for the public announcement only).

## 5. Rollback

Choose by severity. All options assume the `legacy-testnet-f42ce65` tag and archive project exist.

1. **Broken release, no user writes yet.** Redeploy the old build: dispatch the deploy workflow with `production_ref=legacy-testnet-f42ce65`, then purge the Cloudflare cache. Takes minutes. The same applies to `yappr.pages.dev`.
2. **Code regression after users have written.** Fix forward with a hotfix PR to master (about 10 minutes plus 600 s of cache). The pinned-to-last-green deploy logic stops a staging push from shipping an untested master. Do not roll back to the legacy build once users hold data on the new contracts.
3. **Wrong configuration.** The configuration is checked in, so fix it in a PR to master. If the build is unusable, use option 1 before any user has written, otherwise fix forward.
4. **Contract-shape defect.** It cannot be rolled back. Cut a new version, register it under a new id, switch the environment, rebuild mobile, and announce. Group membership is append-only, so a bad member is never removed; it is only unpinned in clients.
5. **Last resort.** `git revert -m 1` of the merge commit. It also reverts the environment files and goes back through the e2e gate, so prefer 1 to 4.
6. **Mobile.** The betas are internal-only. Pull the build from the track, fix, and rebuild, since clients pin `id:version`.

## 6. Key-compromise outline

The root of trust is the maker identity `hbGEc…`. It owns every contract, owns the App Connect group, pays the sponsored gas, and its balance funds registration and updates.

**What a leaked maker key could do.**
- Grow the App Connect group and publish contract updates. Updates are owner-only and additive, so existing document types cannot be changed, but new types can be added.
- Drain the balance, which stops sponsored posting and likes.
- It cannot mint, freeze, burn or destroy YAPP (D3 sets all of those to `noOne`), cannot claim the moderation pot (only a seated team can), and cannot change a registered contract's existing shape.

**Prevention.** Key file mode 0600 outside `~/Downloads`, signing only from an explicit key source, two encrypted backups with named holders, and a dedicated signing machine for owner-level keys.

**Response.**
1. **Detect.** The monitoring probes alert on a balance drop, an unexpected contract version, or an unexpected new group member.
2. **Contain.** Freeze deploys that depend on the maker. Where the identity's key hierarchy allows it, disable the leaked key with a higher-authority key and add a replacement. Move any remaining funds.
3. **Assess.** Read the journal and chain history to list every update, member and transfer made with the key.
4. **Recover.** Clients pin `id:version`, so an unexpected update does not reach users automatically. Ship a client release that unpins the affected members if needed. If the identity can no longer be trusted, re-cut under a new maker (new ids, a new environment, a mobile rebuild) and notify users.
5. **Review.** Write up the incident and update this runbook.

## 7. Release gate issues (D34)

**Gate the release on:**
- #644: a lost write answer locks out all writes to that contract for 15 minutes.
- #616: key sign-in accepts a private key for a disabled identity key.
- #740: the starter YAPP claim is offered to an identity that already claimed it, and users are charged on every second device.
- #734: App Connect session establishment must be bound to the adopted grant.
- #738: a renewal racing the start-up check leaves the sign-in modal open.
- #575: storefront order, status and review notifications.

**Fix as part of the release work:**
- #672: an author's self-thread breaks when they later reply to the root post.
- #608: contested-username ordering never applies because of an uninitialised WASM instance.
- #708: a mobile empty DM group shows a fresh timestamp and jumps to the top of the inbox.
- #720: storefront CSV round-trip edge cases (currency, item SKU, combination images).

**Fix if mobile beta QA shows them in normal use:**
- #759: mobile App Connect cancel or accept should wait for the stored request's deletion.
- #761: mobile should resume App Connect requests after a cold start.
- #762: mobile should reconcile an App Connect cancel or accept cut short by an engine restart.

**Close as obsolete when their code is removed:**
- #739: first-time legacy wallet sign-in loses its session on reload.
- #612: legacy dash-st key-registration payload is untagged.
- #741: the legacy DM list with a blank id and an image path without the base path.
- #261: the old SDK v3.1 migration chore.
- Re-check #564 (hand-built document create path) on rc.3.

**After release:**
- #604: release nonce reservations on proof rather than browser time.
- #705: remaining pollr delete-eligibility evidence gaps.
- #709, #710, #711: mobile test handle, hardware-keyboard posting, and lost Android keystrokes after Send.
- #732: keep raw-key sign-in when another tab stores a newer wallet grant.
- #736: serialise renewal adoption against wallet-revoke sign-out.
- #755: mobile Universal Links and App Links for the App Connect return.
