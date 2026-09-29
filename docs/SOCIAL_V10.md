# Contract re-cut for Platform 4.2.0-beta.7: social v10

The new devnet **bonsia** is a fresh chain: Platform 4.2.0-beta.7, protocol
version 14, and a new Core chain, so nothing registered on moutai exists there.
Every Yappr contract is registered again. This cut:

- replaces social v9 with **social v10**, which folds in the v10 design for the team's requests;
- translates every contract whose grammar beta.7 removed: blog, storefront and pollr;
- fixes the QA defects a contract can fix (D-14, D-25 and D-44).

Nothing here is deployed yet. The SDK pin is on `beta7/sdk-bonsia` (#595).

Sources, all read at tag `v4.2.0-beta.7` (`50d12037`) in the platform checkout:

- `book/src/contract-keywords/` chapters:
  - `moderator-abilities.md` (#5158)
  - `refers-to.md` and `refers-to-lookup.md` (`where`/`findBy`, #5197)
  - `owner-refers-to.md`
  - `indexes.md` (`skipIfAbsent`, #5162)
  - `transient.md`
  - `max-bytes.md`
- `book/src/data-model/contract-moderation.md`, which covers `changeDocumentFields` and `$moderatedAt`/`$moderatedBy` (#5161).
- `packages/rs-dpp/schema/meta_schemas/document/v3/document-meta.json`, vendored at `scripts/meta-schema/` with sha256 `d1dbfeb1…db924`.
- `packages/rs-dpp/src/data_contract/config/moderation/{mod,elected}.rs` and `try_from_schema/common/mod.rs` (index shapes).
- `packages/rs-platform-version/src/version/system_limits/v4.rs`.
- `packages/dashpay-contract/schema/v2/dashpay.schema.json`.

The design work behind this cut is in two ops notes:

- the v10 study (`V10-DESIGN.md`), which covers the eight team requests;
- the beta.7 adoption plan (`BETA7-PLAN.md`), which covers the grammar translation, beat removal, stored `skipIfAbsent`, report `changeFields` and the YAPP lock.

This document records what was adopted, with the numbers measured on the committed files.

## Summary

All sizes are the signed create measured with the beta.7 SDK. The cap is 20,480 B and the budget is 20,000 B.

| Contract | Topology | Change | Signed create |
| --- | --- | --- | ---: |
| social v10 | `v10` | new cut (below) | **18,178 B** (1,822 B under budget) |
| storefront | `v5` | beta.7 grammar; QA D-25 (an order needs an open store); `categoryAndTime` skips items with no section | 14,861 B (was 14,588 on beta.6) |
| blog | `v5` | beta.7 grammar only; keeps the beta.6 comments-off rule and owner gate | 6,489 B |
| pollr | `v4` | beta.7 grammar only | 6,004 B |
| DM v4, DM v5, key exchange | unchanged | none (they use no removed keyword) | 2,738 / 3,674 / 1,459 B |
| key backup, vault, auth vault | unchanged | published from the testnet snapshot (see below) | 991 / 659 / 2,220 B |
| profile contract | retired on v10 | DashPay `profile` + `yapprProfile` replace it | — |

Every file parses under full validation twice, and passes the node-rule audit:

- the wasm-sdk parse;
- the wasm-dpp2 parse (meta-schema and index shapes);
- `auditNodeRules`, which covers election windows, abilities, reference targets, `where` sides and index shapes.

The negative probes (73) and the `propertyConstraints` cases (50) behave as recorded:

```bash
node scripts/validate-contract-offline.mjs contracts/yappr-social-contract-v10.json --strict-size --cost
node scripts/validate-contract-offline.mjs --probes
node scripts/validate-contract-offline.mjs --constraints
```

### sha256 of each file the publisher pins

```
e29f77f6013aa9f02aa57fdf85cd11e2c43f603838d688647b1f0fb6f855f955  yappr-social-contract-v10.json   (new)
ecd08e7676c88cf8e623cce82ddfe614d96444f487f1d2cf43411fe4762d0735  yappr-storefront-contract.json   (changed)
464b605e652d6dac031fee9576d9573bf25b5fe6dda530b7f8330da78d915dbe  yappr-blog-contract.json        (changed)
dbc8006389b4caf421b1379de2a76bbf105182d10c76e614c8ba16a8f13113d5  pollr-contract.json             (changed)
7a86b1d2c9ccb15ceb62605c49d1375365e5b530698ab987d90c21eed5b59139  yappr-dm-contract.json
82c03a3c9e2fa747ebc98d3d4375fa394080f0b649c2c678847f74389b6796f3  yappr-dm-contract-v5.json
8b73b1c9569cf02291e894999ceedd2af87ea69c67fd5390a377298ba69089e4  key-exchange-v2.json
```

The DM and key exchange hashes equal the beta.6 pins.

**Key backup, vault and auth vault.** As on beta.4 through beta.6, these three are published from the testnet snapshot (`source-contracts.json`, file sha256 `6101eb0f…caf8`, entries `keyBackup`, `vault` and `authVault`), not from the repo files.

- The repo copies carry a legacy doctype key `mutable`. The meta-schema refuses it (10101), and the wasm-sdk silently drops it.
- The snapshot copies parse under both wasm-sdk and wasm-dpp2 on beta.7.
- Key exchange is also published from the snapshot. The repo copy parses too, but its `encryptedPayload` is 60 B, where the snapshot's is 1–4096 B.

## The beta.7 grammar

beta.7 removed three keywords from meta-schema v3. The generation-3 parser refuses them on every parse, so a beta.7 SDK cannot read a beta.6-grammar contract and a beta.7 node would not load one.

| beta.6 | beta.7 | Note |
| --- | --- | --- |
| `canBeDeletedByModerators: true` | `moderatorAbilities: { delete: true }` | Defaults `deleteKeepsRecord: true` and `deleteRefundsOwner: false` are beta.6's behaviour |
| `refersTo.propertyAgreement { <mine>: <its> }` | `refersTo.where { <its>: <mine> }` | Key and value swap sides. A symmetric pair (`$ownerId: $ownerId`) reads the same |
| `refersTo.lookup { index, keys }` | `refersTo.findBy <keys>` | The index is the unique one over exactly those keys, and it must exist |

The translation is mechanical, and `lib/contract-topology.test.ts` pins every v10 `where` as the flip of its v9 agreement. The trap is on the tooling side: the wasm-sdk **silently drops** a leftover `canBeDeletedByModerators`, so a type written with it registers with no moderator delete, and only a node refuses it. The validator therefore parses every file through `@dashevo/wasm-dpp2` as well (below).

## Social v10

### Adopted

| # | Change | Why |
| --- | --- | --- |
| 1 | **Real deletes.** `post` and `reply` are `documentsMutable: false` and owner-deletable (the contract default); `deleted`, the `immutable`/`immutableAllowSetting` lists, `tombstoneIsBlank` and the three `*DeletedCount` indexes are gone | Tombstones cost 752 B, never refunded storage, and needed client filtering everywhere. A reply, quote, repost, like, bookmark or report aimed at a deleted post is refused **40120** (QA D-14 in consensus), and the quote and reply counts decrement natively (QA D-44). An author's delete leaves no removal record, so it cannot be restored (41119). Posts cannot be edited ("no post editing" was settled) |
| 2 | **Content 1000 characters / 2000 bytes** on post and reply (`maxLength` in code points, `maxBytes` in UTF-8, **10421** over it); `encryptedContent` up to 2048 B | Team request. Bytes bind first for CJK (about 666 characters) and emoji (500). The private-feed plaintext cap rises from 999 B to **2031 B** (1 version byte + plaintext + 16-byte tag ≤ 2048) |
| 3 | **No `language`; one global `timeline [$createdAt]`** replaces `languageTimeline` | Language was always `en`. The feed is `where $createdAt > 0 orderBy $createdAt desc` |
| 4 | **`mediaHash` (32 B sha256) + `mediaFingerprint` (8 B dHash)** on post and reply, required with `mediaUrl` and only with it (`dependentRequired`: 10101) | Media integrity, the same shape as DashPay's avatar. The dHash is pinned below. `privateHasNoMedia` stays |
| 5 | **`keyGeneration` / `maxKeyGeneration`** replace the private-feed `epoch` / `maxEpoch`; the rekey index is `ownerAndKeyGeneration` | "epoch" collided with Platform epochs and DM v5 group epochs. Only free at a re-cut. The HKDF labels (`epoch-chain`) and the ciphertext layout do not change |
| 6 | **One hashtag** (`post.hashtag`) | An array cannot be indexed (10206). The validator now proves that offline |
| 7 | **The DashPay profile is the base profile; `yapprProfile` is the extension**, in social. `ownerRefersTo` requires a DashPay `profile` owned by the writer (`findBy { $ownerId: "." }` into DashPay's unique `ownerId` index; 40120 without one), moderator-deletable. The legacy social `profile` doctype and the profile contract are retired on v10 | Users with a DashPay profile show their name and avatar at once; one registration. DashPay caps the name at 25 and the bio (`publicMessage`) at 140. Payment addresses stay in `yapprProfile.paymentUris` |
| 8 | **No doctype descriptions** | Kept here instead; they would cost about 1,183 B of the headroom |
| 9 | **`beat` removed; trending is ROLLING, on `like` itself.** `like` keeps 7 indexes: byPost, byHashtagPost (`skipIfAbsent`), byAuthorPost, byAuthorTimePost, byLiker, plus **`byTrendPost`** `[$createdAt, postId]` (72h windows every 24h, ranked) for top posts and **`byTrendHashtagPost`** `[$createdAt, hashtag, postId]` (24h windows every 6h, `skipIfAbsent`, ranked at `[hashtag, postId]`) for trending tags and a tag's top posts. `byDayPost`, `byDayAuthorPost` and `byDayHashtagPost` are gone: there is no windowed creator axis, so the creator leaderboard and a profile's top are all-time on v10. All windows expire after a week (`ttl` 604800) | One transition per like instead of two. The client reads each rolling grid through its **oldest** open window, which always spans ~18-24h (tags) or ~48-72h (posts), where a daily grid restarts empty at midnight UTC. The two grids stay distinct, so neither shares the other's storage or `ttl`. The all-time `byHashtagPost` must stay, with its own skip (#5162 refuses an indexOnly optional property without an untimed single-skip index). **Decision:** BETA7-PLAN's D-3 proposed the daily grid (cheaper by ~11.9M per tagged like); the user reversed it on 2026-09-28 in favour of this rolling design, measured then through drive-abci at 77.5M untagged / 91.3M tagged steady, against 76.7M / 117.5M for v9's like + beat |
| 10 | **`skipIfAbsent` on every stored index over an optional property**: post `quotesOfPost`, `quotesOfReply`, `quotedPostOwnerAndTime`, `quoteCount`, `quoteReplyCount`, `tagAndTime`; reply `replyToReplyAndTime`, `byReplyToReply`; report `ownerAndPost`, `ownerAndReply`, `byPost`, `byReply` | No null-key entries. A plain post is 167.5M / 135.8M against v9's 323.5M / 189.9M. Every client read of these indexes binds the property with `==`, which a skip index serves |
| 11 | **Reports are resolved, not deleted.** `status` (1 no action, 2 content removed, 3 user actioned) and `resolution` (1–200 characters) are `moderatorAbilities.changeFields`, written with `moderatorChangeDocumentFields`; `byStatus [status, $createdAt]` and `byModerator [$moderatedBy, $moderatedAt]`; the 90-day `ttl` stays; `resolvedHasStatus` refuses a resolution without a status; moderators may still delete a report, with `deleteKeepsRecord: false` (spam purge, no removal record); the elected set gives `report` `["deleteDocuments", "changeDocumentFields"]` | The report stays visible with its outcome, stamped with who handled it and when. A field change does not count toward the team's action share. A reporter who sets `status` is refused 41124. `byStatus` does not skip, because an open report has no status |
| 12 | **YAPP cannot be transferred or bought.** `startAsPaused: true`; `changeDirectPurchasePricingRules` authorized and admin `noOne`; `emergencyActionRules` already `noOne`, so nobody can unpause | Only transfers read the pause in drive-abci, so the token costs on post (10), reply (3), like (1), likeReply (1) and repost (1), the 100 once-per-identity grant, and owner mint and burn keep working. Seeders and batteries mint or claim; tips on v10 are credit tips |
| 13 | **Election windows 3600 / 3600 s**, elected with the owner as interim and `ownerProtected`; `yapprProfile` moderated for `deleteDocuments` | Devnet only (the mainnet floor is one day; `--network mainnet` fails the audit on purpose) |

Two changes on top of the `V10B7-FINAL` prototype:

- the rekey index is renamed `ownerAndKeyVersion` → `ownerAndKeyGeneration`, to match the property;
- `report.resolution` gains `minLength: 1` and the `resolvedHasStatus` rule (+71 B). Without them, a moderator could write an empty note, or a note with no outcome.

### The DashPay profile and the extension

| Field (retired profile contract) | v10 | Note |
| --- | --- | --- |
| `displayName` ≤50 | DashPay `displayName` ≤25 | shrinks; the client counts and truncates with confirmation on migration |
| `bio` ≤160 | DashPay `publicMessage` ≤140 | shared with the wallet |
| `avatar` (image URI) | DashPay `avatarUrl` + `avatarHash` + `avatarFingerprint` | DashPay's own `dependentRequired`; same dHash as media |
| `avatar` (DiceBear recipe) | `yapprProfile.avatar` ≤128 | used when DashPay has no `avatarUrl` |
| `bannerUri`, `location`, `website`, `pronouns`, `nsfw`, `socialLinks`, `paymentUris` | `yapprProfile` | same limits; `website` must be `https?://`, `bannerUri` `https?://` or `ipfs://` |

- The DashPay profile is written first. A write of the extension then costs one billed read of DashPay.
- A user who deletes their DashPay profile can no longer edit the extension (it is a `deletableDocument` found by `findBy`, re-checked on every replace), but can still delete it.
- An app-connect key bound to the social contract cannot sign a DashPay write, so the login request must also ask for a `DashPay/profile` binding.

### The media fingerprint (pinned)

`mediaFingerprint` is a 64-bit difference hash. The seeder (`scripts/seed/media-hash.mjs`) and the client (`lib/media/dhash.ts`, the media PR) compute it the same way:

1. Decode the image with EXIF orientation applied, and resize it to exactly **9 columns × 8 rows**.
2. Take the luma of each pixel with BT.601: `Y = 0.299 R + 0.587 G + 0.114 B`.
3. For each row from the top, and for each of its 8 adjacent pairs from the left, the bit is 1 when the **right** pixel is brighter (`Y[x+1] > Y[x]`).
4. Pack the bits row-major, most significant bit first. Byte *r* is row *r*.

A Hamming distance of 12 or less means "the same image, re-encoded". Measured: the same picsum image at half size differs by 6 bits, and a different image by 24. `mediaHash` is the sha256 of the exact bytes at the URL. Consensus never fetches the URL, so a hash that has gone stale is a client warning, not a refusal. The fingerprint still has to be confirmed against dash-wallet (Android and iOS) before avatars use it.

### Measured document costs

These are `documentCreateCost` figures in credits, as new / known index values. Optional fields are absent unless named; variable ones are at mid-length. Processing is estimated; storage is exact. The v9 column is v9 translated to the beta.7 grammar. A report grows by its two optional moderator fields and the `byStatus`/`byModerator` entries a resolution adds.

| Document | v9 (translated) | v10 |
| --- | ---: | ---: |
| like, untagged | 133.2M / 46.7M | 133.6M / 47.2M |
| like, tagged | 182.1M / 58.6M **+ beat 57.4M / 36.6M** | **196.8M / 73.7M** |
| post, plain (no tag, quote or media) | 323.5M / 189.9M | **167.5M / 135.8M** |
| post, 1000 ASCII characters | — | 183.5M / 151.8M |
| post with media | — | 177.0M / 145.3M |
| reply, top-level | 213.6M / 107.8M | 126.6M / 81.4M |
| report, open (post) | 12.0M / 13.3M | 14.4M / 16.2M |
| yapprProfile | — | 137.2M |

`node scripts/validate-contract-offline.mjs <file> --cost` prints the defaults for every type.

### Considered and not adopted

| Candidate | Why not |
| --- | --- |
| Doctype descriptions back (19,512 B) | 488 B of headroom is too thin for the next beta |
| The like "lean" variant (drop the all-time `byHashtagPost`) | Refused by #5162 (see #9). Probed |
| A daily grid for top posts and tags (BETA7-PLAN D-3), and a daily creator window | Reversed by the user (2026-09-28): trending must be rolling. The daily variant measured 133.2M / 46.7M untagged and 185.4M / 61.8M tagged, so rolling costs +0.4M / +0.5M untagged and +11.4M / +11.9M tagged, all of it processing (a TTL'd window adds no storage). Dropping the creator window saves an index per like |
| Dropping the report `ttl` | Reports would become permanent storage, about 8× the cost per report |
| `skipIfAbsent` on `report.byStatus` | An open report has no status. A skip index cannot serve the open queue (`status == null`) |
| A post `ownerRefersTo` DashPay gate (+146 B) | Adds a billed read to every post and duplicates the client's profile gate |
| `reply.feedOwnerId` (+130 B) | Private replies under a deleted root stay undecryptable. This is the spec's accepted edge case; revisit if deletes turn out to be common |
| `hashtag2` (+163 B) | Only the first tag could rank in trending |
| `storeStatus` as a `transient` property | A `where` may read a transient value on its referring side, but a `propertyConstraints` rule may not read one (`transient.md`), so `storeIsOpen` could not be expressed |

## Storefront (topology v5): QA D-25

A closed or paused store could still take orders through a direct link or the checkout.

- **Fix.** `storeOrder.storeStatus` is required (`active | paused | closed`). The `storeId` reference's `where` gains `status: storeStatus`, so the order must copy the store's real status (40127 on a stale copy).
- **The `storeIsOpen` rule.** It refuses every status but `active` (10422).
- **Client.** It writes the field (`lib/services/store-order-service.ts`, gated on `NEXT_PUBLIC_STOREFRONT_TOPOLOGY=v5`). The checkout already re-reads the store before paying, so a buyer is not charged for a refusal.
- **Unchanged.** The other storefront rules stay. A `sellerId distinctFrom $ownerId` on orders stays rejected, because `verify-storefront` s19a self-orders on purpose to prove the review `distinctFrom`.
- **`categoryAndTime`.** `storeItem.categoryAndTime` gains `skipIfAbsent: ["section"]`. The only reader binds `section ==`, and an item with no section no longer writes null-key entries.

## Blog (topology v5) and Pollr (v4)

These two are grammar-only:

- **Blog** keeps the beta.6 rules: comments off (`commentsOpen` through the `blogPostId` `where`) and the owner gate (`blogId` `where { $ownerId: $ownerId }`).
- **Pollr**'s ballots keep `pollOwnerId` bound through `where { $ownerId: pollOwnerId }`, which feeds the preallocated trees.
- **Both** price in the social contract's YAPP (`tokenCost.contractId`), so they are registered after social.

## Moderation charters: a reason for report handling

On a seated elected contract, every deletion **and every report resolution** must name a `reason` document that its proposal lists (41203). A charter for v10 should therefore list at least:

| Code | Label | Use |
| --- | --- | --- |
| `SPM` | Spam | deletions, bans |
| `ABU` | Abuse | deletions, bans, suspensions |
| `REP` | Report handled | resolving a report (`changeDocumentFields`), purging a spam report |

The election ops script files reasons with `--reasons SPM:Spam,ABU:Abuse,REP:Report handled`. `verify-v10` r2 takes the listed reason with `--reason-doc`.

## Tooling

- **`scripts/validate-contract-offline.mjs`** parses through both the wasm-sdk and `@dashevo/wasm-dpp2` (a devDependency: the same parser with rs-dpp's `validation` feature). `--cost` prints `documentCreateCost` per type. The `SOCIAL_CONTRACT_ID` stand-in is no longer the contract's own id, which wasm-dpp2 refuses as a redundant token `contractId`.
- **`scripts/contract-probes.mjs`**:
  - `auditNodeRules` reads `moderatorAbilities` and `findBy`;
  - it checks `changeDocumentFields` both ways (10900) and both sides of a same-contract `where` (40126);
  - it gains `auditIndexShapes`, the port of the v10 study's `index-audit.py` (10205, 10206, 10208, 10209, and the 10-index limit);
  - the probes move to v10 and record a third layer (`dpp2`: refused only by wasm-dpp2);
  - the beta.6 v9 file is recorded as refused on beta.7.
- **`scripts/property-constraint-cases.mjs`**: the v10 rules (no tombstone rule; report `resolvedHasStatus`) and storefront `storeIsOpen`.
- **`lib/contract-topology.ts`**:
  - `v10` joins `v2` and `v9`, and every client change gates on it;
  - the contract-derived numbers (costs, fees, grant, lists, election windows, distinctFrom) read the configured cut's JSON;
  - the new capability helpers are `isV10`, `postsHaveLanguage`, `contentLimits`, `mediaCarriesHashes`, `privateFeedKeyFields`, `dashpayProfileExtension`, `windowedRankingFor` (per axis: doctype, grid, `newest`/`oldest`, label), `moderatorAbilitiesFor`, `moderatorDeletionKeepsRecord`, `reportResolutionFields`/`reportsAreResolved` and `yappIsLocked`.
- **Storefront topology.** `lib/constants.ts` adds `v5` (`storefrontOrdersCarryStoreStatus`).
- **Batteries.**
  - `scripts/verify-v10.mjs` replaces verify-v9. It keeps e0, d1, p1, b1, w1, m1, m2 and o1–o4, drops the tombstone cases, and adds x1 (deletes and 40120), x2 (media 10101, 10421, no language, the timeline), x3 (the extension and DashPay), c1, r1/r2 (resolve, 41124, 10905, 41123, purge with no record, 41102 on the protected owner), t2 (rolling trending on like) and y1 (YAPP transfer 40711, purchase 40721, a paid post, the grant). It also carries verify-v8's a1–a4 (40132; a2's under-declared moderators part is a refused charter discount, 40139, while fixed pricing or a larger part is 40133; the derived id and pot growth; 41111), s1 (41108) and k1/k2 (credits vs YAPP with sponsored gas, 40700), since verify-v8 needs a v9 chain.
  - `verify-storefront` adds s21 (D-25).
  - The blog, storefront and pollr self-tests assert `where`.
- **Registration.** `register-social-v3-draft.mjs` defaults to v10 and funds bots by owner **mint** (a transfer is refused on the paused token).
- **Seeder.**
  - v10 shapes: no `language`, no `beat`, 1000/2000 content by code points and bytes, and media hashes fetched once per URL.
  - The provisioner writes a DashPay profile plus `yapprProfile`, and funds YAPP by owner mint (`--yapp-source maker`) or claim then mint (`claim`).
  - `ensureYapp` claims, then mints.
  - The tips seeder refuses v10 (there is nothing to transfer).
  - The non-social personas #200–260 are in `scripts/seed/personas.non-social.json`.

## Publishing on bonsia

The maker is a new identity on bonsia (no moutai lock can be restored), so every id below is new. The order is:

1. social v10 (it registers the contract group);
2. storefront, blog and pollr (with `SOCIAL_CONTRACT_ID` substituted);
3. DM v4, DM v5, key backup, key exchange, vault and auth vault.

Before social, check that `contracts.fetch(Bwr4WHCP…)` returns DashPay v2 with its unique `ownerId` index: the `yapprProfile` `findBy` is resolved at registration (40137 otherwise).

After social, run the YAPP sanity check (`verify-v10 --only y1`). Then set these in `.env.devnet`:

- `NEXT_PUBLIC_CONTRACT_TOPOLOGY=v10`
- `NEXT_PUBLIC_STOREFRONT_TOPOLOGY=v5`
- `NEXT_PUBLIC_BLOG_TOPOLOGY=v5`
- `NEXT_PUBLIC_POLLR_TOPOLOGY=v4`

Then add DashPay to the bundled devnet contracts.
