# Platform 4.2.0-beta.5: document TTL, richer propertyConstraints, contests before epoch 4

Investigation date: 2026-09-27. This document covers the beta.4 → beta.5 range
only; everything earlier is in [`PLATFORM_BETA4_UPGRADE.md`](./PLATFORM_BETA4_UPGRADE.md).
It is the record of **PR A** (`beta5/sdk`): the SDK pin, the new consensus
errors, the proof that the hand-built create still decodes under the stricter
beta.5 decoder, the DPNS contest-fund change, and an offline validation of every
contract in `contracts/`. The contract re-cut (branch `beta5/contracts`) and the
devnet deployment are separate work (see the end).

## Versions and scope

| Release | Commit | Changes reviewed |
| --- | --- | --- |
| `v4.2.0-beta.4` | `6c95cd8b162750412e1f924655820edf8cf3c29e` | Starting point; see the beta.4 document. |
| `v4.2.0-beta.5` | `5c79d12dfcf44f0ab1100d703ff48134ee8c6ce3` | 44 non-merge commits. Protocol version remains **14** (`LATEST_VERSION = PROTOCOL_VERSION_14`); every consensus change lands behind it, except #4995, which deletes the epoch-4 gate outright. |

Both `@dashevo/evo-sdk` and `@dashevo/wasm-sdk` are pinned to exactly
`4.2.0-beta.5`. `npm ls @dashevo/wasm-sdk` shows one copy, deduped under
evo-sdk. The JS and wasm SDK surface barely moved: the diff under
`packages/wasm-sdk`, `packages/js-evo-sdk` and `packages/wasm-dpp2` is 69
insertions and 11 deletions.
It adds `contestFund` to `DocumentCreateOptions` and `DpnsRegisterNameOptions`,
rewrites a doc comment, and extends the propertyConstraints section of the
README. Beyond the version string, the shapes Yappr uses did not change.

**The wasm-sdk package is not on npm.** The platform release job (run
36307355937) published `@dashevo/evo-sdk@4.2.0-beta.5` and then failed with
`ENEEDAUTH` before publishing `@dashevo/wasm-sdk@4.2.0-beta.5`. evo-sdk depends
on that exact version, so `npm ci` cannot install the lockfile until the wasm-sdk
package is published. The lockfile is written as it will resolve then:

- both entries use registry `resolved` URLs;
- each `integrity` is the sha512 of the CI-built release tarball;
- the evo-sdk tarball's sha1 (`ab04b414…`) and sha512 match what npm serves;
- the wasm-sdk sha512 (`TK4aNISV…`) is that of the CI artifact that was never
  published. If the re-run publish builds a different tarball, regenerate the
  lockfile.

For local work, install the artifacts with
`npm install --no-save <evo tarball> <wasm tarball>`, which leaves
`package-lock.json` untouched.

**Moutai was wiped for beta.5.** It runs no Yappr contracts now. This PR
broadcasts nothing and was validated offline only (see "Local validation").

## What changed, grouped

