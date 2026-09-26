# Platform 4.2.0-beta.3: nonce-committed document ids

> **Historical record.** Superseded social cuts, their generators
> (`build-vN-contract.py`) and their batteries (`verify-v4/v5/v7.mjs`) were
> removed from the tree; the files this page names are in git history. The
> live social contracts are v2 (testnet) and v9 (moutai), see
> [`contracts/README.md`](../contracts/README.md).

Investigation date: 2026-09-20. This document covers the beta.2 → beta.3 range
only; everything earlier is in [`PLATFORM_BETA2_UPGRADE.md`](./PLATFORM_BETA2_UPGRADE.md).
It is the record of **PR A** (`beta3/sdk-and-ids`): the SDK pin, the change every
write path needed to keep working on protocol 14 as shipped in beta.3, and the
new consensus errors the app classifies. The contract re-cuts that *adopt* the
new grammar are **PR B** (`beta3/social-v8`, see below), and the devnet
deployment is PR C. Deployment evidence belongs at the end; the release tag alone
does not establish that a network was reset or that a contract was registered.

## Versions and scope

| Release | Commit | Changes reviewed |
| --- | --- | --- |
| `v4.2.0-beta.2` | `d09c15de83c807793f1def85cfc834276166f114` | Starting point; see the beta.2 document. |
| `v4.2.0-beta.3` | `b5a93f5e2b5567487b653e121d2f0683200a6fb1` | 33 non-merge commits. Protocol version remains **14**; the document meta-schema and `generate_document_id` gain new versions behind it. |

Both `@dashevo/evo-sdk` and `@dashevo/wasm-sdk` are pinned to exactly
`4.2.0-beta.3`, and `package-lock.json` resolves a **single** WASM runtime
(`npm ls @dashevo/wasm-sdk` shows one copy, deduped under evo-sdk). The reason
is the same as in the beta.2 document: Yappr imports `@dashevo/wasm-sdk`
directly, so a split between the two packages loads two WASM modules into one
page.

## The 33 commits and what each means for Yappr

