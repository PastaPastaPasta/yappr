# Platform 4.2.0-beta.4: wasm-derived ids, moderation restore, owner balances

Investigation date: 2026-09-24. This document covers the beta.3 → beta.4 range
only; everything earlier is in [`PLATFORM_BETA3_UPGRADE.md`](./PLATFORM_BETA3_UPGRADE.md).
It is the record of **PR A** (`beta4/sdk`): the SDK pin, the id derivation moving
into the SDK, the moderation additions the client can use against a contract
that declares them, the new consensus errors, and the owner balance the proof
now carries. The contract re-cuts and the devnet deployment are separate
branches (see the end).

## Versions and scope

| Release | Commit | Changes reviewed |
| --- | --- | --- |
| `v4.2.0-beta.3` | `b5a93f5e2b5567487b653e121d2f0683200a6fb1` | Starting point; see the beta.3 document. |
| `v4.2.0-beta.4` | `6c95cd8b162750412e1f924655820edf8cf3c29e` | 68 non-merge commits. Protocol version remains **14** (`LATEST_VERSION = PROTOCOL_VERSION_14`); every consensus change lands behind it. |

Both `@dashevo/evo-sdk` and `@dashevo/wasm-sdk` are pinned to exactly
`4.2.0-beta.4`, and `package-lock.json` resolves a **single** WASM runtime
(`npm ls @dashevo/wasm-sdk` shows one copy, deduped under evo-sdk). A split is
worse than usual this time: #4887 changes the shape of the transition-result
proof, so a beta.3 wasm verifying a beta.4 node's proof of a document batch
would not agree about its contents.

**Moutai was wiped for beta.4.** It currently runs no Yappr contracts. The
contracts are re-cut and registered on a separate branch; this PR broadcasts
nothing and was validated offline only (see "Local validation").

## What changed, grouped

The 68 commits fall into a few groups. Only the first three touch the client
as it exists today; the rest is new grammar that a future cut may adopt.

