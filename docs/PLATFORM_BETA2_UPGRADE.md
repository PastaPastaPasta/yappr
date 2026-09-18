# Platform 4.2.0-beta.2: Yappr upgrade and social contract v7

Investigation date: 2026-09-18. This document covers the beta.1 → beta.2 range only;
everything earlier is in [`PLATFORM_BETA1_UPGRADE.md`](./PLATFORM_BETA1_UPGRADE.md).
Deployment evidence belongs at the end; the release tag alone does not establish
that a particular network was reset or that a contract was registered.

## Versions and scope

| Release | Commit | Changes reviewed |
| --- | --- | --- |
| `v4.2.0-beta.1` | `c96ff32a8b1e93275c47b9f587c3b89c42758c8c` | Starting point; see the beta.1 document. |
| `v4.2.0-beta.2` | `d09c15de83c807793f1def85cfc834276166f114` | 15 commits. Protocol version remains 14. |

Both `@dashevo/evo-sdk` and `@dashevo/wasm-sdk` are pinned to exactly
`4.2.0-beta.2`, and `package-lock.json` resolves a **single** WASM runtime. That
pinning is not cosmetic: Yappr imports `@dashevo/wasm-sdk` directly (the identity
update builder, the username helpers, `sdk-helpers`, the composite-feed types), so
a split between the two packages loads two WASM modules into one page.

## The 15 commits and what each means for Yappr

