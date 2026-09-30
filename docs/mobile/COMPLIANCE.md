# Store and policy compliance

These are the requirements for getting through App Review and Google Play
review. Sources are the App Store Review Guidelines (last updated
2026-06-08), Play Policy Center pages, and platform documentation, checked
2026-09-27 and re-checked 2026-09-30. Items marked **[verify]** come from
secondary sources or reports of rejections, and should be checked again before
submission.

## Summary checklist (release blockers)

| # | Requirement | iOS | Play | Owner | Phase |
| --- | --- | --- | --- | --- | --- |
| C1 | Organization developer accounts (legal entity, D-U-N-S), held by the Dash-affiliated publisher (D12); Play developer verification of the package (in force since 2026-09-30) | 3.1.5(i), 5.1.1(ix) | Crypto wallet declaration, developer verification, and it avoids the new-personal-account 12-tester/14-day rule | Product owner | 0 |
| C2 | No crypto-gated functionality and no crypto paid to the developer to unlock features on iOS: YAPP is never required, and the **action fees go only to elected moderators** (D5) | 3.1.1 | Tokenized-asset declaration, Billing policy | Yappr contracts (Y1/Y2) plus mobile | 0 decision, 3 verify |
| C3 | No tips attached to posts on iOS; profile tips only, optional, 100% to recipient | 3.1.1, 3.2.1(vii) | OK (P2P exception) | Mobile | 1 |
| C4 | UGC safeguards: report (posts, replies, profiles, DMs), block, filter, EULA, contact, acting on reports within 24 h | 1.2 | UGC policy | Yappr (Y1, Y7) plus mobile plus moderation ops | 1 to 3 |
| C5 | Account deletion in the app, plus a web URL | 5.1.1(v) | Account deletion policy | Yappr (Y7) plus mobile | 2 |
| C6 | Non-custodial only; no exchange features | 3.1.5 | Out of scope of the crypto wallet licensing policy if non-custodial | Architecture (by design) | — |
| C7 | Age rating questionnaire incl. social-media questions (answers required from September 2026); Declared Age Range API (Texas SB 2420) | Required | Content rating (IARC) | Mobile plus product owner | 3 |
| C8 | Export compliance: `ITSAppUsesNonExemptEncryption=YES`; French declaration or exclude France at launch | Required | n/a | Product owner | 3 |
| C9 | Privacy: `PrivacyInfo.xcprivacy`, nutrition labels; Play Data safety, Financial features declaration | Required | Required | Mobile | 3 |
| C10 | Not a thin web wrapper; OTA updates never change features | 4.2, 2.5.2 | — | Architecture (native UI) | — |
| C11 | Toolchain: Xcode 26 / iOS 26 SDK; Android targetSdk 36 | Required since 2026-04-28 | Required since 2026-08-31 | Mobile | 1 |

## Crypto, fees and tipping

### Constraints from the guidelines

- **3.1.1.** Apps may not use "cryptocurrencies and cryptocurrency wallets" to
  unlock content or functionality. Creator tipping must use in-app purchase.
- **3.2.1(vii).** Monetary gifts between individuals may skip in-app purchase
  only if they are completely optional, 100% goes to the recipient, and the gift
  is not "connected to or associated at any point in time with receiving digital
  content or services".
- **Damus precedent (June 2023).** Apple approved Damus 1.5 only after it
  removed zaps on individual notes. Zaps on profiles stayed. As far as we can
  find, note zaps never came back on iOS.

### What this means for Yappr

| Behavior | Social v2 (testnet prod today) | Social v10 (bonsia) | Mainnet cut (Y2) | iOS 1.0 | Android 1.0 |
| --- | --- | --- | --- | --- | --- |
| YAPP charged to create post (10) / reply (3) / like (1) | **Required** by consensus | **Optional**; credits are the alternative | Optional | Credits only; no YAPP anywhere in the UI | Credits only |
| Post / reply action fee (80M / 16M credits, 0.0008 / 0.00016 DASH) | None | To a moderators pot; the **contract owner is the interim claimant** until a charter is seated | To a moderators pot that **only a seated charter can claim**; posting is closed until one is seated (`notYetUsable`) | Shown as "moderation fee (goes to elected moderators)" | Same |
| Buy YAPP with credits | Available | **Refused** (40721; YAPP is locked) | Refused | — | — |
| YAPP starter grant | Contract-dependent | 100 per identity, once, CRITICAL claim | Same | Not surfaced | Not surfaced |
| Tips on posts and replies | YAPP transfer | YAPP transfer **refused** (40711); web offers unprovable credit transfers | Proved credit tips (1.x design) | **Hidden** | 1.x |
| Tips on profiles (L1 `dash:` URI) | Available | Available | Available | Allowed: optional, 100% to recipient | Allowed |
| Storefront (physical goods for DASH) | v1 | v5 | — | 1.x, **physical goods only** (3.1.3(e)) | 1.x |