| Commit | Change | Effect on Yappr |
| --- | --- | --- |
| [#4859](https://github.com/dashpay/platform/pull/4859) `b924b25de2` | **Document ids commit to the identity contract nonce** (breaking) | **Breaks every manual create.** Fixed in this PR — see the next section. |
| [#4830](https://github.com/dashpay/platform/pull/4830) `c47db15f7c` | **Contract moderation**: a banlist and a suspension list per contract, a moderator set, `ContractUserModeration` state transition (breaking) | New consensus errors 41100–41114 classified here (41107/41108/41114 are the ones a user can hit). Adoption — a moderator set on the social contract — is PR B. |
| [#4849](https://github.com/dashpay/platform/pull/4849) `0afc7a17c8` | A `reason` on bans and suspensions (breaking) | Adds 10903 `ContractModerationReasonTooLong`; only reachable by a moderator client. PR B. |
| [#4857](https://github.com/dashpay/platform/pull/4857) `e24aa8a669` | **Moderators delete documents** of the types that allow it (breaking) | Adds 41115 `DocumentTypeNotDeletableByModerators`. A document type opts in per cut; PR B decides which of `post`/`reply` do. |
| [#4864](https://github.com/dashpay/platform/pull/4864) `4a62bb7c19` | A **window** after a document's last modification for moderators to delete it (breaking) | Adds 41116 `DocumentModerationWindowElapsed`. PR B. |
| [#4860](https://github.com/dashpay/platform/pull/4860) `74317a6750` | **`refersTo: deletableDocument`** — a reference to a document that MAY be deleted (breaking) | Adds 40131 `ReferencedDocumentTypeNotDeletable` (classified here; contract-authoring error). Lets PR B declare references to `canBeDeleted: true` types (likes → posts with moderator delete) that today must be `permanentDocument`. |
| [#4851](https://github.com/dashpay/platform/pull/4851) `508d9908cd` | **Document action fees** paid to the contract owner and moderators, with a fee-claim state transition (breaking) | Adds 10902 and the pot machinery. No live Yappr contract declares `actionFees`; PR B. |
| [#4858](https://github.com/dashpay/platform/pull/4858) `54ed7a03c4` | Document transitions **state the action fee they agree to pay** (breaking) | New optional `actionFeeAgreement` on every document transition; 40132/40133/40134 classified here. The `DocumentCreateTransitionOptions` shape is additive, so the manual create path compiles unchanged. |
| [#4856](https://github.com/dashpay/platform/pull/4856) `1ebf2dfecb` | Record who claimed a **contract fee pot** and when; query and claim pots from the wasm/JS SDKs (breaking) | Adds 41111/41112/41113. Owner tooling for PR B/C; no app change. |
| [#4828](https://github.com/dashpay/platform/pull/4828) `cb9a797e41` | **Optional document token costs** paid in credits when the token payment is left out (breaking) | Today Yappr always attaches `tokenPaymentInfo` for token-priced types, so behaviour is unchanged. PR B may mark the social costs optional so a user without YAPP can still post for credits. |
| [#4826](https://github.com/dashpay/platform/pull/4826) `a1db3644cb` | Let the **contract owner pay the gas** of token-paid document actions (breaking) | Adds 40129/40130/40222, classified here. Sponsorship is declared per document type; PR B. |
| [#4827](https://github.com/dashpay/platform/pull/4827) `cf86db8a56` | **Once-per-identity token distribution** (breaking) | Adds 10829 and 40722 (the latter classified here). A YAPP starter grant is the obvious use; PR B. |
| [#4829](https://github.com/dashpay/platform/pull/4829) `2296067cf7` | Once-per-identity distribution in the mobile example apps | Reference material for the grant claim flow. |
| [#4835](https://github.com/dashpay/platform/pull/4835) `7e43d43c2a` | Mint base supply of tokens added by contract **update** (breaking) | Yappr registers YAPP with the contract, never by update. No change. |
| [#4834](https://github.com/dashpay/platform/pull/4834) `3b06b158df` | Create distribution trees for tokens added by contract update (breaking) | Same; no change. |
| [#4837](https://github.com/dashpay/platform/pull/4837) `fa48a8d4d1` | Bound pre-programmed distribution amounts; queue a shared release-time tree once (breaking) | Adds 10277. YAPP declares no pre-programmed distribution. No change. |
| [#4838](https://github.com/dashpay/platform/pull/4838) `c92a176085` | Carry consensus error codes through the wallet FFI | Mobile SDKs only. |
| [#4855](https://github.com/dashpay/platform/pull/4855) `abd1002d17` | Guard doctype keyword names against stray keys of meta-schema-v0 contracts | Test only; `scripts/validate-contract-offline.mjs` already runs full validation. |
| [#4852](https://github.com/dashpay/platform/pull/4852) `ddc6f61976` | Pin that chained and composite joins prove the absence of a referenced document | Test only; confirms the `refersTo` proof shape Yappr relies on. |
| [#4850](https://github.com/dashpay/platform/pull/4850) `72b58f6073` | Record the Merk shape of layers below a template | Drive internals. |
| [#4848](https://github.com/dashpay/platform/pull/4848) `b1bdff15de` | Describe the element flags of the GroveDB structure | Drive internals. |
| [#4845](https://github.com/dashpay/platform/pull/4845) `38bbd30181` | Describe the GroveDB structure as code | Drive internals. |
| [#4847](https://github.com/dashpay/platform/pull/4847) `d7401e6507` | Check every strategy test's state against the GroveDB structure | Test only. |
| [#4836](https://github.com/dashpay/platform/pull/4836) `8a8cc13e0a` | Pin that a token config update cannot set a perpetual distribution | Test only. |
| [#4843](https://github.com/dashpay/platform/pull/4843) `f737311c8d` | Store the current-key alias for bound encryption/decryption keys under the purpose subtree | Drive fix for bound keys; Yappr's DM keys are identity keys, not bound keys. |
| [#4825](https://github.com/dashpay/platform/pull/4825) `51183be381` | Parse change-control action takers from the `$type` map on iOS | Mobile SDK only. |
| [#4824](https://github.com/dashpay/platform/pull/4824) `9653f148d5` | Parse the `$type` map for the perpetual distribution recipient on iOS | Mobile SDK only. |
| [#4800](https://github.com/dashpay/platform/pull/4800) `5568dfa443` | Persist the contract bounds kind on Android and iOS | Mobile SDK only. |
| [#4823](https://github.com/dashpay/platform/pull/4823) `fa28cc2304` | Swift example app shares a bounded login key with a browser over Bluetooth | Reference for the bounded-key login idea (beta.1 follow-up, still open). |
| [#4846](https://github.com/dashpay/platform/pull/4846) `bd79344d84` | Link the GroveDB structure viewer on structure PRs | Upstream CI only. |
| [#4839](https://github.com/dashpay/platform/pull/4839) `6def2182f1` | PR Hygiene is the merge gate; CODEOWNERS carries no rules | Upstream CI only. |
| [#4861](https://github.com/dashpay/platform/pull/4861) `ad9686a3e0` | Re-pin PR Hygiene for state labels and `/skip-bots` | Upstream CI only. |
| [#4867](https://github.com/dashpay/platform/pull/4867) `b5a93f5e2b` | Release chore | — |

Nothing in this range changes a query shape, a ranked/count/timeRange grammar,
or a proof format. v7's read surface is unchanged, and v7 itself stays valid
under beta.3 — the new grammar is all opt-in. The one thing that is **not**
opt-in is #4859.

## Document ids commit to the identity contract nonce

### What changed

Up to protocol 13 a document's id was `dsha256(contractId ‖ ownerId ‖ typeName ‖ entropy)`
(`generate_document_id_v0`). From protocol 14 as cut in beta.3 it is

```
dsha256("dash:document-id:v1" ‖ contractId(32) ‖ ownerId(32) ‖ typeName(utf8) ‖ entropy(32) ‖ identityContractNonce as u64 big-endian)
```

(`generate_document_id_v1`, `packages/rs-dpp/src/document/generate_document_id.rs`).
Consensus recomputes the id for every create and refuses a mismatch with
`InvalidDocumentTransitionIdError` (basic code 10405). The domain tag makes the
two derivations disjoint: a v0 preimage starts with a contract id, which is a
hash, so no v0 preimage can start with those bytes.

Why: the create check only asks whether a document exists under the id *right
now*, so under v0 the owner of a deleted document could re-create a document
with the same entropy, get the same id back, and everything that referenced the
id (likes, replies, a `refersTo`, a moderation removal record) now pointed at
different content. With the nonce in the id — a nonce is consumed at most once
per identity and contract — an id can be produced at most once. That is the
property the moderation and `deletableDocument` work in the same release
depends on.

Consequences a client lives with (`book/src/data-model/documents.md`,
`book/src/sdk/put-operations.md`):

- The id exists only once the create transition's nonce is assigned, and it
  changes if the transition is rebuilt with another nonce.
- The id a `Document` carries before its transition is built is a
  **placeholder**. rs-dpp's `DocumentCreateTransitionV0::from_document`
  replaces it, so every transition built through rs-sdk carries the right one;
  read the id from the transition or from the confirmed document
  `put_to_platform_and_wait_for_response` returns, not from the document passed in.
- To know ids up front (a chain of documents referencing each other), assign
  the nonces first — nonces may be used out of order within a window of 24.

### What the shipped JS SDK does and does not do

Verified against the installed `@dashevo/wasm-sdk@4.2.0-beta.3`
(`dist/raw/wasm_sdk.d.ts` and the wasm-dpp2 source at the tag):

| Surface | Behaviour on beta.3 |
| --- | --- |
| `sdk.documents.create(...)` (wasm-sdk `documentCreate`) | **Correct.** Goes through rs-sdk's `put_to_platform_and_wait_for_response`, which fetches the nonce, derives the v1 id, and returns the confirmed `Document`. It also `Reflect.set`s the final `id` back onto the caller's JS document — but only after the wait succeeded. |
| `Document.generateId(type, owner, contract, entropy)` | **Still v0.** `wasm-dpp2/src/data_contract/document/model.rs` calls `generate_document_id_v0`; the signature has no nonce parameter. |
| `new Document({...})` without `id` | **Still v0.** Same function. |
| `Document.fromObject({ $id, ... })` | Takes `$id` as given. |
| `new DocumentCreateTransition({ document, identityContractNonce })` | **Copies `document.id` verbatim** (`generators.rs` `generate_create_transition`). It knows the nonce but does not re-derive. |

So the wasm-dpp2 fix #4859 lists as a follow-up has not shipped, and every
create Yappr signs by hand carried a v0 id that beta.3 refuses.

### Yappr's write paths

**Browser (`lib/services/state-transition-service.ts` `createDocument`).** This
is the only browser path that creates documents; every service goes through it
(23 call sites, all via `BaseDocumentService.create`/`createWithOptions` or
directly). It builds the transition by hand for one reason — the ST-byte
replay cache, which makes a timed-out write idempotent by rebroadcasting the
*same signed bytes*. It used to build the `Document` (id from
`Document.generateId`), probe Platform by that id, THEN fetch the nonce. Now:

1. fetch the identity contract nonce and take the next sequence number
   (`nextIdentityContractNonce`, the DIP-30 masking that was inline before);
2. draw 32 bytes of entropy and derive the id in JS —
   `lib/document-id.ts` `deriveDocumentId`, `@noble/hashes` sha256, `TextEncoder`
   for the type name, 8-byte big-endian nonce (**retired in beta.4**: wasm-dpp2
   now derives it, see [`PLATFORM_BETA4_UPGRADE.md`](./PLATFORM_BETA4_UPGRADE.md));
3. build the `Document` with `Document.fromObject` carrying that id and entropy
   (`documentBuilderService.buildDocumentForCreate`, which now REQUIRES
   `{ entropy, identityContractNonce }` — there is no way left to build a
   create document without a nonce-derived id);
4. build the `DocumentCreateTransition` and set the same nonce on the
   `StateTransition`, sign, cache the bytes under the derived id, broadcast, wait.

The ST-byte replay cache is still keyed by the id, which is known before
signing — but be clear about what it buys. A fresh call always derives a fresh
id (fresh entropy and the next nonce), so no caller ever finds its
predecessor's bytes; the cache replays only if a caller re-derives the same
id, and none does. That was equally true before protocol 14, when the id was a
function of fresh entropy alone: the cache was already unreachable, and this
PR corrects the comments in `createDocument` and `retryPostCreation` that
claimed otherwise. The real guard against a double write on a timed-out wait
is the optimistic `confirmed: false` return, which callers surface as "may have
succeeded" rather than retrying. Making the cache reachable needs a
caller-supplied idempotency key to key it by — a separate change.

The pre-create "already exists on Platform" probe by id is **gone**: a document
under a freshly derived id can only exist if this exact signed transition
already landed, which is precisely what the cached-bytes branch checks.

`documentData` may now be a **function of the id**. `createDocument` calls it
once with the derived id and uses that exact nonce for the broadcast, so data
built against the id commits to the id Platform stores. The one user is the
auth vault (`lib/services/auth-vault-service.ts`), which binds the bundle
ciphertext to the vault id as AEAD associated data: it used to precompute the
id with `generateDocumentIdentity` and pass `documentId`/`entropy` through;
both options and that helper are removed, and `decryptVault` keeps reading the
id off the stored `$id`, which is now guaranteed to be the one encrypted
against. If two tabs race the same identity, the loser's transition is refused
on the nonce and returns an error rather than storing a vault whose AAD names a
different id.

**Node seeders and batteries.** These call `sdk.documents.create()`, which is
correct on its own — but every one of them precomputed the id with
`Document.generateId` and trusted it for its `landed()` readbacks, its
resumability keys, companion refs and dry-run output. Under beta.3 that id was
a placeholder, so a landed write would have read back as absent and been written
again. The shared `buildDocument` (in `scripts/seed/seed-lib.mjs`,
`scripts/verify-lib.mjs`, `scripts/verify-refersto.mjs`) now returns `id: null`
for a create unless a `nonce` is given; the two hand-built paths that know the
nonce (`scripts/seed/pipeline.mjs`, `scripts/verify-poll-interop.mjs`) pass it
and get the real id up front; replaces and deletes pass the recorded id as
before. Create paths take the id from the `Document` `create()` returns
(`createdId`) and record it in the same `.seed-*.local.json` checkpoint under
the seeder's logical key, so resumability is unchanged for anything that was
recorded.

The gap is a crash **between broadcast and record**, or a create that threw
after broadcasting (the DAPI 504 quirk): the document landed under an id
nobody client-side knows. The fix per path:

- a doctype with a **unique index** reads back by value as before (profile by
  `$ownerId`; the non-social seeders' `adopt` probes for `blog`, `blogPost`,
  `blogFollow`, `store`);
- an **indexOnly** doctype never had an id to read by; its `existenceKey` probe
  is unchanged;
- a **stored doctype without a unique index** (post, reply) is reconciled by
  `findRecentByValues`: the owner's most recent documents of the type (up to
  100), matched on every written field. The batteries bound the scan to
  documents created since the write began, so a byte-identical fixture from an
  earlier run cannot score a refused write as accepted; the seeders' pre-write
  probe is deliberately unbounded so a resume with a lost checkpoint adopts
  its own earlier document. The residual risks are stated in the helper rather
  than hidden: two identical documents by one author cannot be told apart, so
  a retry after such a throw may write one twice (the seeders already tolerate
  duplicates for like/follow/bookmark/repost); a payload with non-deterministic
  bytes (a DM's fresh AES-GCM IV) is recognisable only within the call that
  built it, so after a lost checkpoint it is written again; and a retried post
  may adopt an OLDER identical post by the same author and hand that id to the
  ops that reference it.

`scripts/seed/seed-lib.mjs` carries a copy of the derivation (the `.mjs`
scripts cannot import the TypeScript module), and `run-seeder.mjs --self-test`
pins it to the same rs-dpp vector as the browser copy. `verify-v4.mjs` and
`verify-v5.mjs` are frozen historical records and are untouched; their v0
`Document.generateId` is correct for the protocol they ran against.

### The pinned vector

rs-dpp's `should_pin_the_nonce_derived_id` fixes the preimage layout as
consensus: contract `[1u8; 32]`, owner `[2u8; 32]`, type `"note"`, entropy
`[7u8; 32]`, nonce `1` →
`e574ae73396611a517691d1f89275b6e99642cb9c176ce8cf879b1665c50f15f`.
`lib/document-id.test.ts` and the seeder self-test both assert it, and both
were confirmed to fail when the domain tag or the nonce width is changed. The
v0 id for the same inputs (`c9d161a8…dcdee8`) is asserted *not* to match, so a
regression back to `Document.generateId` is caught.

## Consensus errors classified

`lib/error-utils.ts` gains matchers for the beta.3 codes the app can hit on
beta.3 with the **current v7 contract** — either because they are reachable
through the manual create path, or because a moderator or the network can put
the user in that state without a contract change. Each is pinned to the
`#[error(...)]` format in rs-dpp and to the labelled-code form (`code=41107`,
`"code":41107`) rather than a bare five-digit substring, which the existing
tests show fires on timestamps and credit amounts.

| Code | Error | Matcher | User message |
| --- | --- | --- | --- |
| 10405 | `InvalidDocumentTransitionIdError` | `isInvalidDocumentIdError` | code-level defect; "report this" |
| 41107 / 41108 / 41114 | `ContractUserBanned` / `ContractUserSuspended` / `ContractModerationCounterpartyBarred` | `isModerationBarredError` (the signer-barred 41107/41108 half is `isBarredFromContractError`, which the v8 branch moved here from `moderation-service.ts`) | banned or suspended by a moderator |
| 40129 / 40130 / 40222 | `GasFeesPaidByNotAllowed` / `InconsistentGasFeesPaidByInBatch` / `GasSponsorInsufficientBalance` | `isGasPayerError` (40222 also `isGasSponsorShortError` from the v8 branch, which gives it its own "pay in credits instead" message) | can't be paid for right now |
| 40132 / 40133 / 40134 | `DocumentActionFeeAgreementNotSet` / `…Mismatch` / `DocumentActionFeeMultiplierNotTolerated` | `isActionFeeAgreementError` (40134 also `isFeeMultiplierNotToleratedError`, which the v8 write path uses to drop its cached multiplier) | app is out of date with the fee rules |
| 40131 | `ReferencedDocumentTypeNotDeletable` | `isReferencedTypeNotDeletableError` | code-level defect |
| 40722 | `TokenOncePerIdentityDistributionAlreadyClaimed` | `isOncePerIdentityAlreadyClaimedError` | already claimed |

All are permanent for the transition as built. `categorizeError` handles them
before the frozen-balance and insufficient-YAPP branches — a moderation ban
must never read as "buy more YAPP" — and `isPermanentProtocol14Error` gathers
them so `retryPostCreation` refuses to retry any of them, beside the existing
`refersTo` and 40128 bail-outs (several still render as `consensus error` text
the retry allowlist would otherwise burn three attempts on). The frozen token
account (`is frozen for token`) keeps its own message and is asserted not to
match the moderation family. The remaining moderation codes (41100–41106,
41109–41116) are moderator-client situations and are not matched.

## What is NOT in this PR

**PR B — `beta3/social-v8` (social v8, blog v3, storefront v3).** Contract
re-cuts adopting the opt-in grammar, described here only at summary level:

- **contract moderation**: a moderator set on each contract, `ban`/`suspend`
  with a reason, and `deletableByModerators` on the doctypes whose content a
  moderator should be able to remove within the modification window;
- **`refersTo: deletableDocument`** on the references that today are forced to
  `permanentDocument` because their target must stay un-deletable;
- **optional token costs** (`tokenCost` payable in credits when no YAPP
  agreement is attached) so a user without YAPP can still act;
- **gas sponsorship** by the contract owner for token-paid actions;
- the **once-per-identity YAPP grant**;
- **action fees** and their pots, with the client attaching the agreement
  #4858 requires.

Each of those changes the transitions the client builds
(`actionFeeAgreement`, gas payer, an unpaid token cost) and needs its own
battery cases; none of it is needed to keep v7 working on beta.3, which is what
this PR is for.

**PR C — deployment.** Registering the re-cut contracts on moutai, seeding, the
deployed e2e run, and moving `.env.devnet`.

## Local validation

With the beta.3 packages, on `beta3/sdk-and-ids`:

- `npm ls @dashevo/wasm-sdk` — one copy, `4.2.0-beta.3`, deduped.
- `npx tsc --noEmit`, `npm run lint`, `npm run lint:dead` (knip) — clean.
- `npx vitest run` — 60 files, all passing, including `lib/document-id.test.ts`
  (7: the pinned vector, base58 and byte inputs, nonce/entropy sensitivity,
  not-v0, malformed input, DIP-30 masking) and `lib/error-utils.test.ts` (43,
  of which 27 are the protocol-14 family: 18 positive messages and codes, 8
  must-not-match strings, the frozen-vs-banned split).
- `npm run build:devnet` — the static export succeeds.
- `node scripts/seed/run-seeder.mjs --self-test` — passes, including the four
  new document-id checks (pinned vector, derived id with a nonce, placeholder
  without one, `createdId` reads the confirmed document).
- `node scripts/verify-v7.mjs --self-test`, `node scripts/verify-refersto.mjs --dry-run`
  — pass; the dry runs now print the id each shape WOULD carry at nonce 1.
- `node scripts/verify-{blog,dm,storefront,tips,pollr}.mjs --self-test` — pass.
- `NETWORK=devnet node scripts/seed/seed-non-social.mjs --which {storefront,blog,dm,pollr,tips} --self-test`
  and `--dry-run` — pass (the `FAIL thing k3: refused` line in the self-test
  output is the recorder's own "a refused write is collected, not thrown"
  assertion firing as designed).
- `node scripts/seed/provision-seed-identities.mjs --self-test` — passes.

### What is verified and what is not

**Verified offline:** the derivation matches the vector transcribed from
rs-dpp's `should_pin_the_nonce_derived_id` at tag `v4.2.0-beta.3` (read with
`git show v4.2.0-beta.3:packages/rs-dpp/src/document/generate_document_id.rs`
in the platform checkout; a reviewer should re-read it rather than trust the
transcription); the shipped wasm SDK still generates v0 ids in the two places Yappr
used them; every write path compiles and its self-tests pass.

**Observed, not written to:** moutai answered `getStatus` during this work with
`drive 4.2.0-beta.3`, `dapi 4.2.0-beta.3`, tenderdash `1.8.0`, protocol
`current 14 / latest 14`, at block height 237 — a fresh wipe onto beta.3. No
transaction was broadcast from this PR.

**Not verified — belongs to PR C:** that a create signed by the reordered
`createDocument` is accepted by a beta.3 node (the only proof that the
derivation, the nonce masking and the entropy on the transition agree with
what Drive recomputes); that `sdk.documents.create()` returns the id the
seeders now read; and that `InvalidDocumentTransitionIdError` renders as the
string the matcher pins. The first of those is the single most important check
of the deployment and should be done with one throwaway document before
anything is seeded.

## Deployment evidence

Observed on 2026-09-21 against moutai. Live Drive and DAPI both report
`4.2.0-beta.3`, Tenderdash 1.8.0, `drive.protocol.current = 14`. The Platform
state was wiped for the upgrade and the Core chain persisted, so every identity
was restored from its retained Core asset lock and kept its original id
(phase 1); this section is phase 2, the contract publication and everything
that runs on it.

### Why all ten ids are new, and the twenty nonces that bought them

A contract id is `generateId(owner, nonce)` and a group id is
`contractGroupId(owner, nonce)` — pure functions of owner and nonce. The maker
`3JKc6iVG74LEMSrAtB4VSHPQW2mtgKAw8s3Ki6tTFcRQ` was restored at identity nonce
**0**, so nonces 1-10 reproduce beta.1's ten ids and 11-20 beta.2's, byte for
byte, behind different schemas. `ops/fresh-id-check.mjs` proved that rather than
assuming it: it re-derived all twenty superseded ids and both superseded group
ids from the maker and matched them against the recorded values
(`beta1Reproduced: 10, beta2Reproduced: 10, groupsReproduced: 2`), and it holds
the same twenty as a hard blocklist the publisher refuses before any git or
chain lookup. Its negative controls fired as they must — beta.2's social id
scored 8 history hits and 48 ref hits, beta.1's group 46 and 200 — while all ten
planned ids and the new group scored 0 / 0 and were proved absent on chain.

Nonces 1-20 were therefore burned first, with twenty minimal credit transfers
(an `IdentityCreditTransfer` carries the identity nonce; document batches and
token transitions carry a separate `identityContractNonce` and do not move it).
All twenty rounds confirmed by nonce readback rather than by the call's return,
20 / 20, costing 56,946,000 credits in total. The chain nonce afterwards was
exactly **20**, so `firstCreateNonce` equalled `plannedFirstNonce` at 21.

### Ten contracts, one group

Group `9eHKb3jFZwoG428DUHqJ9ftUbqeYrt7CCmGrwuGVHYbt`, registered on the social
create at nonce 21, owner = the maker. Every other contract joins it through
`setContractGroupMemberships` on its own create; only social calls
`setContractGroup`.

| nonce | contract | id |
| ---: | --- | --- |
| 21 | social v8 | `CuSB2obg51YgNsqw3hoqNLdxVVVSU4wgnL2BN5rx5S3u` |
| 22 | profile | `BrTRnGoGQFLPdnqriu7H4jv6Pfk1S5aSdovTzXzZjdQh` |
| 23 | key backup | `AVYWRFXXQr3eKj6dCi1beDeyRKWp7iq7e2pkXE8sZpRo` |
| 24 | key exchange v2 | `D5pMHWHEDaYAHeFRk3rHS5reP5h3L8Sf4476jXjH2arS` |
| 25 | vault | `CvxssNPzgvW1iJ51AxvLXtRu1vePDzkB1HiAxxBdVBr6` |
| 26 | auth vault | `4KeUaXoJ61FqTibWBgiyKq9ZBz3rbm5xcs73vbtV3VeC` |
| 27 | storefront v3 | `6tmPMAoURDrYhh7kquovbg4MotPqmLf6rKukTGmB4pgd` |
| 28 | blog v3 | `4yaAufauUGCV2rm1FezyjQVbY1xW2a6dTskWAnsxQW3p` |
| 29 | DM v4 | `En7AnUi3eGoVzHUMrMh5J2C5LeAGhCc4Ru8nymFg4Dxs` |
| 30 | pollr v4 | `CR8aL9B85hT2y86DDRcF1ejUvnA3TLt2jQmmQwTqig9A` |

Every published id equals the one the dry run planned, which is the check that
the nonce assumption never slipped: publication was two-staged (A = 21-26,
B = 27-30) and each stage refuses to start unless the maker's identity nonce is
exactly what it expects, refuses any create it cannot cover at 1.5x the rest of
the stage, and checkpoints each signed transition before broadcast so a rerun
never allocates a second nonce. Stage A cost 187,000,000,000 credits of
registration plus 730,377,000 of storage; stage B 131,000,000,000 plus
767,313,000. The source JSONs were hash-asserted against the pinned
`beta3/social-v8` archive before anything was built, and the three moderated
cuts on `origin/staging` at `51d56fec` are byte-identical to those pins
(sha256 match on social v8, blog v3, storefront v3).

A proof-backed readback (`ops/verify-beta3-contracts.mjs`, live) then scored
**194 checks, 0 problems** over all ten: present, maker-owned, version 1, each
enrolled in the group by `forContract`, the group enumerating exactly ten
members, `config.moderation` echoed back off the *published* contract,
`documentTypeImmutableProperties` per doctype, every reference type checked
against its target's deletability, the action fees, and the token rules.

**The `$formatVersion` trap is real and is guarded.** A `"1"` config silently
drops `moderation` on parse, so a publisher that forces one protocol-14 config
onto every contract would have registered social v8, blog v3 and storefront v3
*unmoderated* while validating perfectly. Each file's own `config` is used when
it has one; the old default block is applied only to a bare-schemas file (DM and
pollr, both verified unmoderated). The three moderated cuts published with
`$formatVersion: "2"` and both moderation lists, and the readback proves it on
chain rather than in the local JSON:

```
social:     banlist + suspensions, appointedModerators, moderator-deletable post, reply
blog v3:    banlist + suspensions, appointedModerators, moderator-deletable blog, blogComment, blogPost
storefront: banlist + suspensions, appointedModerators, moderator-deletable itemReview, storeReview
```

The appointed moderators are exactly
`cLWB9tvMku6XLRwH7zwftos4BTTTgjtCP62MmRL4VfT` (the personal account) and the
maker. Both were fetched **with proof** before anything was signed — a missing
moderator is 41110 and the create is refused *paid*. The maker is appointed
deliberately: the owner may moderate whether named or not, but
`ContractModerators::team()` returns the *appointed* set and the moderators pot
is split between that team, so without naming the maker the pot could not be
claimed by the only identity the batteries can sign as.

YAPP `4P2XyKsFhM2NNAWoKSqo5xuUoHQSvy2cP7PpA8uwWhqg`: base supply 1,000,000
minted to the maker, direct-purchase price 1,000,000 credits per token with a
100-token minimum tier; both `currentPrice` and `basePrice` read back as
`1000000`. The `oncePerIdentityDistribution` of 100 YAPP is on chain with
`distributionRules` at `$formatVersion "1"` — the +10,000,000,000 credit
registration surcharge (`FEE_DATA_CONTRACT_REGISTRATION_VERSION3`, protocol 14
only) is what bought it, and social's registration came to 117e9 because of it.

### Gate 1 — the client write shape is accepted

Before any bulk provisioning, one `post` create built the way the app builds it
was put through `verify-v8.mjs --only a3`. It proves three unproven things at
once — the nonce-committed id derivation, the `$actionFeeAgreement`, and the
nonce all agreeing:

```
PASS  a3a post with the declared agreement lands — id=6uobqfmt5mDMWCacNFrZTBDYgx6eKEv4JKFwoukrKV6Q
PASS  a3b the nonce-committed v1 id derived locally is the id Platform stored
      derived=6uobqfmt5mDMWCacNFrZTBDYgx6eKEv4JKFwoukrKV6Q result=6uobqfmt5mDMWCacNFrZTBDYgx6eKEv4JKFwoukrKV6Q
PASS  a3c the moderators pot grew by 80M credits × the epoch multiplier
      pot 80000000→160000000 (Δ80000000, expected 80000000 at 1000‰)
PASS  a3d reply with its own declared agreement lands
PASS  a3e …growing the pot by 16M × multiplier — Δ16000000
```

The derivation under test is the **shipped** helper (`deriveDocumentIdBytes`),
not a battery-local transcription, so this is the live proof that
`dsha256("dash:document-id:v1" ‖ contract ‖ owner ‖ type ‖ entropy ‖ nonce u64
BE)` is what consensus recomputes. The upstream wasm-dpp2 fix remains open as
dashpay/platform#4868, so the shipped beta.3 SDK still returns a v0 id from
`Document.generateId`; every path here avoids it.

### Accounts and the starter grant

The CI identity and the personal account were restored — DPNS name, profile
document and YAPP — with every id read off the create result, never precomputed.
Both claimed the once-per-identity grant, 0 → 100 YAPP each, the first live
proof that the new distribution works on the freshly published contract.

All **148** seed-ledger personas then claimed it: 128 landed on the first pass
and the remaining 20 were confirmed on a second pass by the 40722 refusal, which
is the same proof from the other direction. 148 / 148, 0 failures. The grant
cannot fund the corpus (100 YAPP per identity against 3,396 for the busiest
persona), so the provisioner topped each persona up to 4,000 YAPP afterwards —
a claimed grant simply makes that transfer 100 smaller.

100 corpus personas reached `ready` (profile + DPNS + 4,000 YAPP); 31 non-social
seeder personas reached `ready` and bought 600 YAPP each by **direct purchase
with their own credits**, which exercises the price that had just been set. The
17 remaining ledger actors are battery actors that self-serve through
`ensureYapp()` and need no provisioning.

### Corpus

18,000 operations replayed against social v8:

| type | ops |
| --- | ---: |
| post | 5,700 |
| quote | 268 |
| reply | 2,144 |
| like | 8,557 |
| reply likes | 585 |
| follows | 495 |
| reposts | 234 |
| bookmarks | 17 |
| **total** | **18,000** |

Folded journal: exactly **18,000 `done`, no unresolved failures**. Ten late
dependency waits timed out on the first pass and every one succeeded on a
resume, the same pattern beta.2 saw.

A fresh read-only audit after the writer stopped re-proved every one:
`corpus-verification-full-2026-09-21T06-42-33.937Z.json`, `passed: true`,
**18,000 / 18,000 operations** and **2,905 / 2,905 beat companions**, against a
recorded corpus hash, with per-type censuses of 5,968 stored posts, 2,144
replies and the like / likeReply / repost / follow / bookmark pairs.

`ops/verify-count-trees.mjs` re-proved live that the nine indexes which dropped
the explicit `countable` keyword still answer counts — `post.byOwner` = 135 and
`follow.followerCount` = 54 for corpus persona 0, plus the windowed like and
beat ranked axes — 8 probes, 0 failures. Both figures match beta.2's for the
same corpus.

**Who pays the action fee is who pays the gas, and on v8 that is the contract
owner.** Social v8 declares `gasFeesPaidBy: 2` (PreferContractOwner) on `post`,
`reply`, `like`, `likeReply` and `repost`, and the seeder reads that offer off
the contract rather than inventing one (asking for a payer the type does not
offer is 40129). So for the ~75% of actors that pay YAPP — the default
`--credits-fraction 0.25` leaves the other quarter paying credits and their own
gas — the gas *and* the moderators action fee land on the maker, not on the
persona. That is 17,488 of the 18,000 ops, not the 8,112 posts and replies a
fee-only reading suggests. A bounded 300-op probe measured 13,849,766,860
credits off the maker before the full replay was started, and the maker was
topped up by 20 DASH from the devnet treasury as a precaution. In the event the
replay plus every battery cost it 1,638,988,417,674 credits gross and returned
256,256,550,560 from the moderators pot claim, so the pre-top-up balance of
1,987,437,774,020 would in fact have covered it — the margin, not the
affordability, was what the top-up bought.

`t1e` is the same fact proved directly: a like carrying payment info moved the
contract **owner's** credits and left the signer's untouched
(`owner 2590932224442→2590831913562  A 497688248800→497688248800`).

### Gate 2 — `verify-v8.mjs` and the feature batteries

| battery | checks | result |
| --- | ---: | --- |
| `verify-v8.mjs` (m1-m3, t1-t2, a1-a4, g1, l1) | 44 | **ALL CHECKS PASSED** |
| `verify-blog.mjs` (blog v3, moderated) | 53 | **ALL CHECKS PASSED** |
| `verify-storefront.mjs` (storefront v3, moderated) | 76 | **ALL CHECKS PASSED** |
| `verify-dm.mjs` (DM v4) | 31 | **ALL CHECKS PASSED** |
| `verify-pollr.mjs` (pollr v4) | 39 | **ALL CHECKS PASSED** |
| `verify-tips.mjs` (tips on YAPP) | 28 | **ALL CHECKS PASSED** |

`l1` needed care to stay honest on a contract that already carries the corpus.
The "no zero-count groups" claim (v8 dropped `preallocated` from four like
indexes) is asserted on the **ascending** page, because zero counts sort first
there; on the descending page it would be vacuous, since a page of a hundred
groups that all count at least one cannot contain a zero however broken
preallocation is. The ascending page returned 100 groups with a lowest count of
**1**. Separately, `l1e` asks whether the fresh count-1 post appears on the
descending page: it does not, and that absence is only accepted as evidence
because the page is provably full (100 groups) with a floor above one (11).
A short page would fail rather than skip.

`m2e` took **7 block-time retries** — about 70 seconds past `until` — which is
the lag worth knowing about: a suspension's expiry is compared against block
time, not wall clock.

The verbatim consensus texts for the new codes:

- **41107**, banned: *"Identity H8bQ… is banned on contract CuSB2obg… and can
  not act on its documents"*. The ban bars writes, not exits — B's DELETE still
  landed while banned, and its create landed again after the unban.
- **41108**, suspended: *"Identity H8bQ… is suspended on contract CuSB2obg…
  until 1789967960149 and can not act on its documents"*, for a priced create
  and an unpriced one alike.
- **40120** on a tombstone, twice over: *"referenced deletable document (own
  contract, document type post) 9BN7B3vn… not found for path postId"* for a like
  on a moderator-removed post, and *"… not found for path quotedPostId"* for a
  tombstone that KEEPS the dead quote. A tombstone that CLEARS it lands — the
  one change immutability allows.
- **40700**, insufficient tokens: *"Identity 47da17QA… does not have enough
  balance for token 4P2XyKsF…: required 1, actual 0, action: Document create
  token payment"* — payment info with too little YAPP is a refusal, never a
  silent fallback to credits.
- **40132**, no agreement: *"Document create of type post charges an action fee
  of 0 credits to the owner and 80000000 credits to the moderators
  (feeMultiplier pricing), and the transition carries no action fee agreement"*.
- **40133**, mismatched agreement: the same sentence continuing *"…, but the
  transition agreed to 0 and 1 credits (feeMultiplier pricing)"* for a wrong
  amount, and *"…, but the transition agreed to 0 and 80000000 credits (fixed
  pricing)"* for agreeing to FIXED pricing on a `feeMultiplier` fee.
- **41111**, pot already claimed: *"The moderators fee pot of contract
  CuSB2obg… was already claimed in epoch 0; a pot is claimed at most once per
  epoch"*.
- **40722**, grant already taken: *"Token claim error: identity 'EjVyhRot…'
  already claimed the once-per-identity distribution of token '4P2XyKsF…' at
  1789967236245"*.

Note that **40132, 40133, 41107, 41108 and 41111 arrive as prose with
`code = -1`**, not as a numbered variant the SDK surfaces; only 40120 and 40700
came through as `StateTransitionBroadcastError` with the number attached. Any
classifier that anchors on the number alone will miss five of the eight.

The moderators pot is the corpus accounting end to end: it stood at
**512,528,000,000 credits** after the replay — 5,968 posts × 80e6 plus 2,144
replies × 16e6 is 511,744,000,000, the remainder being the batteries' own posts
— and `a4` claimed it to zero, paying the claimant 256,256,550,560, an equal
split between the two-member moderation team, with less than one share left
behind.

### Fixes this deployment forced

Five defects were found by running the batteries against a real beta.3 node and
are fixed in this PR. None of them is a chain defect; all five are places where
the harness or the reconciliation helper was wrong about beta.3.

1. **`verify-v8.mjs` did not mask the identity contract nonce.** `seed-lib`'s
   `createWithAgreement` masks with `NONCE_SEQUENCE_MASK` before incrementing;
   the battery's own `manualCreate` used the raw value. A raw nonce carries
   missing-nonce marker bits above bit 40 once an identity has a gap, so
   `raw + 1` named a nonce far in the future and wedged every later case:
   *"is trying to set an invalid identity nonce. The current identity nonce is
   2199023255558"* (= 2^41 + 6).
2. **BigInt serialization aborted two moderation cases.**
   `moderationStatus.suspendedUntil` and a removal record's `removedAt` are u64
   and reach JS as BigInt, so describing them with a bare `JSON.stringify` threw
   *"Do not know how to serialize a BigInt"* — taking `m2` down in `verify-v8`
   and `b14` in the shared `battery-moderation.mjs`, and with `m2` the four
   later cases that share its fixtures.
3. **The 40132 / 40133 patterns matched nothing.** They anchored on the number
   or on the phrase "fee agreement mismatch"; beta.3 sends neither. Both now
   also match the shipped prose.
4. **`findRecentByValues` aborted on doctypes with no `$ownerId` index.** It
   reconciles by querying the owner's recent documents, but storefront's
   `shippingZone` indexes only `(storeId, name)` and `(storeId, priority)`, so
   the query was refused *"where clause on non indexed property"* — a permanent
   fact about the schema, not a fault to retry. Every rejection probe on such a
   type aborted. It now answers "no match" instead.
5. **The same reconciliation scored unique-index refusals as ACCEPTED.** When a
   create is refused because a value-identical document already exists, the
   value search finds *that* document and reports the refused write as landed.
   The `since` floor does not exclude it — it allows 120 s of clock skew, so a
   fixture written seconds earlier in the same run matched. DM `d1c` (duplicate
   `conversationInvite`) and `d3d` (duplicate `readReceipt`) both reported
   ACCEPTED (BAD) against a contract whose unique indexes were in fact working.
   `attemptCreate` now captures any pre-existing match before the write and
   refuses to count it as evidence.

Items 4 and 5 are regressions from PR A's `findRecentByValues` reconciliation
and would have mis-scored any future battery run, in both directions.

A review of the first round of those fixes caught two places where a fix would
have made a test pass without proving anything, and both are corrected here:

- `AGREEMENT_MISMATCH`'s new prose alternative now requires **both** amounts
  (`agreed to N and M credits`), and `a2` rules out 40134 explicitly. The
  stale-fee-multiplier refusal is also prose about what the transition agreed
  to, so a run crossing an epoch boundary could otherwise have passed `a2`
  while proving 40134 rather than 40133.
- `l1d` originally kept the zero-count assertion on the descending page, where
  it cannot fail; it now reads the ascending page, and `l1e` no longer skips
  unconditionally.

The same pre-existing-document guard was also ported to `verify-lib.mjs`'s
`attemptCreate`, which is the parallel helper `verify-v7` and `verify-refersto`
use — two copies with divergent correctness is how this class of bug returns —
and `attemptCreateByValues` now documents that its default acceptance probe
cannot express a duplicate probe on an indexOnly type, because an index entry
that predates the write satisfies it exactly as it did before.

### Balances at completion

The maker holds **2,590,700,499,966** credits and **645,131** YAPP at identity
nonce **30** — unchanged since the tenth create, because documents and tokens
carry `identityContractNonce`, a separate per-(identity, contract) counter, and
an `IdentityTopUpTransition` carries no identity nonce at all. The 100 corpus
personas hold **2,975,750,643,330** credits between them. Platform height 4,485,
core chain locked height 79,569.

### Known-good operational notes

- On devnet the maker is the **seed-index-9** identity, so the batteries take
  `--moderator bot:9`, not `--moderator maker`; the latter reads
  `~/Downloads/dash-identity-testnet-contract-maker.json`, which is the
  *testnet* contract maker and a different identity entirely.
- `E2E_IDENTITY_IDS` is positional and `filter(Boolean)` collapses empties, so
  addressing bot index 9 needs ten non-empty entries.
- The feature batteries resolve actors by persona index out of the seed ledger,
  so an appointed moderator has to be present there to be usable as one.
- Quorum rotations produce `Quorum not found in cache` on reads. Twice a
  moderation write landed while its confirming read failed, leaving a target
  banned; the battery says so (*"MAY STILL BE BANNED; unban by hand"*) and the
  state must be cleared before a rerun.
- Blog case `b4d` counts comments in a 60-second window, so two blog battery
  runs less than a minute apart contaminate each other.