| Group | Commits | Effect on Yappr |
| --- | --- | --- |
| **Contested documents before epoch 4** | [#4995](https://github.com/dashpay/platform/pull/4995) `2498727049` | The `TARGET_EPOCH_INDEX = 4` gate in `batch/is_allowed` is deleted, for every protocol version. Beta.4 refused any contested create on a fresh network with 10418 ("Contested documents are not allowed until epoch 4. Current epoch is 0"). That blocked contested DPNS names on moutai and **every moderation election** (`electedCharter` prefunds its contest). After the wipe both work from block one. **Unblocks the election test** that the beta.4 deployment could not run before 2026-10-31. 10418 is kept in rs-dpp for decoding, but is **no longer produced**. |
| **Contest pricing** | [#5039](https://github.com/dashpay/platform/pull/5039) `eeed935bd1`, [#5034](https://github.com/dashpay/platform/pull/5034) `5febda158f`, [#5029](https://github.com/dashpay/platform/pull/5029) `f4426b26b3`; related: [#5002](https://github.com/dashpay/platform/pull/5002), [#4996](https://github.com/dashpay/platform/pull/4996) | A contender states the **most** it pays and is **charged the join price**. At protocol 14 the price is 0.1 DASH for DPNS and 0.5 DASH for a moderation election (protocol 12/13, testnet today, charges a flat 0.2 DASH), doubling once a contest holds 250 contenders and again every 50 after that. A contest is capped at 1,000 contenders (40141). A create that states less is refused, paid, with 40114, which names the price. The SDKs read the contender count and state the price unless the caller passes `contestFund`. Not pricing but in the same area: #5002 refuses a masternode vote for an identity that is not a contender (40307), and #4996 deletes an ended poll's end-date entry only once none of its polls remain. **Client: error surfacing only** (below). |
| **Document time to live** | [#5007](https://github.com/dashpay/platform/pull/5007) `39e7850570`, [#5033](https://github.com/dashpay/platform/pull/5033) `7a5751872e` | A document type may declare `ttl` (seconds, 1 hour to 1 year). The platform deletes its documents after `$createdAt + ttl`: at most 128 per block, after the block's transitions. Their storage is priced for the lifetime, not in perpetuity, and deleting them refunds nothing. After expiry, replace, transfer, purchase, repricing and moderator restore are refused, paid, with **40140**. Nothing in Yappr declares it yet. **Client: 40140 classified**, and kept out of `isTimeoutError` (below). **Contract re-cut:** candidates below. |
| **propertyConstraints grammar** | [#5036](https://github.com/dashpay/platform/pull/5036) `8936d447aa` anyOf/allOf/not, [#5037](https://github.com/dashpay/platform/pull/5037) present/absent, [#5038](https://github.com/dashpay/platform/pull/5038) `in`, [#5040](https://github.com/dashpay/platform/pull/5040) boolean operands, [#5042](https://github.com/dashpay/platform/pull/5042) string `const` against an `enum` | Rules can now be conditions, not only integer comparisons. Violations are still 10422, which `isDocumentPropertyRuleError` already matches (the prose `breaks its propertyConstraints rule` did not change). **Contract re-cut:** candidates below. |
| **Stricter decoding** | [#5011](https://github.com/dashpay/platform/pull/5011) `d23f444a20` | At protocol 14, `decode_raw_state_transitions` v1 decodes with `deserialize_from_bytes_untrusted_exact_in_version`. Bytes left over after a transition make it an invalid encoding, 10002 `SerializedObjectParsingError`, unpaid. **Client: proved that the hand-built create is exact** (below); 10002-with-leftover classified as a code defect. |
| **Reference rule refusals** | [#4983](https://github.com/dashpay/platform/pull/4983) `3d7554a195`, [#4982](https://github.com/dashpay/platform/pull/4982) `25e6473d50`, [#4984](https://github.com/dashpay/platform/pull/4984) `9eb59ec75c` | #4983: `immutableAllowSetting` may not name a `deletableDocument` reference by id. #4982: an `immutable` contract reference with an `owner` requirement is refused on a transferable or tradable type, and every replace of such a type re-checks the requirement. #4984: a `$creatorId` key reference is refused **at document write**, not registration, when the document carries no creator id (40125 `ReferencedKeyIdPropertyInvalidError`). #4983 and #4982 are registration refusals. **No committed contract trips any of them** (see "Offline contract validation"). #4983 and #4982 are behind rs-dpp's `validation` feature, which the wasm parse does not run, so `scripts/contract-probes.mjs` now audits them. |
| **Balance and fee accounting** | [#4987](https://github.com/dashpay/platform/pull/4987) `ffd4fb4665`, [#4985](https://github.com/dashpay/platform/pull/4985), [#5013](https://github.com/dashpay/platform/pull/5013), [#5015](https://github.com/dashpay/platform/pull/5015), [#5000](https://github.com/dashpay/platform/pull/5000) | #4987: when one balance was written twice in a batch, the second write clobbered the first. An action fee could therefore lose a purchase price, a contested fund or a sponsored sale. Drive now merges the writes; the v9 post fee plus YAPP payment went through this path. Also: repaid debt is credited to the fee pool; a storage refund is clawed back from the epochs it was priced for (#5013, general storage accounting, not TTL-specific); an evonode's token claim covers only the epochs it read; a mint or direct purchase past `i64::MAX` is refused. **No client change.** |
| **Consensus and infra fixes** | #5010 #5028 vote extensions, #5005 address input limit, #5006 group actions, #5004 #5030 perf, #5001 rs-dapi shielded rate limit, #4964 empty address list | No effect on Yappr. |
| **CI / tooling** | #4562 self-hosted release runners, #4974, PR Hygiene re-pins, #5031 #5032 #5003 #5008 #5009 | No change. #4562 is the release pipeline whose publish step failed. |

## Consensus errors classified

Pinned to the `#[error(...)]` formats in rs-dpp at `v4.2.0-beta.5`. Matching is
prose first, because these arrive as prose with `code = -1`, and otherwise by a
labelled code (`code=40140`, `"code":40140`), never by bare digits. All of them
join `isPermanentProtocol14Error`, so `retryPostCreation` never retries them.

| Code | Error | Matcher | User message |
| --- | --- | --- | --- |
| 40140 | `DocumentExpiredError` | `isDocumentExpiredError` | "This has expired and can no longer be changed. The network removes it shortly." |
| 40114 | `DocumentContestNotPaidForError` (stated less than the price to join) | `isContestFundError`; `contestFundNeededFromError` reads the price | "Joining this contest now costs more than was offered, because others joined first. Try again to pay the current amount." DPNS names the price in DASH. |
| 40141 | `DocumentContestMaximumContendersReachedError` | `isContestFullError` (also in `isContestFundError`) | "…the contest is closed to new entries." |
| 10002 | `SerializedObjectParsingError` whose cause is `… bytes left over after the value` | `isTrailingBytesError` | The code-defect message ("Something went wrong building this action… Please report this."). Only this cause is claimed; any other 10002 is left alone. |
| 10418 | `ContestedDocumentsTemporarilyNotAllowedError` | `isContestedDocumentsNotYetAllowedError` | "This network does not accept contested names yet…" **No longer produced from beta.5.** Matched only for a node that predates it. |

**`isTimeoutError` no longer claims an expiry.** It matched any message
containing `expired`, and treats a match as "the gateway timed out, the write
may have landed". Under that rule a 40140 would have been reported as a
possible success. The same held for the identity-key expiries protocol 14 added
in 4.2.0-beta.1 (20016 `PublicKeyExpiredError`, 40219
`IdentityPublicKeyAlreadyExpiredError`). All three now return false; gateway
phrasings such as "deadline expired" still match. Pinned in
`lib/error-utils.test.ts`.

## The hand-built create decodes exactly

v9 `post` and `reply` creates are still hand-built, because beta.5's
`DocumentCreateOptions` still has no `actionFeeAgreement`. Its fields are
`document`, `identityKey`, `signer`, `tokenPaymentInfo`, `contestFund` and
`settings`, checked against the installed `.d.ts`. Social v9 charges those creates a
moderators fee, so without the agreement they fail with 40132. Only the
lower-level `DocumentCreateTransitionOptions` and `DocumentBaseTransitionOptions`
take one. Indexed-only likes also still need `waitForAffectedState`, which
`documents.create` does not do.

The assembly moved out of `stateTransitionService.createDocument` into
`lib/manual-batch.ts` (`buildSignedCreateTransition`), unchanged, so it can be
tested without an SDK connection. Two proofs that it is exact:

1. **Rust, the node's own decoder.** A v9-shaped post create carrying both
   `$tokenPaymentInfo` (`gasFeesPaidBy: 2`) and `$actionFeeAgreement`
   (80,000,000 moderators, `feeMultiplier`) was built by
   `buildSignedCreateTransition` under the beta.5 wasm, then decoded by a
   throwaway harness linking `dpp` at `5c79d12d`:
   ```text
   StateTransition::deserialize_from_bytes_untrusted_exact_in_version(bytes, PlatformVersion::get(14))
   exact decode OK: 321 bytes, re-encoded 321 bytes, identical: true
   type: "DocumentsBatch([Create])"
   padded by 1 byte refused: platform deserialization error: unable to deserialize
     dpp::state_transition::StateTransition: 1 bytes left over after the value
   ```
   That last line is the `ProtocolError`'s own display. A node wraps only the
   inner message, so a client sees "Parsing of serialized object failed due to:
   unable to deserialize dpp::state_transition::StateTransition: 1 bytes left
   over after the value" (`decode_raw_state_transitions/v1`), which is what
   `isTrailingBytesError` matches.
   The harness is not in the tree; the command lives in the PR description.
2. **In CI** (`lib/manual-batch.test.ts`). The wasm exposes only the loose
   decoder (`StateTransition.fromBytes` is `deserialize_from_bytes_untrusted`),
   so the test pins a round trip instead: the signed bytes decode and re-encode
   to the same bytes, the same inputs sign the same bytes, and the batch carries
   one create with the agreement and the payment. A last case shows the loose
   decoder accepting a 1-byte suffix and re-encoding shorter. That is the
   difference #5011 refuses, and why a successful decode alone would prove
   nothing.

The ST-byte replay cache stores `stateTransition.toBytes()` and replays it with
`StateTransition.fromBytes`, so it replays exactly the bytes it signed. The
other writes (replace, delete, moderation, DPNS) go through SDK builders.

## DPNS: contested names and the contest fund

Beta.5 changes two things for a contested name (under 20 characters, only
letters, hyphens and the digits 0 and 1):

- **it is accepted on a fresh network** (#4995). On beta.4 moutai, a contested
  registration failed with 10418 until epoch 4.
- **the create states a `contestFund`**, the most it pays. It is charged the
  join price. Leaving it out makes the SDK read the contest's contender count
  and state the current price.

Decision: **keep leaving `contestFund` out.** The SDK reads the price just
before signing and before it reserves a nonce, so a failed read spends nothing.
Stating more than that would only matter if 250 or more others were joining
the same name at the same moment. Stating a fixed figure would be wrong once
a contest passes 250 contenders, and wrong across networks: the base fund is
0.2 DASH under protocol 12/13 (fee version 2, testnet) and 0.1 DASH at protocol
14 (fee version 3). For the same reason the client never hard-codes a price. A comment at the `registerName` call records
this.

What changed:

- `describeDpnsRegistrationError` (`lib/services/dpns-service.ts`) maps the
  failures a registration can now meet, and `registerUsernamesSequentially`
  shows its text on the complete step instead of the raw Drive prose:
  - 40114: "others joined the vote … now costs more (0.2 DASH now) … try
    again";
  - 40141: "closed to new registrations";
  - 40111 `DocumentContestNotJoinableError` (the contest opened longer ago than
    its join window): "running too long to join", via `isContestNotJoinableError`;
  - 10418: "not accepted yet; pick a non-contested name";
  - `Insufficient identity … balance`: says a contested name also pays a
    contest fund, with no figure.
- The review step's contested warning and tooltip now say that entering the
  vote pays a contest fund from the identity's credits, priced by the network
  just before signing. Previously the wizard never mentioned a cost.

The moderation election path is not built in the client yet. When it is, its
charter create goes through the same `contestFund` rule (0.5 DASH base), and the
40114/40141 matchers already apply.

## Offline contract validation

`node scripts/validate-contract-offline.mjs <file>` checks each file with the
wasm full-validation parse, `auditNodeRules`, the vendored JSON meta-schema and
the create-transition size. It was run against the beta.5 wasm. The vendored
meta-schema was updated to the beta.5 copy (sha256 `a19c151a…`), which adds
`ttl` and the new propertyConstraints grammar. Every file was also run on the
beta.4 wasm with the beta.4 meta-schema as a baseline, and **every outcome is
identical**: beta.5 introduced no new refusal for any committed contract.

| Contract | beta.5 | Create size | Notes |
| --- | --- | ---: | --- |
| `yappr-social-contract-v9.json` | **OK** | 16,972 B | The live moutai cut. `immutableAllowSetting: ["deleted"]` on post/reply names a boolean, not a reference, so #4983 does not apply. No contract reference, so #4982 does not apply. |
| `yappr-profile-contract.json` | **OK** | 1,624 B | |
| `yappr-storefront-contract.json` | **OK** | 14,285 B | |
| `yappr-blog-contract.json` | **OK** | 6,138 B | `blogPost.immutableAllowSetting: ["publishedAt"]` is an integer, not the deletable `blogId`, so #4983 does not apply. |
| `yappr-dm-contract.json` | **OK** | 2,738 B | |
| `yappr-dm-contract-v5.json` | **OK** | 3,674 B | |
| `pollr-contract.json` | **OK** | 5,625 B | |
| `key-exchange-v2.json` | **OK** | 1,459 B | |
| `yappr-vault-contract.json` | meta-schema | 710 B | Legacy doctype keyword `mutable` (now `documentsMutable`). The wasm parse accepts it. |
| `yappr-auth-vault-contract.json` | meta-schema | 2,215 B | Same `mutable` keyword, on `authVault` and `authVaultAccess`. |
| `encrypted-key-backup-contract.json` | meta-schema | 1,002 B | Same `mutable` keyword. |
| `yappr-block-contract.json` | meta-schema | 1,868 B | Legacy (merged into social). Same `mutable` keyword. |
| `yappr-hashtag-contract.json` | meta-schema | 1,030 B | Legacy (merged into social). Same `mutable` keyword. |
| `yappr-mention-contract.json` | meta-schema | 1,110 B | Legacy (merged into social). Same `mutable` keyword. |
| `yappr-social-contract-v2.json` | wasm refuses | — | Testnet cut; its token uses the pre-4.0.0-beta.4 `"ContractOwner"` action-taker shape. It was registered at an older protocol and is never re-registered. |
| `yappr-minimal.json` | wasm refuses | — | A scratch file whose schemas are not objects; not a contract. |

The six "meta-schema" rows are old exports with a per-type `mutable` keyword.
The v3 meta-schema would refuse that keyword **if one of these files were
registered as is**, and that was already true on beta.4. Nothing registers them
as is:

- `scripts/register-feature-contracts.mjs` re-registers the vault, auth vault
  and key backup on a devnet by cloning testnet's on-chain schemas, which the
  chain already returns in the canonical `documentsMutable` form;
- `register-test-contracts.mjs` documents exactly this trap;
- the block, hashtag and mention files are legacy.

If a contracts agent ever registers one of these three from the file, it must
first rename `mutable` to `documentsMutable`. This PR does not touch contract
JSON.

`node scripts/validate-contract-offline.mjs --probes` runs 43 probes, all
passing. 15 are new for beta.5 and record where each new rule is enforced:

| Probe | Refused by |
| --- | --- |
| `immutableAllowSetting` on a deletableDocument reference (#4983) | **node only**: the wasm parse accepts it, and `auditNodeRules` now flags it. Only a whole-target by-id reference counts, as in rs-dpp; a by-id deletableDocument inside `anyOf` is refused by the parse anyway (probe) |
| immutable contract reference with an `owner` requirement on a transferable type (#4982) | **node only**: `auditNodeRules` now flags it |
| `ttl` on the target of a `permanentDocument` gate (privateFeedState) | **node only** (40122): a `ttl` makes its type deletable, and `auditNodeRules`' deletability check now counts it |
| `ttl` without `$createdAt` required, on an indexOnly type, of 0, of 60 s, with `documentsKeepHistory` | wasm parse |
| a by-id deletableDocument, or a contract reference with an `owner` requirement on a transferable type, inside an `immutable` object (nested paths) | **node only**: `auditNodeRules` now walks object properties, as rs-dpp's `flattened_properties` does |
| propertyConstraints `const` outside the `enum`; `anyOf` directly inside `anyOf` | wasm parse |
| `ttl` of one day on `savedAddress`; `anyOf` of `notEqual const` / `absent` / `equal` on `storeItem` | accepted (controls) |

## What the contract re-cut should adopt (`beta5/contracts`)

**Document TTL (#5007/#5033).** The rules: `$createdAt` must be required; a ttl
cannot combine with `indexOnly`, `documentsKeepHistory` or a contested index;
it runs from 3,600 s to 31,536,000 s; and it cannot be added or changed on an
existing type by an update. A type with a `ttl` counts as deletable, so a
`permanentDocument` reference (lookups included) and a `listElement` reference
may not target it, while a `deletableDocument` reference may. Candidates, in
order of value:

- **`loginKeyResponse`** (key exchange). The QR-login response only matters for
  minutes. A 1-hour `ttl` is the floor. It must add `$createdAt` to `required`.
  The dropped beta.2 idea (indexOnly + TTL) was a `timeRange` index TTL, which
  keeps the document. This is the real deletion, and the storage is priced for
  one hour: 1 credit per byte, against 27,000 for perpetual storage.
  Its unique `byOwnerAndContract` index keeps the value until cleanup runs. A
  second login inside the hour therefore still needs the existing
  delete-or-replace path.
- **`followRequest`** (social) and **`orderStatusUpdate`** / **`savedAddress`**
  (storefront) are worth a look, but check the references first.
  `privateFeedGrant.recipientId` reaches `followRequest` through a
  **deletableDocument lookup**, which a ttl type accepts. A permanent reference
  anywhere into a candidate rules it out (40122 at registration). The probes
  report this.
- **Not** posts, replies, profiles, the DM v5 invite or state types, or
  anything a `permanentDocument` reference or a count/sum tree the UI treats as
  lifetime relies on.

**propertyConstraints (#5036–#5042).** Now expressible:

- `storeItem`: `status == "sold_out"` ⇒ `stockQuantity` absent or 0. This is an
  `anyOf` of `notEqual const`, `absent` and `equal`, and is the control probe
  above.
- `store`: `status == "closed"` ⇒ some closing field `present`.
- `post`: exactly one of `quotedPostId` / `quotedReplyId`, as
  `not allOf present present`.
- An `encryptedContent` ⇔ `nonce` ⇔ `epoch` all-or-none rule on post/reply,
  which replaces a client-side invariant.
- `in` for small integer enums (tiers, ratings).

Each rule is at most 32 nodes, with at most 16 rules per type. A violation is
the 10422 the client already words as "doesn't allow this combination".

**Contested documents before epoch 4 (#4995).** Nothing to cut. It lets the
election cases the beta.4 deployment could not run go ahead right after the
v9 re-registration:

- e0 with a seated charter;
- 41101, 41203, 41102 and 41202;
- the interim pot claim, 41113.

The charter must state a `contestFund` of at least 0.5 DASH, or leave it out.
Leaving it out only works for creates the **SDK** builds: rs-sdk's
`contest_fund.rs` reads the contender count and fills the prefunded voting
balance in. The hand-built `buildSignedCreateTransition` (`lib/manual-batch.ts`)
has no fund field and sets no prefunded voting balance, so it would be refused
(40114, stated 0). A charter or any other contested create must therefore go
through `sdk.documents.create` (or `sdk.dpns.registerName`), or the manual
path must gain a fund field first.
With `voteWindow`/`joinWindow` of one day each (v9), a run takes at least a day.
A single applicant wins when its join window closes, without a vote (book,
`data-model/contested-documents.md`, "Moderation elections").

## JS API compatibility

`npx tsc --noEmit` passes against the beta.5 typings. Only one source change
touches the API: the manual-batch extraction, which calls exactly the same
constructors. Every SDK call in `lib/` and `scripts/` was already checked
against beta.4. The beta.5 `.d.ts` adds only `contestFund` (optional) and
changes doc comments.

## What is NOT in this PR

- Contract JSON edits: adopting TTL and the new propertyConstraints. Branch
  `beta5/contracts`.
- `.env.devnet` / `.env.testing` and moutai registration. That is the ops
  branch, after the wipe.
- The election client (charters, join requests, voting UI).
- A `contestFund` cap chosen by the user. Not needed while the SDK prices the
  join itself.
- Refusing work locally for an expired document. The client builds nothing
  against an expired document today, because no Yappr type declares a `ttl`.

## Local validation

On `beta5/sdk`, with the beta.5 tarballs installed `--no-save`:

- `npm ls @dashevo/wasm-sdk`: one copy, `4.2.0-beta.5`, deduped.
- `npm run lint`, `npx tsc --noEmit` and `npm run lint:dead` (knip) are clean.
- `npm run test`: 100 files and 1,074 tests pass. The new ones are
  `lib/manual-batch.test.ts`, the beta.5 cases in `lib/error-utils.test.ts`,
  and `describeDpnsRegistrationError` in `lib/services/dpns-service.test.ts`.
- `npm run build`: the static export succeeds.
- Every contract through `validate-contract-offline.mjs`, and `--probes`
  (43/43); the results are in the table above.
- These pass: `run-seeder.mjs --self-test`,
  `verify-{v8,v9,blog,dm,dm-v5,storefront,tips,pollr}.mjs --self-test`, and
  `verify-refersto.mjs --dry-run`.

**Not verified until the re-cut contracts are on moutai:**

- that a beta.5 node accepts a create signed by the manual path. The bytes are
  proven exact, but no node has seen them;
- that 40140, 40114 and 40141 render with the texts the matchers expect;
- that a contested DPNS registration without `contestFund` is charged the
  protocol-14 base fund (0.1 DASH) on a fresh devnet.

## Deployment evidence

Observed on moutai on 2026-09-27 and 2026-09-28, running drive/dapi `4.2.0-beta.5`,
Tenderdash 1.8.1 and protocol 14. The Platform state was wiped for beta.5 and the
Core chain persisted. `/devnet` has served these contracts since staging
`6b08e29c` (#578).

This section closes the "Not verified until the re-cut contracts are on moutai"
list above:

- a beta.5 node accepted the manual-path create (gate 1, below);
- the propertyConstraints refusals render with the texts the matchers expect
  (19 live refusals, below);
- the contest fund is charged on a moderation election (below).

A contested DPNS name was not registered.

### Identities and the eleven ids

All 162 identities were rebuilt from their retained Core asset locks, using ChainLock
proofs, and every one kept its original id:

- the maker, CI and the personal account;
- 100 corpus personas;
- 48 non-social personas;
- 3 battery bots;
- 8 DM v5 e2e bots.

An independent read-back matched every on-chain key set against the retained key
material, with 0 problems.

Maker nonces were used up before publishing, so that no new contract could collide with
an old id. Nonces 1–42 reproduce every beta.1–beta.4 contract id, and all 42 were
burned with credit transfers. Publication therefore started at nonce **43**.

Eleven contracts went out from nonces 43–53 into ONE group,
`4rod8XnbrihaSaXaRvCS1EZp6wkoBRBK2i18JkFUKCNR`, registered on the social create. Every
id equals the pre-computed plan. The sources are `contracts/` at `beta5/contracts`
429da9df (#577), pinned by sha256. Key backup, key exchange, vault and auth vault use the
testnet-snapshot schemas, as on beta.1–beta.4.

| nonce | contract | id |
| ---: | --- | --- |
| 43 | social v9 (elected moderation, interim contractOwner, ownerProtected) | `HCAoKyuAbQ63cg6LU44F1Wz2wwqBR2iFybwJk58G9dsa` |
| 44 | profile v2 | `oGoDQZCNByNqxXd7rVorwrwN5k5o4QxAYyW3ZK4ujK7` |
| 45 | key backup | `4REjm1twafAsHyjVgX1Fh6YqNyScoUJQxJa9cz6CfDMK` |
| 46 | key exchange | `83MxtqJX5MrK8c1HLi42EHSp4SxbpxCfeTbhgc8Azd9s` |
| 47 | vault | `AXcTG5LYuSiCABzEU1UY8Fytr6L4nFiuiBMFb8Mkt1qo` |
| 48 | auth vault | `GmcHNydsRJLpiqKExP6omTkFz2Y9HUCaQCE82dFQFrH4` |
| 49 | storefront v4 (appointed: personal + maker) | `6YAiMU17xCDWt3aDrj6M5SivLMdhUvTQQEYRUYdfFhcy` |
| 50 | blog v4 (appointed: personal + maker) | `B5DRanUCmZMCdJqZTXTwaPh2yGyHjub1CfJYmdVcjakw` |
| 51 | DM v4 (legacy threads) | `9X6NtW6qNgKkjCu575k4TAYqf2Y5ck3jaMy6vHoPGcCz` |
| 52 | pollr v4 | `GnrJoaUiSfgstNfjZQ9LX1TfkmhMrc3gNoSE1aidXNpS` |
| 53 | DM v5 | `GK6JTyLCmKvkSFNnYcGGMsdhNmbVFHVLMMVKhsfwpAop` |

**Before broadcasting.** Each stage ran twice as a dry run:

- unsigned;
- signed with the real maker key and not broadcast.

Every signed transition was decoded again and had to re-encode to exactly the same
bytes, because #5011 refuses trailing bytes. Social v9 is 18,341 B signed, under the
20,480 B cap.

**Registration cost.** 340.0e9 registration plus 1.59e9 storage. That is exactly the
protocol-14 schedule: beta.5 did not change registration fees.

**Read-back.** A fresh connection that signs nothing scored **375 checks, 0 failures**.
It covered:

- every id against `generateId(maker, planned nonce)`;
- the group against `contractGroupId(maker, 43)`;
- the pinned sha256 of every source;
- the elected declaration: interim `contractOwner`, `ownerProtected`, windows of 86,400 s,
  `maxAddedModerators` 10;
- every `propertyConstraints` rule name, per document type;
- that no type declares `ttl`;
- **byte equality**, described next.

The chain stamps `createdAt`, `createdAtBlockHeight` and `createdAtEpoch` on each
contract, which adds 13 B. With only those removed, each on-chain contract serializes
to exactly the bytes of its pinned file.

YAPP `BEJDfLzrhu6HHZ48isHgf2a837Epry1ESuzNhHMDZFYV` is priced at 1,000,000 credits per
token, with a 100-token minimum. All 148 seed-ledger personas, CI and personal hold the
once-per-identity grant, and a second claim is refused with 40722.

**Gate 1 passed on the manual path.** `verify-v8.mjs --only a3` against v9 showed:

- a post carrying `$actionFeeAgreement`, built by the hand-built batch, landed;
- Platform stored exactly the id derived locally (`2efWkW6K…`);
- the moderators pot grew by exactly 80,000,000 for the post and 16,000,000 for the
  reply, at 1000‰.

### Corpus

18,000 operations were replayed with pipeline window 8, concurrency 20 and
`SEED_RECONCILE_MS=5000`. `--topology` is gone from staging; the seeder is v9-only. The
folded journal holds **exactly 18,000 `done`, with no unresolved failures**.

The first pass completed 17,674 operations in 5,709 s (3.1 ops/s), plus a 300-op probe.
It consumed 726.9e9 persona credits and 55,351 YAPP. Its failures, all of which landed on
the resume:

- **Dependency waits.** Late-like dependency waits timed out on lines 8566, 7236, 10456,
  10805, 11883, 12781, 16965 and 17882: the same lines as on beta.3 and beta.4.
- **A deliberate election ban.** Two follows by persona 55 were refused ("is banned on
  contract") while the election test's owner-ban control held; the owner then unbanned
  it.
- **An emptied account.** Persona 96, which owns the throwaway election contract, ran out
  of credits (`Insufficient identity balance`) and was topped up from CI.

`ops/verify-count-trees.mjs` ran 8 probes with 0 failures:

- `post.byOwner` = 135 and `follow.followerCount` = 54 for corpus persona 0, the same as
  on beta.2–beta.4;
- the like and beat ranked and windowed axes all answered.

After the writer stopped, a fresh read-only audit re-proved every operation with
`queryWithProof` and `countWithProof`. It used batches of 10, because the DAPI proxy
still truncates large proved responses (*"missing grpc-status trailer … possible
truncation by a proxy"*), and quorum rotations were absorbed by reconnects. It proved
**18,000 / 18,000 operations** and **2,905 / 2,905 beat companions**, the same as
beta.4, against the recorded corpus hash.

The censuses:

- **Posts:** every one of the 5,968 journaled posts is present.
- **Replies:** a primary-index walk found every one of the 2,144 journaled replies. The
  network holds 2,156 replies in all.

The censuses also found writes the seeder did not make:

- 30 posts and 8 replies were made under seven corpus personas (#65, #66, #67, #70, #71,
  #73, #86) between 02:37Z and 02:43Z;
- their content looks like QA fixtures ("🔒", "S3QA-… public teaser line");
- the census therefore requires every journaled id to be present, and records extras
  rather than failing on them.

**The contract still decides who pays.** The maker went from 4,299.7e9 credits at nonce
42 to **2,309.7e9** at nonce 53, a spend of 1,990.0e9. That covers:

- 341.6e9 of registration;
- the gas the contract sponsors on YAPP-paying operations;
- the moderators fee on those posts and replies.

The moderators pot stands at **514,944,000,000** and has not been claimed: claiming it as
the interim moderator is a pre-seat case that the election exercises.

### Non-social seeders

| seeder | result |
| --- | --- |
| storefront v4 | 221 created, 2 already present, 0 failed; seeder checks pass |
| blog v4 | 167 created, 0 failed |
| DM (legacy v4 contract) | 12 conversations, 246 messages; newest decrypted 12/12 (the first attempt was rate-limited by DAPI; the retry is clean) |
| pollr v4 | 181 created, 153 ballots; every poll embedded and tallying |
| tips | 120/120 tips confirmed, 851 YAPP moved |

### Batteries

| battery | beta.4 | beta.5 |
| --- | ---: | ---: |
| gate 1, `verify-v8.mjs --only a3` on v9 | 5 / 0 | **5 / 0** |
| `verify-v9.mjs --moderator maker` (e0 d1 p1 b1 w1 m1 m2 o1–o3 f1–f3 **c1**) | 40 / 0 | **77 / 0** (c1 10/10) |
| `verify-blog.mjs` (+**b19**) | 67 / 0 | **69 / 0** (b19 2/2) |
| `verify-storefront.mjs` (+**s20**) | 91 / 0 | **96 / 0** (s20 5/5) |
| `verify-pollr.mjs` (+**p12**) | 39 / 0 | **41 / 0** (p12 2/2) |
| `verify-dm.mjs` (DM v4) | 31 / 0 | **31 / 0** |
| `verify-dm-v5.mjs` | 106 / 0 | **106 / 0** |
| `verify-tips.mjs` | 28 / 0 | **28 / 0** |
| count trees | 8 / 0 | **8 / 0** |

`verify-v9` has more checks than on beta.4 because staging's battery carries the o1–o3
and f1–f3 cases from v7, plus the new c1.

**The propertyConstraints refusals arrive with no number.** The 19 live refusals
(c1 10, s20 5, b19 2, p12 2) each reached the SDK as a
`WasmSdkError { name: 'Protocol', code: -1 }` whose only text is the rs-dpp Display:

> A document of type "blogPost" breaks its propertyConstraints rule "chunksContiguous": it does not hold

`isDocumentPropertyRuleError` matches the prose, so the client is unaffected. The
batteries' matcher had also required the digits `10422` and scored the first live b19
run 67/2. It now matches the quoted rule name followed by its colon (#577, d7c6a9d4),
which is still exact per rule. Every refusal names exactly the rule its case targets.

### Election (contested documents before epoch 4, #4995)

The beta.4 block is gone: `electedCharter` creates are accepted at epoch 0, and every
election filed below was accepted.

- An `electedCharter` goes through `sdk.documents.create` with `contestFund`
  50,000,000,000. The hand-built batch has no fund field.
- The applicant is charged the 0.5 DASH join price plus the fee, e.g. 50,084,406,580
  credits.
- The poll's index value is stored as `Value::Identifier` (tag `0x10`). A vote-state
  query keyed by the base58 string reaches it.

**E1, social v9, one applicant, no votes.**

- The leader is tess1999 (#5). The charter is `D27ycPTGTp6W8rPJX3CtUygzdsCNKWNUnc9DvCAhkFuK`:
  moderators share 60, split 40/30/30, listing reasons SPM and ABU.
- Join requests were filed by #0, #1 and #2.
- The apply, `electedCharter` `BxABe8dZEfYJenExHiQnEP8iGtNi2pKtCcuo7SRhXziJ` with members
  [#0, #1], was accepted at 2026-09-28T00:50:45Z.
- **The contest ends 2026-09-29T00:50:47Z**; the seat goes to the only contender at the
  first block after that.

Checks made before the seat:

- **1.3:** a post agreeing to a 48M moderators fee was refused with 40139 — *"declares a
  moderators fee of 80000000 credits; the transition agreed to 48000000, which is not
  discounted: the contract has no seated moderation charter"*.
- **1.5:** the interim owner's ban was accepted, as the control. The banned persona's
  corpus writes were refused with 41107, and the owner then unbanned it.
- An unlisted reason, OFF, is filed and ready for 1.8.
- The moderators pot was deliberately left unclaimed; step 1.7 needs it.

**E2, a throwaway elected contract, two applicants, with votes.** The contract is
`6JhsWSVb2WywzQsy292XQvb7VyaxcAmwqGe1MSsTZE7f`.

- A (#27) applied at 00:57:13Z, and B (#11) at 01:30:29Z. B's application moved the end to
  **2026-09-30T00:57:13Z**, i.e. join plus vote window, as designed.
- Masternode votes were B from nodes 1–7, A from nodes 8–10, and abstain from 11–12. The
  tally reads **B 28, A 12, abstain 8** (evonode weight 4).
- Node 1 repeating its vote was refused with 40304 (*"Masternode vote is already
  present…"*). Switching to A and back to B both landed.
- The earliest contender is A, so an award to B will show that the votes decided.

Two findings on the vote path:

1. **The facade refuses an `Identifier` object as `masternodeProTxHash`.**
   `sdk.voting.masternodeVote` fails before signing with *"Invalid identifier. Expected
   Identifier, Uint8Array, array or string"*. The same 32 bytes passed as a base58
   string are accepted. The facade also resolves `undefined` either way, so each vote was
   proved by the voter's identity nonce advancing.
2. **A Lock vote on this no-locking poll never surfaced a refusal.** The plan expects
   40307. Instead the transition sat in the mempool cache: *"tx already exists in
   cache"* on rebroadcast, the voter nonce stayed at 0, and waiting on the hash timed out.
   It was not counted.

Still open, as their windows allow:

- E1 1.6–1.16 after 2026-09-29T00:50:47Z: the seated team, 41101/41113/41203/41102, the
  discount, add/remove/resign, and the claim split;
- E2 2.6, the late applicant (40111), after 2026-09-29T00:57:13Z;
- E2 2.7–2.9, the award to B, 40105 and 41101, after 2026-09-30T00:57:13Z.