| Group | Commits | Effect on Yappr |
| --- | --- | --- |
| **JS id derivation** | [#4868](https://github.com/dashpay/platform/pull/4868) `752c47e54b` | wasm-dpp2 derives nonce-committed ids itself. **Adopted**: Yappr's own copy of the hash is deleted (below). |
| **Owner balance in the proof** | [#4887](https://github.com/dashpay/platform/pull/4887) `1d6497e88b` | The proof of an owned, fee-paying transition carries the owner's credit balance after it; the wasm wait result exposes it as `ownerBalance`. **Adopted** on the create path. Breaking for the proof format, hence the exact pin. |
| **Moderation additions** | [#4872](https://github.com/dashpay/platform/pull/4872) `c1e577b685` warning list; [#4884](https://github.com/dashpay/platform/pull/4884) `49ca6926e6` reasons cite documents; [#4885](https://github.com/dashpay/platform/pull/4885) `8af07d42f6` restore moderator-deleted documents | **Adopted** in `moderation-service`, gated on the contract (below). |
| **Elected moderation** | #4886 #4898 #4907 #4909 #4914 #4951 #4952 #4953 #4967 #4969 #4970 #4971 | A contract may declare `moderators: { $type: "elected" }`; teams are elected through the new moderation charters system contract and moderate from their seated charter; `sdk.moderationCharters` reads it. No Yappr cut declares it. Error codes classified; `getTeam` recognises a seated team; **the election UI is not built here** (a separate effort). |
| **New document grammar** | #4917 `distinctFrom`, #4957 `maxBytes`, #4962 `propertyConstraints`, #4922/#4923/#4924/#4928 typed scalar arrays, #4916/#4918 key references and `keyRequirements`, #4919/#4943/#4948/#4949 `encryptedFor`, #4930 references through a unique index, #4940 `listElement` references, #4941 `ownerRefersTo`/`creatorRefersTo`, #4942 `anyOf`/`allOf` references, #4913/#4915 contract-reference requirements, #4866 composite and flat `indexOnly` terminals | All opt-in per document type. Error codes classified here so a future cut's refusals read correctly; **adoption deferred** to the contract re-cuts. |
| **Consensus fixes** | #4950 transient values dropped on replace, #4925 integer width fixed on contract update, #4954 fee-claim contract fetch billed deterministically, #4956 system contracts registered without storage flags, #4959 masternode votes 80% cheaper, #4960 refund crediting, #4961/#4966/#4968 identity-create-from-addresses penalties, #4900 recheck re-validates the fee agreement, #4870 non-object schema refused, #4883 contract transition length | No Yappr contract uses `transient`; nothing else is reachable from the app. |
| **New system contract** | #4869 app-connect login response | Reference for a future wallet-login flow; no change. |
| **Mobile / FFI / CI** | #4799 #4818 #4910 #4926 #4927 #4931 #4944, PR Hygiene re-pins, #4958 #4972 | No change. |

## Document ids now come from wasm-dpp2

beta.3 moved document ids to `dsha256("dash:document-id:v1" ‖ contract ‖ owner ‖
type ‖ entropy ‖ nonce u64 BE)` (#4859), but the shipped wasm still derived the
entropy-only v0 id, so beta.3's PR A reimplemented the v1 hash in
`lib/document-id.ts` and again in `scripts/seed/seed-lib.mjs`. beta.4's #4868
fixes the SDK side:

| Surface | Behaviour on beta.4 (verified against the installed `.d.ts` and `wasm-dpp2` at the tag) |
| --- | --- |
| `Document.generateId(type, owner, contract, entropy?, identityContractNonce?, platformVersion?)` | Derives the v1 id; the nonce is **required** at protocol 14 (it throws without one). Defaults to the latest platform version. |
| `document.setIdForCreation(nonce)` / `new Document({ …, identityContractNonce })` | Give a new document its final id; throw without entropy. |
| `new DocumentCreateTransition({ document, identityContractNonce })` | **Re-derives** the id from the document's entropy and the nonce and writes it back onto `document.id`, so `document.id === transition.base.id`. Throws if the document has no entropy. |
| `sdk.documents.create(...)` | Unchanged in shape: still `document`, `identityKey`, `signer`, `tokenPaymentInfo`, `settings` — **no `actionFeeAgreement`, no affected-state wait**. Sets the confirmed id back onto the caller's document. |

What Yappr did:

- **Deleted the JS hash.** `lib/document-id.ts` now wraps `Document.generateId`
  (`documentIdForCreate`) and keeps the DIP-30 nonce masking
  (`nextIdentityContractNonce`); `scripts/seed/seed-lib.mjs`'s
  `deriveDocumentIdBytes` wraps the same call for the Node seeders and
  batteries. `@noble/hashes` is still used elsewhere, so no dependency goes.
- **Kept the hand-built create path.** `stateTransitionService.createDocument`
  still assembles the `BatchTransition` itself, because `documents.create`
  cannot carry the v8 `post`/`reply` action-fee agreement (a paid 40132
  without it) and cannot wait for affected state (indexOnly likes). Only its
  id derivation changed. No type was moved onto `documents.create`; doing that
  for plain types is possible but buys nothing while the manual path must stay
  for the rest.
- **The auth vault** still encrypts against the id before the document
  exists: `createDocument` derives it with `Document.generateId` for the nonce
  it is about to sign with and hands it to the data callback, and the
  transition re-derives the same id.
- **Documents are still built with `Document.fromObject`** (the constructor
  still corrupts `Uint8Array` properties), with the derived id as `$id`.

`lib/document-id.test.ts` pins `Document.generateId` to rs-dpp's
`PINNED_V1_ID` (`e574ae73…c50f15f`: contract `[1;32]`, owner `[2;32]`, type
`note`, entropy `[7;32]`, nonce 1) — the same vector the deleted JS copy was
pinned to — and asserts that `new DocumentCreateTransition` writes that id back
onto the document. That is the proof the removal is equivalent.
`run-seeder.mjs --self-test` asserts the same vector through the seeders' wrapper.

## Moderation: warnings, cited documents, restore

All three are wrapped in `lib/services/moderation-service.ts`, with types, and
gated on what the contract declares:

- **Warning list** (#4872). `warn(moderator, identity, reason)` and
  `clearWarnings(...)` wrap `contracts.warnUser`/`clearUserWarnings`. A warning
  bars nothing; at most 16 accumulate (41118 past that) until cleared (41117
  when there are none). The standing (`getStanding`) now carries the
  identity's warnings, and `listEntries('warnings')` pages the list.
- **Reasons that cite documents** (#4884). A reason may name up to 16
  `{documentTypeName, documentId}` (10904 past that or with a duplicate) and a
  `reasonDocumentId` of the moderation charters contract, which a seated
  elected team must cite from its proposal (41203). `toModerationReason`
  dedupes, refuses more than 16 locally, and sends a bare `{ text }` when
  nothing is cited.
- **Moderator restore** (#4885). A removal record now holds the double
  SHA-256 of the document as serialized under its type, plus `restoredBy` /
  `restoredAt`. Any moderator may bring the document back within a week
  (41120 after), by handing over the **exact document** (41121 if it hashes
  differently); a unique value taken meanwhile refuses it (40105). Nothing on
  chain keeps the bytes, so `removeDocument` now fetches the document and
  stores `document.toBytes(contract, latest)` in scoped localStorage
  (`lib/moderation-snapshots.ts`) **before** deleting it, and
  `restoreDocument` decodes those bytes fresh under the current contract.
  `canRestore` offers the action only while the window is open, the record is
  not restored, and the snapshot still hashes to the record. A moderator on
  another device sees no restore action. A failed snapshot never blocks a
  removal.

**Gating.** `lib/contract-topology.ts` gains `moderationListsKept()` and
`contractKeepsWarnings()`, read from the bundled contract's
`config.moderation`. Every status read names exactly the kept lists (reading a
list the contract does not keep is refused), and warn/clear refuse locally
when there is no warning list. **The current v8 cut keeps `banlist` and
`suspensions` only**, so on v8 the warn UI is hidden and nothing changes;
v2–v7 are unmoderated and every moderation call still answers "nothing". A
re-cut that sets `warnings: true` turns the feature on with no code change.

**UI** (`components/settings/contract-moderation-settings.tsx`, the existing
moderator panel): Warn / Clear warnings (when kept), a warned-identities list,
a "Check status" readout (ban, suspension, each warning with its reason and
cited-document count), optional "posts / replies this is about" fields for
ban/suspend/warn (each cited id carries its real doctype), and Restore on a
removal row (the restorable set is computed once per refresh). The removal
result reports `snapshotSaved`, and the modal and toast only promise a
restorable copy when one was actually kept.

**Elected moderation, briefly.** Social v9 will declare it (interim
`contractOwner`, `ownerProtected: true`). `getTeam` mirrors Drive's
`ContractModerators::may_moderate` / `InterimModerators::may_moderate`
(rs-dpp `config/moderation/elected.rs`) through an `ownerModerates` flag: the
owner moderates under an owner or appointed declaration and under a
`contractOwner` / `appointedModerators` interim; under a `notYetUsable` /
`noModeration` interim nobody does; once `sdk.moderationCharters.team(contract)`
returns a seated team, its leader and members moderate alone and the owner no
longer may (`ownerProtected` protects the owner from moderation, it does not
let it moderate). The team is cached for 60 seconds and dropped after every
moderation action, so a team seated mid-session takes over; the wasm
`ModerationTeam` is copied out and freed. The election flow — submitting
charters, join requests, voting — is another agent's work, and nothing here
constrains it: the charter readers are used through the SDK facade only, and
`classifyModerationError` already names the election-side refusals (41200–41203,
11000/11001, 40111).

## Consensus errors classified

Pinned to the `#[error(...)]` formats in rs-dpp at `v4.2.0-beta.4`, matched
prose-first (most new consensus codes arrive as prose with `code = -1`) and by
labelled code (`code=41118`, `"code":41118`), never bare digits.

| Code | Error | Matcher | User message / kind |
| --- | --- | --- | --- |
| 10419 / 10422 | `DocumentPropertyNotDistinct` / `DocumentPropertyConstraintViolated` | `isDocumentPropertyRuleError` | "doesn't allow this combination" |
| 10421 | `DocumentPropertyMaxBytesExceeded` | `isPropertyMaxBytesError` | "too long once emoji are counted — shorten it" |
| 40135–40138 | `ReferencedContractRequirementNotMet`, `ReferencedIdentityKeyRequirementNotMet`, `ReferencedDocumentLookupInvalid`, `ReferencedDocumentListInvalid` | `isReferenceRequirementError` | code-level defect. **Excluded from `isReferenceNotFoundError`**: 40135 also says "referenced … for path", and tombstone repair would otherwise drop a reference whose target is alive. |
| 40139 | `DocumentActionFeeModeratorsShareMismatch` | `isModeratorsShareMismatchError` (also in `isActionFeeAgreementError`) | "the moderator fee share didn't match the seated charter" — not "reload". Drive checks the share only when the agreement offers LESS than declared; Yappr always agrees to the full declared moderators fee, which passes seated or not (pinned in `transition-agreements.test.ts`). |
| 40307 | `VoteChoiceNotAllowedForVotePoll` | in `isPermanentProtocol14Error` | code-level defect |
| 41200 | `ContractModeratedDocumentTypeNotYetUsable` | `isModerationNotYetSeatedError` | "opens once the community elects its moderation team" |
| 41101 / 41113, 41117–41122, 41201–41203, 10904, 11000 / 11001, 40105 / 40111 in a moderation context | moderator-side refusals | `classifyModerationError` → `ModerationErrorKind` | per-kind messages in `moderation-service` |

All the user-reachable ones join `isPermanentProtocol14Error`, so
`retryPostCreation` never retries them.

## Owner balance

`createDocument` reads `ownerBalance` off the `waitForResponse` /
`waitForAffectedState` result — on the fresh path and on the cached-ST
rebroadcast path — (an untyped bigint set by wasm-sdk, absent before
protocol 14 or for unowned transitions) and hands it to
`identityService.recordBalance`, so the next `getBalance` — the sidebar's
periodic refresh, the tip and buy-YAPP modals — is answered from cache. The
value is a snapshot at the proof's block; the cache TTL bounds how long it is
trusted, and a value above `Number.MAX_SAFE_INTEGER` is not cached (it would
round). Replace, delete and the moderation calls go through facade methods
that return no wait result, so they are unchanged.

## JS API compatibility

`npx tsc --noEmit` passes against the beta.4 typings with no source change,
and every SDK call in `lib/` and `scripts/` was checked against the `.d.ts`:
nothing Yappr uses was removed or renamed. The semantic changes that matter:

- `new DocumentCreateTransition` now **mutates** the document passed in (its
  id) and throws without entropy. Every Yappr and script create builds a fresh
  document with entropy, so nothing observes the change except that the id is
  now always right.
- `Document.generateId` without a nonce **throws** at protocol 14. The frozen
  historical batteries `verify-v4.mjs` / `verify-v5.mjs` still call the
  four-argument form; they record protocols that no longer exist and are left
  untouched, as in beta.3.
- No Yappr code holds a wasm borrow on a caller's `Document` across an await:
  the restore path decodes a fresh `Document` for the call.

## What is NOT in this PR

- **Contract re-cuts** adopting beta.4 grammar: `warnings: true` on the social
  contract, `maxBytes` on content fields (emoji-heavy posts), `distinctFrom` on
  `follow.followingId` / tips, typed arrays, `ownerRefersTo`. Separate branch,
  together with the moutai registration.
- **Election UI** for elected moderation. Separate effort.
- **Restore across devices.** The snapshot lives where the removal was made.
  Syncing it (e.g. through the moderator's auth vault) is possible but out of
  scope.
- **`documents.create` for plain types**, and a caller-supplied idempotency key
  for the ST-byte replay cache (the cache is still unreachable, as the beta.3
  document explains).
- **Owner balance on replace/delete/moderation**, which would need those paths
  to return their wait results.

## Local validation

On `beta4/sdk`, with the beta.4 packages:

- `npm ls @dashevo/wasm-sdk` — one copy, `4.2.0-beta.4`, deduped.
- `npm run lint`, `npx tsc --noEmit`, `npm run lint:dead` (knip) — clean.
- `npm run test` — 66 files, 633 tests passing, including the new
  `lib/document-id.test.ts` (wasm vector, write-back, nonce masking),
  `lib/services/moderation-service.test.ts` (who moderates under each of the
  four interims and a seated team, the team TTL and post-action invalidation,
  reason shapes, warning gating, snapshot-then-delete ordering and
  `snapshotSaved`, restore, error kinds),
  `lib/services/owner-balance.test.ts`, and the beta.4 cases in
  `lib/error-utils.test.ts`.
- `npm run build` — the static export succeeds.
- `node scripts/seed/run-seeder.mjs --self-test`, `node scripts/verify-v8.mjs --self-test`,
  `node scripts/verify-v7.mjs --self-test`, `node scripts/verify-refersto.mjs --dry-run`,
  `node scripts/verify-{blog,dm,storefront,tips,pollr}.mjs --self-test` — pass.

**Not verified — needs the re-cut contracts on moutai:** that a create signed
by the manual path is accepted by a beta.4 node; that the wait result actually
carries `ownerBalance`; that a snapshot taken with `document.toBytes` hashes to
the record Drive writes (both serialize the document under its type at the
latest version, so they should, but only a live remove-then-restore proves
it); and that the new error texts render as the matchers expect.