**Consequences**

- **The Y1/Y2 social cut is a hard dependency.** Under v2, a user without YAPP
  cannot post at all, so iOS would be gating a core feature behind crypto. The
  mobile apps will not ship against a social contract whose token costs are
  required.
- **Two kinds of credit cost. Only one of them is a network fee.**
  - *Processing fees* (storage plus processing, paid to masternodes and
    evonodes) are gas. Every Platform client pays them, and Yappr receives
    nothing. The UI calls these "network fee".
  - *Action fees.* `post` and `reply` declare
    `actionFees: {pricing: feeMultiplier, create: {moderators: 80000000}}`
    (16,000,000 for reply), paid into a moderators pot. On v10 the contract
    owner is the interim claimant, which on iOS would be a crypto payment to
    the developer to unlock posting.
  - **Settled (D5): the mainnet cut uses `interim: {"$type": "notYetUsable"}`.**
    Until an elected charter is seated, every transition on a moderated type
    (post, reply, report, `yapprProfile`) is refused with 41200, and nobody can
    claim the pot (`ContractFeeClaimNotAllowedError`); it accumulates for the
    team to come (platform book, `data-model/contract-moderation.md`, "The
    interim block"). After seating, only the seated team claims. Yappr, as
    contract owner, never does. Likes, follows and the other unmoderated types
    work from day one.
  - **Launch consequence.** The first mainnet election (windows of at least
    one day each) has to seat a charter before App Review, because the
    reviewer must be able to post. This is Y2, needed by G3.
  - The compose cost line (PRODUCT_UX) shows each component by its honest
    name.
- **[verify]** A fee paid to independently elected moderators, not the
  developer, is acceptable, and pure network fees are acceptable. Confirm both
  in the phase 3 App Review pre-consult.
- **Organization account.** Enroll as an organization anyway, because the app
  holds identity keys and displays credit balances.
- **Credit top-ups** always happen in DashPay. The Yappr app never sells credits
  or DASH.

### Pre-consult (phase 3)

Ask App Review for guidance through the App Review Board contact / Apple
developer relations. Topics:

1. Network (processing) fees in credits, plus the moderation fee that only
   elected moderators can claim.
2. Profile tips through `dash:` handoff to another app.
3. Storefront for physical goods.
4. The review sign-in approach (see [App Review package](#app-review-package)).

Record the answers in `docs/mobile/APP_REVIEW_LOG.md`.

## User-generated content (1.2 / Play UGC)

Apple's 2026 changes to 1.2 matter here: anonymous and random chat apps are
explicitly covered (February), and a June paragraph makes the developer
responsible for violating content. The App Review notes must describe the
moderation plan for decentralized content.

### Required surfaces and their state in Yappr today

| Requirement | Yappr web today | Needed for mobile 1.0 |
| --- | --- | --- |
| Filter objectionable content | Author-flagged `sensitive` posts hidden until the user consents (`lib/sensitive-content.ts`) | The same, **hidden by default**, plus local muted words in 1.1. Needs two deliberate steps to turn off (Play). |
| Report content and users | v10: on-chain reports of posts and replies, with a moderator queue that resolves them (`lib/reports.ts`, `components/moderation/`). Testnet v2: none. | Reports of posts, replies, **profiles** and **DMs** on the Y1 cut (see [Reports](#reports)), in the apps and on web |
| Block abusive users | `block` document, plus `blockFilter`/`blockFollow` | The same. Blocking hides content everywhere at once and also stops DMs, mentions and notifications from that user. |
| Act on reports within 24 h; remove content; eject users | v10: moderators can delete posts, replies, reports and `yapprProfile`, and ban, suspend and warn (contract `config.moderation`). The DashPay profile (name, avatar, bio) is a system contract that moderators cannot touch. Once a charter is seated, the interim is refused (41101), so Yappr staff cannot guarantee action on chain. | 1. Launch on the Y2 cut with a seated charter. 2. A **Yappr moderation denylist** that every official client enforces (below), for what on-chain moderation cannot reach. 3. A moderation rota with a documented SLA. |
| Published contact info | Not visible | Support email and URL in the app (Settings → About) and in store listings |
| EULA with zero tolerance | Terms page exists (`app/terms`), no zero-tolerance clause | Add a zero-tolerance clause, a Community guidelines page, and acceptance before first post (gate stored per identity) |

### Moderation denylist (new, Y7)

This is a client-enforced list of hidden identities, documents and media CIDs,
signed by a Yappr moderation key.

- **Where it lives.** The list is published as a document owned by a Yappr
  moderation identity, and mirrored at `https://yap.pr/moderation/denylist.json`
  with a detached signature.
- **Client behavior.** Clients fetch it on start and then every 6 hours, verify
  the signature, and hide matches everywhere: feeds, profiles (DashPay name,
  avatar and bio replaced), search, notifications, and DM requests from listed
  identities.
- **Scope.** It covers what on-chain moderation cannot: the DashPay profile,
  media, and anything the seated charter has not acted on within the SLA.
- **Transparency.** The list is public. Web shows "Hidden by Yappr moderation"
  with a link to the policy.

### Reports

v10 already has a `report` doctype for posts and replies: `postId` xor
`replyId`, `targetOwnerId`, `reason` (0–8, `lib/reports.ts`), a `note` of up
to 500 characters, one report per reporter per target, a 90-day `ttl`, and a
moderator-written `status` / `resolution` stamped with `$moderatedBy` /
`$moderatedAt`.

**The Y1 cut extends it (D7):**

| Change | Spec |
| --- | --- |
| Identity target | A third target, `identityId`, alongside `postId` and `replyId` (still exactly one). A profile and a user are the same target: reporting a profile reports the identity. Unique per reporter per target, as today. |
| DM reports | A DM report targets the other party's identity and carries `dmKeyEnvelope`: the reported conversation's key (DM v5: the key for that conversation's stream, which opens that conversation and nothing else), ECIES-encrypted to the moderation team. The key never goes in clear, because reports are public documents. |
| Moderation-team key | Whether the envelope is encrypted to each seated moderator or to one team key the charter publishes is settled in `REPORT_PROFILE.md` at G0. |
| Reasons | Add a dedicated "sexual content involving minors" reason that routes to the urgent path. |

**Disclosure to the reporter.** Reports are signed by the reporter's identity
and are public; the reported person can see that a report exists and who made
it. The report sheet says so. For a DM report it also says: "Moderators will be
able to read this whole conversation." The email channel below is offered as
the private alternative.

- **Moderator queue.** The existing web queue gains profile and DM targets; for
  a DM report it decrypts the envelope with the moderator's key and shows the
  conversation read-only.
- **Out-of-band channel.** For urgent illegal content, the in-app report
  flow also offers "Email the Yappr team", which opens an email to the support
  address with a prefilled link.
- **CSAM.** The minors reason routes straight to the urgent path. The
  moderation runbook must cover NCMEC reporting obligations **[verify with
  counsel]**.

**App Review notes should explain:**
- The contract gives elected moderators consensus-enforced delete (posts,
  replies, Yappr profile fields), ban and suspend, and reports are resolved on
  chain with an outcome and a moderator stamp. That is a real removal power,
  unlike most decentralized clients.
- The signed Yappr denylist, enforced by every official client, covers
  everything else (DashPay profile content, media, identities) within the 24 h
  SLA.
- Clients also hide content from blocked users on the device.

## Account deletion

Apple 5.1.1(v) requires in-app deletion of the account and its data, not just
deactivation. Play requires the in-app path **and** a web URL that works
without the app.

**Flow:** Settings → Delete account.

1. **Explain.**
   - *What we'll delete:* your posts and replies (real deletes on v10), your
     Yappr profile fields (`yapprProfile`), reposts and quotes, follows,
     bookmarks, blocks, DM messages where deletable, private-feed state where
     deletable, push endpoints, reports, key backups/vaults, and everything on
     this device.
   - *Optional:* your DashPay profile (name, avatar, bio). It is shared with
     your wallet, so it is kept unless you tick "Also delete my DashPay
     profile".
   - *What can't be deleted:* your Dash identity and username (they belong to
     your DashPay wallet), transaction and fee history, moderation records,
     likes (D11), DM v5 `dmInvite` / `dmGroupDoc`, `privateFeedState`, and
     other document types that cannot be deleted (listed by name from the live
     contracts), plus copies others have made (quotes, screenshots).
   - The final wording gets **counsel sign-off**, since it is the 5.1.1(v)
     disclosure.
2. **Estimate cost.** Deleting costs network fees. Show the estimate and
   current balance. If the balance is too low, offer "Top up in DashPay" or a
   **partial** deletion (profile first, then newest content first).
3. **Confirm.** The user types `DELETE`, then passes the biometric app lock if
   enabled.
4. **Run.** A resumable background job batches deletes in order:
   `yapprProfile` (and the DashPay profile if chosen) → posts/replies → social
   graph → DMs → private feed → push/report/misc. It shows progress, keeps
   working with the app in the background (`BGContinuedProcessingTask` on
   iOS 26, WorkManager on Android), and resumes on next launch if interrupted.
5. **Finish.** Wipe local data and sign out. Point the user to "Revoke Yappr in
   DashPay → Connections", and to deleting their identity in the wallet if
   they want that.

**Web URL:** `https://yap.pr/delete-account` is a new web page (Y7). It runs
the same job from the browser after wallet sign-in, and documents the process
for people without the app. Its URL goes in the Play Data safety form.

**Shared logic:** a new `lib/account-deletion.ts`, used by web and mobile,
holds the plan, ordering, cost estimate and resumable cursor.

## Age rating and minors

- **Apple:** answer the social-media capability questions (added July 2026,
  required on every submission since September 2026) plus UGC, unrestricted
  web access (link previews) and messaging. The expected rating is **16+** or
  **18+** **[verify]** when the questionnaire runs.
- **Texas SB 2420 (enforced since 2026-06-04):** integrate the Declared Age
  Range API. If the declared range is under 18 and the rating is 18+, Apple
  blocks the app, so nothing is needed in the app. With a 16+ rating we must
  handle parental consent, which pushes toward 18+. **Decision at phase 3.**
- **Utah's equivalent** is delayed to 2027-05-06. Track it.
- **Play:** IARC questionnaire, the target-audience declaration (not designed
  for children), and the Families policy does not apply.
- **EU:** Apple's single business terms and 5% Core Technology Commission take
  effect 2026-10-01. They only matter if we distribute in the EU; review with
  the publisher.

## Encryption export

- Set `ITSAppUsesNonExemptEncryption = YES`. The app uses standard algorithms
  that iOS does not provide: secp256k1 ECDH/ECDSA, XChaCha20-Poly1305, and
  AES-GCM through libraries.
- **App Store Connect:** answer "standard algorithms, not provided by Apple".
  No CCATS is needed.
- **France:** file the French encryption declaration (ANSSI, about one month),
  or exclude France from the launch territories until it clears.
- The US annual self-classification report was removed for mass-market items
  in 2021. Apple's page still mentions it, so confirm with counsel
  **[verify]**.

## Privacy disclosures

| Data | Collected by us? | Notes for labels / Data safety |
| --- | --- | --- |
| Posts, profile, social graph, reports | **No.** Written by the user directly to a public blockchain. | Explain in the App Privacy "not collected" rationale. Data is public by design; say so in-app and in the store description. |
| DMs, private posts | No; end-to-end encrypted. A DM report shares one conversation's key with the elected moderators, at the reporter's request. | Play: E2E-encrypted data unreadable by the developer need not be declared. Disclose the report exception in the privacy policy. |
| Device push token | Only with Instant mode on, and only by the relay (in memory, not logged) | Declare "Device or other IDs", used for app functionality, not linked to identity, optional |
| Crash logs | None (D14). The OS and stores collect their own vitals under the user's system settings. | — |
| Analytics | None | — |
| Third parties | DAPI nodes (IP), IPFS gateways and pinning provider (IP, uploads), price APIs (CoinGecko/CryptoCompare) and Insight (address lookups for tips) | Disclose in the privacy policy. Add a "Privacy mode" toggle (1.1) that turns off the price and Insight lookups. |

- **Privacy manifest.** Required-reason APIs (UserDefaults, file timestamp,
  system boot time) must be listed for the app, the NSE and every bundled SDK.
  Regenerate it in CI.
- **Play Financial features declaration:** answer "non-custodial; no
  exchange". This is **mandatory for all apps**.

## App Review package

The package submitted with each review:

- **Demo account.** The reviewer needs to test report, block, posting and
  deletion, so a read-only session is not enough, and hidden review-only
  entry points risk 2.3.1. We provide:
  - A **funded demo identity** on the launch network, loaded with content. The
    launch contract must have a seated charter, or posting is closed (D5).
  - Its DashPay **recovery phrase**, in the App Review notes and the Play
    Console "App access" instructions, so the reviewer can restore it in the
    public DashPay app and sign in through the normal flow.
  - A screen recording of the full handoff.

  The demo identity is rotated after every review, and its balance is capped.
- **Written notes** explaining:
  - the decentralized architecture;
  - where the report, block and filter controls are;
  - the moderation powers and 24 h SLA;
  - that fees are network fees plus a moderation fee that only elected
    moderators can claim;
  - that there are no post tips on iOS;
  - that account deletion covers everything deletable;
  - the export classification.
- **Support URL, marketing URL and privacy policy URL** on `yap.pr`.