| Commit | Change | Effect on Yappr |
| --- | --- | --- |
| [#4815](https://github.com/dashpay/platform/pull/4815) `96fb252820` | **`immutable` properties on mutable document types** | **Adopted.** `post` and `reply` freeze their structural columns; `deleted` becomes immutable-but-settable. See below. |
| [#4816](https://github.com/dashpay/platform/pull/4816) `1a57e101a1` | **`propertyAgreement` on `$ownerId`/`$creatorId`; writer gates** (breaking) | **Adopted.** Retires the client-attested `author` column. Binds `repost.postOwnerId`. No writer gate is appropriate here. |
| [#4817](https://github.com/dashpay/platform/pull/4817) `d1411648c9` | `wasm-dpp2` exposes immutable properties to JS | Used by `scripts/validate-contract-offline.mjs`: `contract.documentTypeImmutableProperties(type)` and `contract.documentImmutableProperties` (a `Map`). |
| [#4809](https://github.com/dashpay/platform/pull/4809) `8f5b44e741` | v3 meta-schema aggregate prerequisites are **sugar-aware** | `rangeCountable: true` now implies `countable: "countable"`. v7 drops the redundant explicit pairing from the nine indexes that carried both. |
| [#4813](https://github.com/dashpay/platform/pull/4813) `26fa43eeb5` | indexOnly creates that **collide within one batch** are refused | No change needed. The client already writes a like and its `beat` in two sequential transitions (the network caps a document batch at one), and the two are different doctypes anyway. |
| [#4811](https://github.com/dashpay/platform/pull/4811) `ba01d4cdfa` | Key limits on every client (breaking) | **Additive in practice.** The wasm-dpp2 diff only adds optional `totalBudget`/`expiresAt` getters and setters to `IdentityPublicKey` and `IdentityPublicKeyInCreation`; the constructor shape is unchanged, so `lib/services/identity-update-builder.ts` compiles and behaves identically. Yappr does not yet create limited keys (beta.1 follow-up work, still open). |
| [#4807](https://github.com/dashpay/platform/pull/4807) `9f814131cc` | `IdentityKeyLimitsUpdate` state transition (breaking) | New transition kind; Yappr issues none. Relevant only if the scoped/limited-key feature from the beta.1 document is adopted. |
| [#4812](https://github.com/dashpay/platform/pull/4812) `fc1b3e6c7b` | Re-validate `identityPublicKey` references when only the key id changes | Consensus hardening for `refersTo: identity-key` declarations. Yappr's social contract declares none. |
| [#4810](https://github.com/dashpay/platform/pull/4810) `3250d53308` | Gate the address trunk-state proof on the GroveDB envelope floor | SDK proof-verification correctness; no app change. |
| [#4797](https://github.com/dashpay/platform/pull/4797) `72b46a4689` | Retry DPNS broadcasts when the owner identity is missing | Helps username registration reliability on a freshly reset chain. No app change. |
| [#4738](https://github.com/dashpay/platform/pull/4738) `c4f99329c6` | Platform wallet: look up the funding tx's block when a ChainLock proof has no record height | Asset-lock reliability for provisioning. No app change. |
| [#4820](https://github.com/dashpay/platform/pull/4820) `71ea82fe57` | Mobile example apps show and lock immutable properties | Reference material for the same feature Yappr adopts. |
| [#4806](https://github.com/dashpay/platform/pull/4806) `a14ace27a6` | Mark protocol 14 as shipped; drop the wasm-dpp `errorsText` test helper | The v3 document meta-schema is now editable only until 4.2 is live on **mainnet**, not until the protocol-14 release ships. Yappr uses no `errorsText`. |
| [#4804](https://github.com/dashpay/platform/pull/4804) `4c527e43e2` | Re-pin PR Hygiene CI | Upstream CI only. |
| `d09c15de83` | Release chore | — |

Nothing in this range changes a query shape, a ranked/count/timeRange grammar, or
a proof format. **v7's read surface is byte-for-byte v6's**, which is why
[`V6_WINDOWED_RANKINGS.md`](./V6_WINDOWED_RANKINGS.md) still describes it in full.

## Contract v7

`contracts/yappr-social-contract-v7.json` is generated from v6 by
`scripts/build-v7-contract.py`, a deterministic transform (running it twice
produces byte-identical output) whose `--self-test` asserts the committed JSON is
a fresh build and re-checks every invariant below. The diff against v6 is four
things and nothing else.

### 1. System-field `propertyAgreement` retires the attested `author`

v4 added a required, poster-attested `author` identifier to `post` and `reply` for
exactly one reason: a `propertyAgreement` pair could only name a **schema**
property of the referenced document, so a like could not be bound to its post's
real owner. The column was a duplicate of `$ownerId` that consensus could only
ever check against *itself* — the client wrote it, and nothing stopped a client
from writing it wrong.

beta.2 lets the referenced side of a pair be `$ownerId` or `$creatorId`. v7 uses
it, and deletes the column from `post` and `reply` (properties and `required`).

Every `propertyAgreement` in v7, in full:

| Doctype | Referring property | Agreement |
| --- | --- | --- |
| `like` | `postId` → `post` | `{ "hashtag": "hashtag", "postAuthor": "$ownerId" }` |
| `likeReply` | `replyId` → `reply` | `{ "replyAuthor": "$ownerId" }` |
| `repost` | `postId` → `post` | `{ "postOwnerId": "$ownerId" }` — **new in v7** |
| `beat` | `postId` → `post` | `{ "hashtag": "hashtag" }` — unchanged from v6 |

`repost` is a genuine tightening rather than a rename. `repost.postOwnerId` feeds
the `postOwnerAndTime` index that answers "who reposted my post?", and until v7 a
client could put any identity there — sending a stranger a notification for a post
that is not theirs. It is safe to bind because the value was already correct
everywhere it is written: the single caller,
`hooks/use-post-engagement.ts`, passes `post.author.id`, which
`lib/services/post-service.ts` transforms from the document's `$ownerId`, and
reposting is gated to `kind === 'post'` (`canRepost`); the seeder passes the
target ref's `ownerId`.

`preallocated` survives on `like.byAuthorPost`. The book is explicit that an
`[authorId, postId]` index whose `authorId` agrees with the post's `$ownerId`
still qualifies — "the poster is the one owner a referenced post does determine"
— so the path stays a pure function of the referenced document.

Three bindings were considered and **rejected**:

- `post.quotedPostId` → `{ "quotedPostOwnerId": "$ownerId" }` — **deferred, not
  impossible.** `quotedPostOwnerId` is a shared denormalization:
  `lib/feed/resolve-quoted-posts.ts` writes it when quoting a **reply** too,
  where the reference lives in `quotedReplyId` and `quotedPostId` is absent.
  That does not reject reply-quotes — an absent *reference property* skips its
  whole reference, `propertyAgreement` included (`Ok(None) => continue` in
  rs-drive-abci `document_reference_validation/v0/mod.rs`); strict absence
  applies to the paired *values* once the reference resolves. The binding would
  therefore be safe but only **half** cover the column: post-quotes checked,
  reply-quotes not, since binding `quotedReplyId` instead is the mirror
  problem. Half-covering a denormalization is a worse invariant to reason about
  than not covering it, and adopting it is a contract change that wants its own
  battery case proving both directions live. The clean fix is to split the
  column into `quotedPostOwnerId`/`quotedReplyOwnerId`, after which each side
  binds cleanly.
- `reply.rootPostId` → `{ "parentOwnerId": "$ownerId" }`. `parentOwnerId` names
  the owner of the **direct** parent, which for a nested reply is another reply's
  owner, not the root post's.
- Any writer gate (`{ "$ownerId": ... }`). Anyone may like, beat or repost anyone
  else's post; a gate would restrict those writes to the referenced post's owner.

### 2. Immutable properties on the mutable doctypes

`post` and `reply` are `documentsMutable: true, canBeDeleted: false`, and the
app's **only** replace is the tombstone in `lib/services/tombstone-helpers.ts`.
Everything structural about a document is therefore frozen by consensus instead of
by convention.

| Doctype | `immutable` | `immutableAllowSetting` |
| --- | --- | --- |
| `post` | `language`, `hashtag`, `quotedPostId`, `quotedReplyId`, `quotedPostOwnerId`, `embedContractId`, `embedDocType`, `embedId`, `deleted` | `deleted` |
| `reply` | `rootPostId`, `replyToReplyId`, `parentOwnerId`, `deleted` | `deleted` |
| `followRequest` | `targetId` | — |

Reasoning per group:

- **`language`** is required and keys `languageTimeline`. Never edited.
- **`hashtag`** was already client-immutable for a consensus reason: existing
  likes repeat it under a checked agreement, so blanking it on a tombstone would
  leave the post claiming "untagged" while its likes still carry the original tag.
  v7 enforces what `post-service.ts` already documented.
- **The quote graph and the embed triple** identify what the document *is*.
  `canBeDeleted: false` exists so references stay resolvable forever; letting a
  replace rewrite or drop one would undo that guarantee for the quote indexes and
  their count trees.
- **A reply's parent linkage.** `rootPostId` keys the thread fetch and its count
  tree; `replyToReplyId` is optional nesting the tombstone already had to preserve
  by hand, or the tombstone and every live reply under it would jump to the top of
  the thread; `parentOwnerId` is the notification target.
- **`deleted`** is the interesting one: immutable *and* settable. A post is
  created without it, a tombstone sets it once, and from then on it can be neither
  changed nor removed. A post cannot be un-deleted, and "deleted" is as permanent
  as the document.
- **`followRequest.targetId`** is required and leads the unique
  `[targetId, $ownerId]` index. The doctype is created, queried and deleted, never
  replaced, so freezing it stops a hypothetical replace from walking one request
  onto a different target. `publicKey` stays mutable — a requester rotating their
  key in place is a coherent future edit.

Frozen **nowhere**, deliberately:

- `content`, `mediaUrl`, `sensitive`, `encryptedContent` — the tombstone blanks
  `content` and drops the rest; freezing any of them makes a tombstone impossible.
- `epoch` and `nonce`. These are the XChaCha20-Poly1305 key-derivation parameters
  *of* `encryptedContent`, which stays mutable. They are one unit with the
  ciphertext: frozen, a tombstone would have to keep decryption parameters for a
  ciphertext it just removed, and re-encrypting a private post in place would
  become impossible while the ciphertext itself stayed replaceable. On their own
  they carry no structural meaning.
- `profile` (`bio`, `website`, `avatarId`, `location`, `bannerUrl`,
  `displayName`), `blockFilter` (`filterData`, `itemCount`, `version`),
  `blockFollow` (`followedBlockers`). Every property on these is exactly the
  user-editable state the doctype exists to hold; they are replaced on every
  profile edit and every block/unblock.

### 3. Countable inference

beta.2 documents that `rangeCountable: true` implies `countable: "countable"` and
drops the `dependentRequired` row that demanded the pairing, so the explicit value
is now noise. v7 removes it from the nine indexes that carried both
(`post.byOwner`, `follow.followerCount`, `like.byPost` / `byHashtagPost` /
`byAuthorPost` / `byDayPost` / `byDayAuthorPost`, `beat.byDayHashtagPost` /
`byRollingHashtagPost`). Indexes countable **without** a range tree
(`post.quoteCount`, `post.quoteReplyCount`, `reply.byRoot`, `reply.byReplyToReply`,
`repost.byPost`, `likeReply.byReply`, `follow.followingCount`) keep theirs.
`"countableAllowingOffset"` is *not* what the inference promotes to and would
still be meaningful, so only the exact redundant value is removed.

### 4. Positions compacted

Removing `post.author` (position 14) left `hashtag` at 15. Offline validation
showed a gap is **accepted**, but v7 is a fresh registration rather than a
contract update, so renumbering costs nothing and keeps positions a contiguous
`0..n-1` sequence. `hashtag` moves 15 → 14; `reply` needed no renumbering
(`author` was last).

### Offline validation

`scripts/validate-contract-offline.mjs` runs the same assembly
`scripts/register-social-v3-draft.mjs` publishes with — `$formatVersion: '1'`,
the contract's own `config` block, its `tokens` block — through
`DataContract.fromJSON(json, /* fullValidation */ true, PlatformVersion.latest())`
with no network and no keys.

```
OK  contracts/yappr-social-contract-v7.json parses under FULL validation
    platform version: 14 (PlatformVersion)
    document types:   17
    freezing types:   followRequest, post, reply
    post: {"immutable":["deleted","embedContractId","embedDocType","embedId","hashtag","language","quotedPostId","quotedPostOwnerId","quotedReplyId"],"immutableAllowSetting":["deleted"]}
    reply: {"immutable":["deleted","parentOwnerId","replyToReplyId","rootPostId"],"immutableAllowSetting":["deleted"]}
    followRequest: {"immutable":["targetId"],"immutableAllowSetting":[]}
```

(`documentTypeImmutableProperties` returns the lists **sorted**, which is why the
order differs from the JSON's schema-position order.)

The harness was negative-probed so that "OK" means something. Each of these is
refused with a clear message: an `immutable` entry naming a system field
(`$ownerId`), one naming an undeclared property, an `immutableAllowSetting` entry
that is not in `immutable`, `immutable` on a doctype that is not
`documentsMutable`, and `rangeCountable: true` paired with
`countable: "notCountable"`.

Two things the offline parse does **not** enforce, and which therefore rest on the
book rather than on a check: a `$creatorId` referenced side on a doctype that does
not record creator ids, and the rule that the referring side of an `$ownerId` pair
must be an identifier property. v7 uses neither escape hatch, and the build
script's self-test asserts the identifier rule locally.

## Client-hack removals and behaviour changes

Topology `v7` is added to `CONTRACT_TOPOLOGIES` in `lib/constants.ts`, which now
generates the `ContractTopology` type and the env validator from one ordered
array.

1. **The attested `author` is no longer written.**
   `authorFieldIsRequired()` becomes a half-open range, `atLeast('v4') &&
   !atLeast('v7')`. Post and reply creates omit the column; tombstones no longer
   preserve it; the seeder's new `authorProps()` mirrors the rule. Nothing
   downstream moves, because `Post.author.id` was always transformed from
   `$ownerId` (`lib/services/post-service.ts`), and a like's `postAuthor` value is
   the same identity it always was — only the *referenced* side of the agreement
   changed. Like and `beat` value tuples are shape-identical to v6, which the
   seeder self-test asserts directly.
2. **Tombstone preservation is a contract-derived set, not a call-site
   convention.** `tombstoneDocument()` takes one
   `TombstonePreservation { identifiers, scalars }` from
   `tombstonePreservationFor(kind)` instead of two ad-hoc arrays assembled
   separately in `post-service.ts` and `reply-service.ts`. On v7 that set is
   exactly the doctype's `immutable` list minus `deleted`.
   `lib/contract-topology.test.ts` pins it against the committed contract JSON and
   fails on drift — necessary, because an under-listed preserve set is no longer a
   silent field loss but a hard on-chain rejection.
   **Visible consequence:** a tombstoned quote or poll post now keeps its quote
   reference and embed triple, where v6 dropped them. `PostCard` short-circuits on
   `deleted` before rendering the body, quote or embed, so nothing of it is shown.
3. **Consensus error 40128 is handled.** `isImmutablePropertyChangedError()` in
   `lib/error-utils.ts` matches the consensus error name, the numeric code and
   Drive's rendered phrasing. `categorizeError()` gives it a permanent
   user-facing message; `retryPostCreation()` refuses to retry it, beside the
   existing `refersTo` bail-out (the shared `'consensus error'` allowlist entry
   would otherwise burn three attempts on a write that can never succeed); and
   the tombstone helper names descriptor/contract drift explicitly rather than
   logging a generic failure.
4. **Version literals are gone from the capability helpers.** They compare
   positions in the ordered topology array (`atLeast(floor)`) instead of
   enumerating cuts, and the descriptor lookup is a record rather than a five-deep
   ternary. This was not tidying: `windowedRankingsAvailable()` was a strict
   `=== 'v6'` that would have silently turned the windowed rankings off on v7,
   as would the seeder's `beatValueTuple` (`!== 'v6'`) and three Playwright
   describe gates.
5. **`waitTimeoutMs` behaviour is unchanged.** The beta.1 WASM panic
   (`PLATFORM_BETA1_UPGRADE.md` §"Confirmed SDK defect") is not addressed by any
   commit in this range. Yappr still never sets `waitTimeoutMs` on any write, so
   every path stays on the non-timeout branch; the transport-level `timeoutMs`
   is distinct and still used.

## Rules learned

- **A replace that DROPS an immutable property is the same rejection as one that
  changes it.** "Differ" covers a changed value, a property the stored document
  lacked, and a property the replacement omitted. Any tombstone-style replace that
  rebuilds a document from scratch must therefore enumerate the frozen set
  exhaustively — which is why that set lives in one place with a test pinning it
  to the contract.
- **An unchanged value is not a change.** Re-stating `deleted: true` on an
  already-tombstoned document is accepted, so a double-delete is harmless.
- **`immutableAllowSetting` only means anything for an optional property.** A
  required one always has a value from creation, so the allowance can never fire.
  The build script asserts this rather than letting it be a silent no-op.
- **Comparison is by underlying data, not bytes.** The replace recurses into
  objects regardless of member order and into arrays position by position, with
  integer widths ignored — because storage reorders object members by schema
  position and narrows integers, so a byte comparison would flag an untouched
  object as changed.
- **`propertyAgreement` absence is strictly symmetric — but only for the paired
  VALUES.** Once a reference resolves, both sides absent agree and one side
  present is the same mismatch a differing value would be; that is what lets an
  agreement key double as a `skipIfAbsent` trigger. An absent *reference
  property* is different: it skips the whole reference, agreement included. So a
  denormalized column shared between two different references (Yappr's
  `quotedPostOwnerId`) is bindable — it just ends up checked on one reference and
  unchecked on the other, which is why v7 leaves it alone rather than
  half-covering it.
- **Preallocation survives an `$ownerId` agreement.** An index is preallocatable
  when every property is the referring property itself or a key of its
  `propertyAgreement` — and the referenced document's `$ownerId` and `$creatorId`
  count as agreement keys.
- **`rangeCountable` implies `countable`, but does not override it.** An explicit
  `"countableAllowingOffset"` is kept; an explicit `"notCountable"` is rejected as
  a contradiction rather than silently promoted.
- **indexOnly creates colliding within one batch are now refused (#4813).** Yappr
  is unaffected: the network caps a document batch at one transition, so the like
  and its `beat` companion already go out sequentially, and they are different
  doctypes.

## Battery

`scripts/verify-v7.mjs` is a thin file of v7 cases on top of
`scripts/verify-lib.mjs`, which holds the machinery every battery shares — the
devnet SDK with its quorum-rotation reconnect proxy, readback-decided write
outcomes, the strict wrong-reason-fails rejection matchers, the PASS/FAIL ledger,
and a `runBattery()` shell owning the CLI, the dry run and the report. That
machinery was extracted verbatim from `verify-v5.mjs`, which is deliberately left
untouched: it is the frozen record of the v5 cut, its `--dry-run` only exercises
shape building, and a rewrite of its live paths could not be validated without
re-running it against a v5 contract that no longer exists on chain.

| Case | What it proves |
| --- | --- |
| `e1` | The `author` column is gone: a post and a reply carrying it are refused, and the same writes without it are accepted (the control). |
| `e2` | `like.postAuthor` agrees with the post's `$ownerId` — the liker's own id, an unrelated id, a wrong tag and both hashtag-absence directions are 40127; the post owner's id is accepted, as is the both-absent direction. |
| `e3` | The `likeReply.replyAuthor` mirror, plus the 40105 duplicate. |
| `e4` | `repost.postOwnerId`, the new binding: a third party's id and the reposter's own id are 40127; the post owner's id is accepted. |
| `f1` | A tombstone that **changes** the required-and-frozen `language`, or **drops** the optional frozen `quotedPostId` or `hashtag`, is 40128; one carrying every immutable property verbatim is accepted. The drop cases use optional properties on purpose: dropping a *required* one is refused by schema validation (10101) before state validation ever reaches the immutability check, so it would prove nothing. |
| `f2` | `deleted` is settable exactly once: reverting it and dropping it are 40128, re-stating `true` is accepted. |
| `f3` | The mutable half still is: a replace may blank `content` and drop `mediaUrl`/`sensitive`. |
| `g1` | The like lifecycle end to end under the new agreement — create, the preallocated `byPost`/`byAuthorPost` counts, the tagged `beat` companion, delete-by-values unlike. |

It runs live only with `--contract <id>` (or `V7_CONTRACT_ID`) and has no default
id. `--self-test` (or `--dry-run`) builds every shape the live run writes,
including both tombstone replaces, and makes no network call.

The v7 battery deliberately does not re-prove v6's query surface: the indexes,
ranked axes and windowed twins are byte-identical, and `verify-v5.mjs`'s A/B/C/D
cases already covered them live.

## Local validation

With the beta.2 packages, on `beta2/social-v7`:

- `npx tsc --noEmit`, `npm run lint`, `npx knip` — clean.
- `npx vitest run` — 383 tests across 49 files, including
  `lib/contract-topology.test.ts` (7 drift guards) and `lib/error-utils.test.ts`
  (11 matcher cases). Both guards were verified to actually fail when the thing
  they pin is mutated: removing a tombstone preserve entry, and shortening the
  e2e spec's copied topology order. The five read-surface suites now stub `v7`
  rather than `v6`, so the deployed topology is the one under test.
- `npm run build:devnet` — the static export succeeds.
- `python3 scripts/build-v7-contract.py --self-test` — 42 checks pass.
- `node scripts/validate-contract-offline.mjs contracts/yappr-social-contract-v7.json`
  — full-validation parse at protocol 14.
- `node scripts/verify-v7.mjs --self-test`, `node scripts/seed/run-seeder.mjs
  --self-test` (9 new v7 cases) — pass.
- `npx playwright test --list topology` — 28 devnet tests collect under v7.

Both SDK dependencies resolve to one beta.2 WASM runtime.

## Deployment

`.env.devnet` is left on `NEXT_PUBLIC_CONTRACT_TOPOLOGY=v6`, matching the v6
contract id still in that file. **The flag and the ids must move as a unit, in
the deploy commit.** This is not bookkeeping: `.github/workflows/deploy.yml`
rebuilds `/devnet` from `.env.devnet` on every push to `staging`, and a v7
client against a v6 contract fails totally rather than degrading — v6 lists
`author` in `post`/`reply` `required`, the v7 client stops writing it, so every
post, reply and tombstone fails schema validation while likes keep working, a
config fault that presents as a posting bug. `scripts/register-social-v3-draft.mjs` (file-agnostic despite the
name) now defaults `--contract-file` to the v7 JSON. Registration order and the
contract-group mechanics are unchanged from the beta.1 document.

## Deployment evidence

Observed on 2026-09-18 against moutai. Live Drive and DAPI both report
`4.2.0-beta.2`, Tenderdash 1.8.0, protocol 14. The Platform state was wiped for
the upgrade and the Core chain persisted, so every identity was restored from
its retained Core asset lock and kept its original id.

### Identities restored (phase 1)

An identity id is the hash of its asset-lock outpoint, so replaying a retained
lock reproduces the id. A preflight proved all 151 locks chain-locked and
hashing to their original ids BEFORE any broadcast; a separate read-only pass
then re-fetched each identity and compared its on-chain public keys with the
retained key material.

| group | restored | top-ups replayed |
| --- | ---: | ---: |
| maker `3JKc6iVG74LEMSrAtB4VSHPQW2mtgKAw8s3Ki6tTFcRQ` | 1 / 1 | 1 / 1 |
| CI `EShbqnfLdmctGWaUCnU3FNKMenYmxiQEiawY3q2pLQm2` | 1 / 1 | 1 / 1 |
| corpus personas (idx 0-99) | 100 / 100 | 237 / 237 |
| non-social personas (idx 200-315) | 48 / 48 | — |
| personal `cLWB9tvMku6XLRwH7zwftos4BTTTgjtCP62MmRL4VfT` | 1 / 1 | — |

151 / 151 present, 151 / 151 key sets matched, 0 problems. Only ChainLock
proofs were used — moutai refuses InstantSend asset-lock proofs.

### Ten contracts, one group, all ids new

The previous social contract `HWZdaqfPuqfVJf7ARomsVdpFPa6P2Bp1Eh9qYZSMEFEQ` and
the beta.1 group `DYDGmjxwQwZhRm7zxp12pd52vB9pCunxEPerF9TfvQZe` were proved
ABSENT on the fresh Platform chain before publication.

A contract id is `generateId(owner, nonce)` and a group id is
`contractGroupId(owner, nonce)` — pure functions of owner and nonce. A maker
restored at nonce 0 therefore reproduces beta.1's ten ids and group id EXACTLY
while the schemas behind them change. A dry run confirmed that byte for byte.
That is the trap the repo has banned since the 08-28 wipe: the browser SDK's
contract cache and `lib/contracts/bundled` are keyed by id and every contract
version is 1, so a cached v6 body passes the staleness check and the client
silently runs v6 semantics against v7. Maker identity nonces 1-10 were therefore
burned first, with ten minimal credit transfers (`IdentityCreditTransfer` carries
the identity nonce; document batches and token transitions carry a separate
`identityContractNonce` and do not move it). The publisher refuses to broadcast
any id that appears in the history of `.env.devnet` or `lib/contracts/bundled`,
in any ref's tree, or already on chain.

Group `2k2bsaqY7Yg8zoUDCqqGypwJYGSiitLYcn38r3mhkNHM`, registered on the social
create at nonce 11. Every contract joins it through
`setContractGroupMemberships` on its own create transition.

| nonce | contract | id |
| ---: | --- | --- |
| 11 | social v7 | `7R7vo8DE2pka17wAgXMnUMWpSox2z8eaLLdZNYJcWraG` |
| 12 | profile | `33nT1FrNnfngaqawEFkGKBsgd3vDK7DrQgGabqXfCk5g` |
| 13 | key backup | `9dxned7wkkiQ5GY4eirxjnYksM2g5KYSdGet4J6bK1eF` |
| 14 | key exchange v2 | `B8yM8Q8kTRGG348xyotqx1xLfSQr6dK7k6PsAWzdCQrG` |
| 15 | vault | `G8tcJgkWtWS3C4iHGokJrW6kXeM1RX64kvNc3epRH1o2` |
| 16 | auth vault | `9WHwJuiYxwFZawe2jLkr51vN9BDAkZ2SV7yM89qaSXcV` |
| 17 | storefront v2 | `6D1UPEqaYDwrnzy7c7STbMM6HBmksbp3zzMgSqr68Bi1` |
| 18 | blog v2 | `G2SebukaFvvgBWS1Q61Me8sWc3TMzAhXt2QvAktuYvvf` |
| 19 | DM v4 | `HBwg5hptWu1Ppgi9NadLad8cAYHHoQjHpUUb1t5w4cjF` |
| 20 | pollr v4 | `7qVgjaNoZexX5xioVgVF8aZh1RsZv7hqtuXGhLtGT9n2` |

A proof-backed readback confirmed all ten: present, maker-owned, version 1, each
enrolled in the group by `forContract`, and the group enumerates exactly ten
members. Publication was two-staged and checkpointed; each stage refuses to run
unless the maker's identity nonce is exactly what it expects, and each contract's
signed transition is persisted before broadcast so a rerun never allocates a
second nonce. The tenth create exhausted the maker's restored balance
(`required 25000100000`, held 14532399010); a top-up is safe mid-publication
because `IdentityTopUpTransition` carries no nonce, so the already-signed
nonce-20 transition stayed valid and stage B resumed onto it.

YAPP `7svkgw5wJrgoGd1ctz1QATsPQb9P9DeCt5khMatK4WdM`: base supply 1,000,000 minted
to the maker, direct-purchase price 1,000,000 credits per token with a 100-token
minimum tier, both `currentPrice` and `basePrice` read back as `1000000`.

### verify-v7.mjs — 30 / 30 live

All e/f/g cases pass against the registered contract, with the verbatim
consensus texts:

- **e1** a post and a reply carrying the removed `author` column are refused by
  structure validation; the same documents without it are accepted.
- **e2** `like.postId` agrees `postAuthor` with the post's `$ownerId` —
  *"the document's postAuthor does not agree with the referenced document's
  $ownerId (propertyAgreement on postId)"* (40127); the hashtag pair holds in
  both directions, absence included.
- **e3** `likeReply.replyId` agrees `replyAuthor` — *"the document's replyAuthor
  does not agree with the referenced document's $ownerId"* (40127); re-liking is
  still the structural duplicate — *"has duplicate unique properties
  ["$ownerId", "replyId"] with other documents"*.
- **e4** `repost.postId` agrees `postOwnerId` — *"the document's postOwnerId does
  not agree with the referenced document's $ownerId"* (40127), for a third party
  and for the reposter alike.
- **f1/f2** immutability — *"property 'language' of document … (type 'post') is
  immutable and cannot be changed by a replace"* (40128), likewise for
  `quotedPostId`, `hashtag` (changed or dropped) and `deleted` (flipped back or
  dropped); re-stating an unchanged value is accepted.
- **f3** the deliberately mutable fields still are; **g1** the like lifecycle,
  the preallocated `byAuthorPost` count and the tagged `beat` companion still
  work end to end.

e3c initially reported a false failure. It is scored by
`attemptCreateIndexOnly`'s acceptance probe, which was entry EXISTENCE — already
true from e3b, so a genuine rejection read as accepted. `likeReply`'s schema is
byte-identical between v6 and v7, and the duplicate is in fact rejected with the
entry count staying at 1. The case now scores by entry count instead.

### Count trees after the `countable` strip — the open question, answered

v7 dropped the explicit `countable` keyword from nine indexes that keep
`rangeCountable`: `follow.followerCount`, `like.byPost`, `like.byHashtagPost`,
`like.byAuthorPost`, `like.byDayPost`, `like.byDayAuthorPost`, `post.byOwner`,
`beat.byDayHashtagPost`, `beat.byRollingHashtagPost`. Offline validation passes
either way, so this was read back LIVE off the seeded corpus. beta.2 does infer
`countable` from `rangeCountable`:

| index | live read |
| --- | --- |
| `post.byOwner` | `count(post where $ownerId == persona 0)` = **135** |
| `follow.followerCount` | `count(follow where followingId == persona 0)` = **54** |
| `like.byAuthorPost` | ranked count, top groups **91, 41, 29, 26, 20** |
| `like.byHashtagPost` | ranked count, top groups **41, 32, 16, 11, 10** |
| `like.byDayPost` | ranked count, top groups **91, 41, 41, 41, 41** |
| `like.byDayAuthorPost` | ranked count, top groups **91, 41, 29, 26, 20** |
| `beat.byDayHashtagPost` | ranked count, top groups **41, 32, 16, 11, 10** |

The windowed axes were read the way the app reads them — `documents.ranked` with
an aggregate count and the day grid, as in `lib/services/ranked-likes.ts`.

### Feature contracts — 198 live checks

| battery | checks | result |
| --- | ---: | --- |
| `verify-storefront-v2.mjs` | 63 | ALL CHECKS PASSED |
| `verify-blog-v2.mjs` | 37 | ALL CHECKS PASSED |
| `verify-dm-v4.mjs` | 31 | ALL CHECKS PASSED |
| `verify-pollr-v4.mjs` | 39 | ALL CHECKS PASSED |
| `verify-tips.mjs` | 28 | ALL CHECKS PASSED |

Seeded alongside: storefront (all checks passed), blog 167 writes / 0 failed,
DM 12 conversations and 246 messages with 12/12 newest decrypting under the
recipient's key, pollr 14 polls + 14 embedded posts + 141 ballots, tips 120/120.

### Corpus

The same 18,000-operation corpus as beta.1 (sha256
`a6b5a23886f4d4eeca8e1d55434ac10e4d6cd1198b8ca7f8882564a67c7a68de`), replayed
under `--topology v7` by the 100 restored personas, each holding a profile, its
DPNS name and 4,000 YAPP.

| operation | count |
| --- | ---: |
| posts | 5,700 |
| quote posts | 268 |
| replies | 2,144 |
| post likes | 8,557 |
| reply likes | 585 |
| follows | 495 |
| reposts | 234 |
| bookmarks | 17 |
| **total** | **18,000** |
| tagged-like `beat` companions | 2,905 |

The folded journal holds exactly 18,000 `done` with no unresolved failures.
Eight late dependency waits timed out before submission on the first pass and
succeeded on a resume once their targets existed — the same class beta.1 saw.

A fresh read-only audit after the writer stopped re-proved all 18,000 operations
and all 2,905 beat companions: stored content, owners and references, every
interaction pair, and an exact seeded-owner census of 5,968 posts (posts plus
quotes) and 2,144 replies. The network also held 12 other-owner replies, from
the batteries, reported separately. The audit asserts that `author` is ABSENT on
every stored post and reply — on v7 ownership is proved by `$ownerId` alone, and
the column's absence is itself an invariant.

### Known-good operational notes

- `sdk.tokens.transfer` takes `senderId`, not an `identity` object; passing the
  object fails with `'senderId' is required` and the balance silently stays 0.
- The seeder's pipelined executor at concurrency 20 sustained ~200 ops/min and
  recovered from 11 transport collapses (quorum rotation and DAPI rate limits)
  without losing an operation; every one was decided by readback.
- Long synchronous work (a repo-wide `git log -p` scan) starves the SDK's event
  loop and surfaces as an unhandled `WasmSdkError` from an in-flight timer. Do
  such work before connecting.

