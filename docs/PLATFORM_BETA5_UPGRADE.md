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
`packages/wasm-sdk`, `packages/js-evo-sdk` and `packages/wasm-dpp2` is 69 lines.
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
| **Contest pricing** | [#5039](https://github.com/dashpay/platform/pull/5039) `eeed935bd1`, [#5034](https://github.com/dashpay/platform/pull/5034) `5febda158f`, [#5029](https://github.com/dashpay/platform/pull/5029) `f4426b26b3`, [#5002](https://github.com/dashpay/platform/pull/5002), [#4996](https://github.com/dashpay/platform/pull/4996) | A contender states the **most** it pays and is **charged the join price**. The price is 0.1 DASH for DPNS and 0.5 DASH for a moderation election, doubling once a contest holds 250 contenders and again every 50 after that. A contest is capped at 1,000 contenders (40141). A create that states less is refused, paid, with 40114, which names the price. The SDKs read the contender count and state the price unless the caller passes `contestFund`. **Client: error surfacing only** (below). |
| **Document time to live** | [#5007](https://github.com/dashpay/platform/pull/5007) `39e7850570`, [#5033](https://github.com/dashpay/platform/pull/5033) `7a5751872e`, [#5013](https://github.com/dashpay/platform/pull/5013) | A document type may declare `ttl` (seconds, 1 hour to 1 year). The platform deletes its documents after `$createdAt + ttl`: at most 128 per block, after the block's transitions. Their storage is priced for the lifetime, not in perpetuity, and deleting them refunds nothing. After expiry, replace, transfer, purchase, repricing and moderator restore are refused, paid, with **40140**. Nothing in Yappr declares it yet. **Client: 40140 classified**, and kept out of `isTimeoutError` (below). **Contract re-cut:** candidates below. |
| **propertyConstraints grammar** | [#5036](https://github.com/dashpay/platform/pull/5036) `8936d447aa` anyOf/allOf/not, [#5037](https://github.com/dashpay/platform/pull/5037) present/absent, [#5038](https://github.com/dashpay/platform/pull/5038) `in`, [#5040](https://github.com/dashpay/platform/pull/5040) boolean operands, [#5042](https://github.com/dashpay/platform/pull/5042) string `const` against an `enum` | Rules can now be conditions, not only integer comparisons. Violations are still 10422, which `isDocumentPropertyRuleError` already matches (the prose `breaks its propertyConstraints rule` did not change). **Contract re-cut:** candidates below. |
| **Stricter decoding** | [#5011](https://github.com/dashpay/platform/pull/5011) `d23f444a20` | At protocol 14, `decode_raw_state_transitions` v1 decodes with `deserialize_from_bytes_untrusted_exact_in_version`. Bytes left over after a transition make it an invalid encoding, 10002 `SerializedObjectParsingError`, unpaid. **Client: proved that the hand-built create is exact** (below); 10002-with-leftover classified as a code defect. |
| **Registration refusals** | [#4983](https://github.com/dashpay/platform/pull/4983) `3d7554a195`, [#4982](https://github.com/dashpay/platform/pull/4982) `25e6473d50`, [#4984](https://github.com/dashpay/platform/pull/4984) `9eb59ec75c` | #4983: `immutableAllowSetting` may not name a `deletableDocument` reference by id. #4982: an `immutable` contract reference with an `owner` requirement is refused on a transferable or tradable type, and every replace of such a type re-checks the requirement. #4984: a `$creatorId` key reference is refused on a document without a creator id. **No committed contract trips any of them** (see "Offline contract validation"). #4983 and #4982 are behind rs-dpp's `validation` feature, which the wasm parse does not run, so `scripts/contract-probes.mjs` now audits them. |
| **Balance and fee accounting** | [#4987](https://github.com/dashpay/platform/pull/4987) `ffd4fb4665`, [#4985](https://github.com/dashpay/platform/pull/4985), [#5015](https://github.com/dashpay/platform/pull/5015), [#5000](https://github.com/dashpay/platform/pull/5000) | #4987: when one balance was written twice in a batch, the second write clobbered the first. An action fee could therefore lose a purchase price, a contested fund or a sponsored sale. Drive now merges the writes; the v9 post fee plus YAPP payment went through this path. Also: repaid debt is credited to the fee pool; an evonode's token claim covers only the epochs it read; a mint or direct purchase past `i64::MAX` is refused. **No client change.** |
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
the same name at the same moment. Stating a fixed 0.1 DASH would be wrong once
a contest passes 250 contenders. A comment at the `registerName` call records
this.

What changed:

- `describeDpnsRegistrationError` (`lib/services/dpns-service.ts`) maps the
  failures a registration can now meet, and `registerUsernamesSequentially`
  shows its text on the complete step instead of the raw Drive prose:
  - 40114: "others joined the vote … now costs more (0.2 DASH now) … try
    again";
  - 40141: "closed to new registrations";
  - 10418: "not accepted yet; pick a non-contested name";
  - `Insufficient identity … balance`: names the 0.1 DASH fund.
- The review step's contested warning and tooltip now say that entering the
  vote costs at least 0.1 DASH from the identity's credits. Previously the
  wizard never mentioned a cost.

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

`node scripts/validate-contract-offline.mjs --probes` runs 40 probes, all
passing. 12 are new for beta.5 and record where each new rule is enforced:

| Probe | Refused by |
| --- | --- |
| `immutableAllowSetting` on a deletableDocument reference (#4983) | **node only**: the wasm parse accepts it, and `auditNodeRules` now flags it |
| immutable contract reference with an `owner` requirement on a transferable type (#4982) | **node only**: `auditNodeRules` now flags it |
| `ttl` on the target of a `permanentDocument` gate (privateFeedState) | **node only** (40122): a `ttl` makes its type deletable, and `auditNodeRules`' deletability check now counts it |
| `ttl` without `$createdAt` required, on an indexOnly type, of 0, of 60 s, with `documentsKeepHistory` | wasm parse |
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
  (40/40); the results are in the table above.
- These pass: `run-seeder.mjs --self-test`,
  `verify-{v8,v9,blog,dm,dm-v5,storefront,tips,pollr}.mjs --self-test`, and
  `verify-refersto.mjs --dry-run`.

**Not verified until the re-cut contracts are on moutai:**

- that a beta.5 node accepts a create signed by the manual path. The bytes are
  proven exact, but no node has seen them;
- that 40140, 40114 and 40141 render with the texts the matchers expect;
- that a contested DPNS registration without `contestFund` is charged 0.1 DASH
  on a fresh devnet.
