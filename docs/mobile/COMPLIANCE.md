# Store and policy compliance

These are the requirements for getting through App Review and Google Play
review. Sources are the App Store Review Guidelines (last updated
2026-06-08), Play Policy Center pages, and platform documentation, all
checked 2026-09-27. Items marked **[verify]** come from secondary sources or
reports of rejections, and should be checked again before submission.

## Summary checklist (release blockers)

| # | Requirement | iOS | Play | Owner | Phase |
| --- | --- | --- | --- | --- | --- |
| C1 | Organization developer accounts (legal entity, D-U-N-S) | 3.1.5(i), 5.1.1(ix) | Crypto wallet declaration, and it avoids the new-personal-account 12-tester/14-day rule | Product owner | 0 |
| C2 | No crypto-gated functionality and no crypto paid to the developer to unlock features on iOS: YAPP fees, YAPP purchase, and **v9 action fees to an owner-claimable pot** | 3.1.1 | Tokenized-asset declaration, Billing policy | Yappr contracts (Y1) plus mobile flags | 0 decision, 3 verify |
| C3 | No tips attached to posts on iOS; profile tips only, optional, 100% to recipient | 3.1.1, 3.2.1(vii) | OK (P2P exception) | Mobile | 1 |
| C4 | UGC safeguards: report, block, filter, EULA, contact, acting on reports within 24 h | 1.2 | UGC policy | Yappr (Y2) plus mobile plus moderation ops | 1 to 3 |
| C5 | Account deletion in the app, plus a web URL | 5.1.1(v) | Account deletion policy | Yappr (Y2) plus mobile | 2 |
| C6 | Non-custodial only; no exchange features | 3.1.5 | Out of scope of the crypto wallet licensing policy if non-custodial | Architecture (by design) | — |
| C7 | Age rating questionnaire incl. social-media questions (Sep 2026); Declared Age Range API (Texas SB 2420) | Required | Content rating (IARC) | Mobile plus product owner | 3 |
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

| Current web behavior | Social v2 (testnet prod today) | Social v9 | iOS 1.0 | Android 1.0 |
| --- | --- | --- | --- | --- |
| YAPP charged to create post (10) / reply (3) / like / repost (1) | **Required** by consensus | **Optional**; credits are the alternative | Credits only; no YAPP anywhere in the UI | Credits only in 1.0; YAPP choice in 1.1 after the Play declaration |
| Buy YAPP with credits | Available | Available | **Hidden** | 1.1 |
| YAPP starter grant | Contract-dependent | Contract-dependent | Hidden | 1.1 |
| Tips on posts and replies (`yappr:tip:v1:post:…`) | Available | Available | **Hidden** | 1.1 |
| Tips on profiles (L1 `dash:` URI) | Available | Available | Allowed: optional, 100% to recipient | Allowed |
| Storefront (physical goods for DASH) | v1 | v4 | 1.x, **physical goods only** (3.1.3(e)) | 1.x |

**Consequences**

- **Social v9 is a hard dependency (Y1).** Under v2, a user without YAPP cannot
  post at all, so iOS would be gating a core feature behind crypto. The mobile
  apps will not ship against a social contract whose token costs are required.
- **Two kinds of credit cost on v9. Only one of them is a network fee.**
  - *Processing fees* (storage plus processing, paid to masternodes and
    evonodes) are gas. Every Platform client pays them, and Yappr receives
    nothing. The UI calls these "network fee".
  - *Action fees.* v9 `post` and `reply` declare
    `actionFees: {pricing: feeMultiplier, create: {moderators: 80000000}}`
    (16,000,000 for reply). This is paid into a moderators pot. Until an
    elected charter is seated, **the contract owner is the only claimant**
    (docs/SOCIAL_V9.md). On iOS that is a crypto payment to the developer to
    unlock posting, which is a likely 3.1.1 rejection, and calling it a
    "network fee" would misrepresent it.
  - **Required for Y1 (mainnet cut): pick one.**
    1. Post and reply action fees set to 0 in the launch contract. The
       moderators pot is then funded some other way, such as optional
       donations on web.
    2. The contract is configured so the owner can **never** claim the pot,
       only seated charter moderators. It is then disclosed in the app as
       "moderation fee (goes to elected moderators)" and cleared in the
       Apple pre-consult first.

    Option 1 is recommended: it removes the question entirely.
  - The compose cost line (PRODUCT_UX) shows each component by its honest
    name.
- **[verify]** Pure network fees are acceptable. Confirm in the phase 3 App
  Review pre-consult.
- **Organization account.** Enroll as an organization anyway, because the app
  holds identity keys and displays credit balances.
- **Credit top-ups** always happen in DashPay. The Yappr app never sells credits
  or DASH.

### Pre-consult (phase 3)

Ask App Review for guidance through the App Review Board contact / Apple
developer relations. Topics:

1. Network (processing) fees in credits, plus the chosen action-fee model.
2. Profile tips through `dash:` handoff to another app.
3. Storefront for physical goods.
4. The review sign-in approach (see [App Review package](#app-review-package)).

Record the answers in `docs/mobile/APP_REVIEW_LOG.md`.

## User-generated content (1.2 / Play UGC)

### Required surfaces and their state in Yappr today

| Requirement | Yappr web today | Needed for mobile 1.0 |
| --- | --- | --- |
| Filter objectionable content | Author-flagged `sensitive` posts hidden until the user consents (`lib/sensitive-content.ts`) | The same, **hidden by default**, plus local muted words in 1.1. Needs two deliberate steps to turn off (Play). |
| Report content and users | **None** | New `report` document (see below) plus an in-app flow on posts, replies, profiles and DM messages |
| Block abusive users | `block` document, plus `blockFilter`/`blockFollow` | The same. Blocking hides content everywhere at once and also stops DMs, mentions and notifications from that user. |
| Act on reports within 24 h; remove content; eject users | v9: moderators can delete **posts and replies**, ban, suspend and warn (`moderation-service.ts`, contract `config.moderation`). **v2: no moderator powers.** Profiles, DM documents and hashtag documents are **not** moderator-deletable. Once an elected charter is seated, the owner is refused (41101), so Yappr staff cannot guarantee action. | 1. Launch on v9 (Y1). 2. A **Yappr moderation denylist** that both apps enforce (below). This is what Yappr can act on within 24 h regardless of on-chain powers. 3. A moderation rota with a documented SLA. |
| Published contact info | Not visible | Support email and URL in the app (Settings → About) and in store listings |
| EULA with zero tolerance | Terms page exists (`app/terms`) | Add a zero-tolerance clause, a Community guidelines page, and acceptance before first post (gate stored per identity) |

### Moderation denylist (new, Y2)

This is a client-enforced list of hidden identities, documents and media CIDs,
signed by a Yappr moderation key.

- **Where it lives.** The list is published as a document owned by a Yappr
  moderation identity, and mirrored at `https://yap.pr/moderation/denylist.json`
  with a detached signature.
- **Client behavior.** Clients fetch it on start and then every 6 hours, verify
  the signature, and hide matches everywhere: feeds, profiles (avatar, bio and
  banner replaced), search, notifications, and DM requests from listed
  identities.
- **Scope.** It covers what on-chain moderation cannot: profiles, media,
  identities under a seated charter. It is the mechanism behind the 24 h SLA
  for everything.
- **Transparency.** The list is public. Web shows "Hidden by Yappr moderation"
  with a link to the policy.

### Report contract (new, Y2)

A small `yappr-report` contract, separate from social, so existing contracts
don't change.

| Field | Type | Notes |
| --- | --- | --- |
| `targetType` | enum: post, reply, profile, dmMessage | |
| `targetId` | identifier | Document ID or identity ID |
| `targetOwnerId` | identifier | For the moderator queue index |
| `reason` | enum: spam, harassment, hate, sexual content involving minors, violence, illegal, impersonation, other | |
| `note` | string ≤ 280 | Optional |
| `evidence` | bytes ≤ 2 KB | **DM only**, and only with the user's consent: the reported message plaintext, ECIES-encrypted to the **Yappr moderation identity's** ENCRYPTION key. That key is rotated when the moderation team changes; old reports stay readable to whoever holds old keys, per the runbook. |

- **Indices:** `[targetType, $createdAt]` and `[targetOwnerId, $createdAt]`.
  One report per reporter per target, enforced by a unique index on
  `[$ownerId, targetId]`.
- **Reporter privacy.** Platform documents are public and carry `$ownerId`,
  so a report reveals who reported what. That invites retaliation. So:
  - `reason` and `note` are ECIES-encrypted to the moderation key along with
    `evidence`. Only `targetType`, `targetId` and `targetOwnerId` stay clear,
    because the queue indexes need them.
  - The report sheet says plainly that "reports are signed by your identity;
    the target can see that a report exists".
  - The email channel below is offered as the anonymous alternative.
- **Moderator queue:** web moderators get a queue view (a web change, Y2).
- **Out-of-band channel:** for urgent illegal content, the in-app report
  flow also offers "Email the Yappr team", which opens an email to the support
  address with a prefilled link.
- **CSAM:** the "sexual content involving minors" reason routes straight to
  the urgent path. The moderation runbook must cover NCMEC reporting
  obligations **[verify with counsel]**.

**App Review notes should explain:**
- The contract gives moderators consensus-enforced delete (posts and replies),
  ban and suspend. That is a real removal power, unlike most decentralized
  clients.
- The signed Yappr denylist, enforced by every official client, covers
  everything else (profiles, media, identities) within the 24 h SLA.
- Clients also hide content from blocked users on the device.

## Account deletion

Apple 5.1.1(v) requires in-app deletion of the account and its data, not just
deactivation. Play requires the in-app path **and** a web URL that works
without the app.

**Flow:** Settings → Delete account.

1. **Explain.**
   - *What we'll delete:* your profile, likes, reposts, follows, bookmarks,
     blocks, DM messages where deletable, private-feed state where deletable,
     push endpoints, reports, key backups/vaults, and everything on this
     device.
   - *What we'll blank:* posts and replies. On v9 these have
     `canBeDeleted: false`, so "delete" is a **tombstone replace**. The text
     and media are removed, but the document ID, `$createdAt` and immutable
     fields (language, hashtag, quote target) remain.
   - *What can't be deleted:* your Dash identity and username (they belong to
     your DashPay wallet), transaction and fee history, moderation records,
     DM v5 `dmInvite` / `dmGroupDoc`, and other document types with
     `canBeDeleted: false` (listed by name from the live contracts), plus
     copies others have made (quotes, screenshots).
   - The final wording gets **counsel sign-off**, since it is the 5.1.1(v)
     disclosure.
2. **Estimate cost.** Deleting costs network fees. Show the estimate and
   current balance. If the balance is too low, offer "Top up in DashPay" or a
   **partial** deletion (profile first, then newest content first).
3. **Confirm.** The user types `DELETE`, then passes the biometric app lock if
   enabled.
4. **Run.** A resumable background job batches deletes in order: profile →
   posts/replies → social graph → DMs → private feed → push/report/misc. It
   shows progress, keeps working with the app in the background
   (`BGContinuedProcessingTask` on iOS 26, WorkManager on Android), and
   resumes on next launch if interrupted.
5. **Finish.** Wipe local data and sign out. Point the user to "Revoke Yappr in
   DashPay → Connections", and to deleting their identity in the wallet if
   they want that.

**Web URL:** `https://yap.pr/delete-account` is a new web page (Y2). It runs
the same job from the browser after wallet sign-in, and documents the process
for people without the app. Its URL goes in the Play Data safety form.

**Shared logic:** a new `lib/account-deletion.ts`, used by web and mobile,
holds the plan, ordering, cost estimate and resumable cursor.

## Age rating and minors

- **Apple:** answer the social-media capability questions (required on every
  submission since September 2026) plus UGC, unrestricted web access (link
  previews) and messaging. The expected rating is **16+** or **18+** **[verify]**
  when the questionnaire runs.
- **Texas SB 2420 (enforced since 2026-06-04):** integrate the Declared Age
  Range API. If the declared range is under 18 and the rating is 18+, Apple
  blocks the app, so nothing is needed in the app. With a 16+ rating we must
  handle parental consent, which pushes toward 18+. **Decision at phase 3.**
- **Utah's equivalent** is delayed to 2027-05-06. Track it.
- **Play:** IARC questionnaire, the target-audience declaration (not designed
  for children), and the Families policy does not apply.

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
| Posts, profile, social graph | **No.** Written by the user directly to a public blockchain. | Explain in the App Privacy "not collected" rationale. Data is public by design; say so in-app and in the store description. |
| DMs, private posts | No; end-to-end encrypted | Play: E2E-encrypted data unreadable by the developer need not be declared |
| Device push token | Only with Instant mode on, and only by the relay (in memory, not logged) | Declare "Device or other IDs", used for app functionality, not linked to identity, optional |
| Crash logs | Opt-in only, self-hosted, IP and PII stripped | Declare "Crash data", optional |
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
  - A **funded demo identity** on the launch network, loaded with content.
  - Its DashPay **recovery phrase**, in the App Review notes and the Play
    Console "App access" instructions, so the reviewer can restore it in the
    public DashPay app and sign in through the normal flow.
  - A screen recording of the full handoff.

  The demo identity is rotated after every review, and its balance is capped.
- **Written notes** explaining:
  - the decentralized architecture;
  - where the report, block and filter controls are;
  - the moderation powers and 24 h SLA;
  - that fees are network fees;
  - that there are no post tips on iOS;
  - that account deletion covers everything deletable;
  - the export classification.
- **Support URL, marketing URL and privacy policy URL** on `yap.pr`.
