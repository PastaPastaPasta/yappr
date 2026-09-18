# Platform 4.2.0-beta.2: Yappr upgrade and social contract v7

Covers the beta.1 → beta.2 range only; everything earlier is in
[`PLATFORM_BETA1_UPGRADE.md`](./PLATFORM_BETA1_UPGRADE.md). The contract's own
design — document graph, windowed rankings, costs, registration runbook — is in
[`SOCIAL_CONTRACT.md`](./SOCIAL_CONTRACT.md).

## Versions and scope

| Release | Commit |
| --- | --- |
| `v4.2.0-beta.1` | `c96ff32a8b1e93275c47b9f587c3b89c42758c8c` |
| `v4.2.0-beta.2` | `d09c15de83c807793f1def85cfc834276166f114` (15 commits; protocol version stays 14) |

Both `@dashevo/evo-sdk` and `@dashevo/wasm-sdk` are pinned to exactly
`4.2.0-beta.2`, and `package-lock.json` resolves a **single** WASM runtime. That
pinning is not cosmetic: Yappr imports `@dashevo/wasm-sdk` directly (the identity
update builder, the username helpers, `sdk-helpers`, the composite-feed types),
so a split between the two packages loads two WASM modules into one page.

## What beta.2 changes for Yappr

| Commit | Change | Effect |
| --- | --- | --- |
| [#4815](https://github.com/dashpay/platform/pull/4815) | **`immutable` properties on mutable document types** | **Adopted.** `post`/`reply` freeze their structural columns; `deleted` becomes immutable-but-settable. |
| [#4816](https://github.com/dashpay/platform/pull/4816) | **`propertyAgreement` on `$ownerId`/`$creatorId`; writer gates** (breaking) | **Adopted.** Retires the client-attested `author` column; binds `repost.postOwnerId`. No writer gate is appropriate here. |
| [#4809](https://github.com/dashpay/platform/pull/4809) | v3 meta-schema aggregate prerequisites are **sugar-aware** | `rangeCountable: true` now implies `countable: "countable"`; v7 drops the redundant pairing from the nine indexes that carried both. |
| [#4817](https://github.com/dashpay/platform/pull/4817) | `wasm-dpp2` exposes immutable properties to JS | Used by `scripts/validate-contract-offline.mjs` (`documentTypeImmutableProperties`, `documentImmutableProperties`). |
| [#4813](https://github.com/dashpay/platform/pull/4813) | indexOnly creates that **collide within one batch** are refused | No change needed: the network caps a document batch at one transition, so a like and its `beat` already go out sequentially, and they are different doctypes. |
| [#4811](https://github.com/dashpay/platform/pull/4811) | Key limits on every client (breaking) | **Additive in practice.** wasm-dpp2 only adds optional `totalBudget`/`expiresAt` accessors to `IdentityPublicKey(InCreation)`; the constructor shape is unchanged, so `lib/services/identity-update-builder.ts` behaves identically. Yappr creates no limited keys yet. |
| [#4806](https://github.com/dashpay/platform/pull/4806) | Protocol 14 marked shipped | The v3 document meta-schema is now editable only until 4.2 is live on **mainnet**, not until the protocol-14 release ships. |

The remaining eight commits (#4807, #4812, #4810, #4797, #4738, #4820, #4804 and
the release chore) are new transition kinds Yappr does not issue, consensus or
proof-verification hardening, provisioning reliability, and upstream CI. **No
query shape, ranked/count/timeRange grammar or proof format changes in this
range**, which is why v7's read surface is byte-for-byte the previous cut's.

## Contract v7

`contracts/yappr-social-contract-v7.json` is the artifact — it is not generated
at build time. `scripts/validate-contract-offline.mjs` parses it through the
real beta.2 wasm and then re-checks every invariant below. The diff against the
previous cut was four things and nothing else.

### 1. System-field `propertyAgreement` retires the attested `author`

Earlier cuts added a required, poster-attested `author` identifier to `post` and
`reply` for exactly one reason: a `propertyAgreement` pair could only name a
**schema** property of the referenced document, so a like could not be bound to
its post's real owner. The column was a duplicate of `$ownerId` that consensus
could only ever check against *itself*.

beta.2 lets the referenced side of a pair be `$ownerId` or `$creatorId`. v7 uses
it and deletes the column from `post` and `reply` (properties and `required`).
Every `propertyAgreement` in v7, in full:

| Doctype | Referring property | Agreement |
| --- | --- | --- |
| `like` | `postId` → `post` | `{ "hashtag": "hashtag", "postAuthor": "$ownerId" }` |
| `likeReply` | `replyId` → `reply` | `{ "replyAuthor": "$ownerId" }` |
| `repost` | `postId` → `post` | `{ "postOwnerId": "$ownerId" }` — **new in v7** |
| `beat` | `postId` → `post` | `{ "hashtag": "hashtag" }` — unchanged |

`repost` is a genuine tightening. `repost.postOwnerId` feeds the
`postOwnerAndTime` index that answers "who reposted my post?", and until v7 a
client could put any identity there — sending a stranger a notification for a
post that is not theirs. Binding it is safe because the value was already
correct everywhere it is written: the single caller
(`hooks/use-post-engagement.ts`) passes `post.author.id`, which
`lib/services/post-service.ts` transforms from `$ownerId`, and reposting is
gated to `kind === 'post'`; the seeder passes the target ref's `ownerId`.

Three bindings were considered and **rejected**:

- `post.quotedPostId` → `{ "quotedPostOwnerId": "$ownerId" }` — **deferred.**
  `quotedPostOwnerId` is a shared denormalization: `resolve-quoted-posts.ts`
  writes it when quoting a **reply** too, where the reference lives in
  `quotedReplyId`. The binding would be safe (an absent reference property skips
  its whole reference) but would only **half** cover the column — post-quotes
  checked, reply-quotes not, since binding `quotedReplyId` instead is the mirror
  problem. The clean fix is to split the column into
  `quotedPostOwnerId`/`quotedReplyOwnerId`, after which each side binds cleanly.
- `reply.rootPostId` → `{ "parentOwnerId": "$ownerId" }`. `parentOwnerId` names
  the owner of the **direct** parent, which for a nested reply is another
  reply's owner, not the root post's.
- Any writer gate (`{ "$ownerId": ... }`). Anyone may like, beat or repost
  anyone else's post; a gate would restrict those writes to the post's owner.

### 2. Immutable properties on the mutable doctypes

`post` and `reply` are `documentsMutable: true, canBeDeleted: false`, and the
app's **only** replace is the tombstone in `lib/services/tombstone-helpers.ts`.

| Doctype | `immutable` | `immutableAllowSetting` |
| --- | --- | --- |
| `post` | `language`, `hashtag`, `quotedPostId`, `quotedReplyId`, `quotedPostOwnerId`, `embedContractId`, `embedDocType`, `embedId`, `deleted` | `deleted` |
| `reply` | `rootPostId`, `replyToReplyId`, `parentOwnerId`, `deleted` | `deleted` |
| `followRequest` | `targetId` | — |

- **`language`** is required and keys `languageTimeline`; never edited.
- **`hashtag`** was already client-immutable for a consensus reason: existing
  likes repeat it under a checked agreement, so blanking it on a tombstone would
  leave the post claiming "untagged" while its likes carry the original tag.
- **The quote graph and the embed triple** identify what the document *is*.
  `canBeDeleted: false` exists so references stay resolvable forever; letting a
  replace rewrite or drop one would undo that for the quote indexes and their
  count trees.
- **A reply's parent linkage.** `rootPostId` keys the thread fetch and its count
  tree; `replyToReplyId` is optional nesting the tombstone already had to
  preserve by hand, or the tombstone and every live reply under it would jump to
  the top of the thread; `parentOwnerId` is the notification target.
- **`deleted`** is immutable *and* settable: created absent, set once by a
  tombstone, then neither changeable nor removable. A post cannot be un-deleted.
- **`followRequest.targetId`** leads the unique `[targetId, $ownerId]` index.
  The doctype is created, queried and deleted, never replaced, so freezing it
  stops a hypothetical replace from walking one request onto a different target.
  `publicKey` stays mutable — a requester rotating their key is a coherent edit.

Frozen **nowhere**, deliberately: `content`, `mediaUrl`, `sensitive` and
`encryptedContent`, because the tombstone blanks or drops them; `epoch` and
`nonce`, which are the key-derivation parameters *of* `encryptedContent` and are
one unit with a ciphertext that stays mutable; and every property of `profile`,
`blockFilter` and `blockFollow`, which is exactly the user-editable state those
doctypes exist to hold.

### 3. Countable inference

`rangeCountable: true` implies `countable: "countable"`, and beta.2 drops the
`dependentRequired` row that demanded the pairing, so the explicit value is
noise. v7 removes it from the nine indexes that carried both. Indexes countable
**without** a range tree keep theirs. `"countableAllowingOffset"` is *not* what
the inference promotes to and would still be meaningful, so only the exact
redundant value is removed. Both sets are pinned in the offline validator.

### 4. Positions compacted

Removing `post.author` (position 14) left `hashtag` at 15. Offline validation
showed a gap is **accepted**, but v7 is a fresh registration rather than a
contract update, so renumbering costs nothing and keeps positions a contiguous
`0..n-1` sequence.

### Offline validation

`scripts/validate-contract-offline.mjs` runs the same assembly
`scripts/register-social-v3-draft.mjs` publishes with — `$formatVersion: '1'`,
the contract's own `config` and `tokens` blocks — through
`DataContract.fromJSON(json, /* fullValidation */ true, PlatformVersion.latest())`
with no network and no keys, then asserts the invariants above against both the
raw JSON and the wasm-parsed contract:

```
OK  contracts/yappr-social-contract-v7.json parses under FULL validation
    platform version: 14 (PlatformVersion)
    document types:   17
    freezing types:   followRequest, post, reply

PASS  every propertyAgreement is exactly the declared set …
…
SOCIAL INVARIANTS PASSED
```

`documentImmutableProperties` is empty below protocol 14 even when the raw
schema carries the keywords, so a non-empty map is itself the protocol-14 proof.

Both halves were negative-probed so that "OK" means something. The wasm parse
refuses an `immutable` entry naming a system field or an undeclared property, an
`immutableAllowSetting` entry that is not in `immutable`, `immutable` on a
non-`documentsMutable` doctype, and `rangeCountable: true` paired with
`countable: "notCountable"`. The invariant checks fail on a reinstated `author`
column, a changed agreement, a dropped `immutable` entry, a reinstated redundant
`countable`, and a position gap.

One thing the parse does **not** enforce, and which therefore rests on the book:
a `$creatorId` referenced side on a doctype that does not record creator ids.
(The other unenforced rule — that the referring side of an `$ownerId` pair must
be an identifier property — the validator asserts itself.)

## Client changes

1. **The attested `author` is no longer written.** Post and reply creates omit
   the column and tombstones no longer preserve it. Nothing downstream moves:
   `Post.author.id` was always transformed from `$ownerId`
   (`lib/services/post-service.ts`), and a like's `postAuthor` value is the same
   identity it always was — only the *referenced* side of the agreement changed.
   Like and `beat` value tuples are shape-identical to the previous cut, which
   the seeder self-test asserts directly.
2. **Tombstone preservation is a contract-derived set, not a call-site
   convention.** `tombstoneDocument()` takes one
   `TombstonePreservation { identifiers, scalars }` from
   `tombstonePreservationFor(kind)` instead of two ad-hoc arrays assembled
   separately in `post-service.ts` and `reply-service.ts`. On v7 that set is
   exactly the doctype's `immutable` list minus `deleted`.
   `lib/contract-topology.test.ts` pins it against the committed contract JSON —
   necessary, because an under-listed preserve set is no longer a silent field
   loss but a hard on-chain rejection.
   **Visible consequence:** a tombstoned quote or poll post now keeps its quote
   reference and embed triple. `PostCard` short-circuits on `deleted` before
   rendering the body, quote or embed, so nothing of it is shown.
3. **Consensus error 40128 is handled.** `isImmutablePropertyChangedError()` in
   `lib/error-utils.ts` matches the consensus error name, the numeric code and
   Drive's rendered phrasing. `categorizeError()` gives it a permanent
   user-facing message; `retryPostCreation()` refuses to retry it, beside the
   existing `refersTo` bail-out (the shared `'consensus error'` allowlist entry
   would otherwise burn three attempts on a write that can never succeed); and
   the tombstone helper names descriptor/contract drift explicitly.
4. **`waitTimeoutMs` behaviour is unchanged.** The beta.1 WASM panic
   (`PLATFORM_BETA1_UPGRADE.md` §"Confirmed SDK defect") is not addressed by any
   commit in this range. Yappr still never sets `waitTimeoutMs` on any write, so
   every path stays on the non-timeout branch; the transport-level `timeoutMs`
   is distinct and still used.

## Rules learned

- **A replace that DROPS an immutable property is the same rejection as one that
  changes it.** "Differ" covers a changed value, a property the stored document
  lacked, and a property the replacement omitted. Any tombstone-style replace
  that rebuilds a document from scratch must enumerate the frozen set
  exhaustively — which is why that set lives in one place with a test pinning it
  to the contract.
- **An unchanged value is not a change.** Re-stating `deleted: true` on an
  already-tombstoned document is accepted, so a double-delete is harmless.
- **`immutableAllowSetting` only means anything for an optional property.** A
  required one always has a value from creation, so the allowance can never
  fire. The offline validator asserts this rather than letting it be a silent
  no-op.
- **Comparison is by underlying data, not bytes.** The replace recurses into
  objects regardless of member order and into arrays position by position, with
  integer widths ignored — storage reorders members by schema position and
  narrows integers, so a byte comparison would flag an untouched object as
  changed.
- **`propertyAgreement` absence is strictly symmetric — but only for the paired
  VALUES.** Once a reference resolves, both sides absent agree and one side
  present is the same mismatch a differing value would be; that is what lets an
  agreement key double as a `skipIfAbsent` trigger. An absent *reference
  property* is different: it skips the whole reference, agreement included
  (`Ok(None) => continue` in rs-drive-abci `document_reference_validation`). So
  a denormalized column shared between two references is bindable — it just ends
  up checked on one and unchecked on the other.
- **Preallocation survives an `$ownerId` agreement.** An index is preallocatable
  when every property is the referring property itself or a key of its
  `propertyAgreement`, and the referenced document's `$ownerId`/`$creatorId`
  count as agreement keys — which is why `like.byAuthorPost` keeps the flag.
- **`rangeCountable` implies `countable`, but does not override it.** An
  explicit `"countableAllowingOffset"` is kept; an explicit `"notCountable"` is
  rejected as a contradiction rather than silently promoted.

## Battery

`scripts/verify-v7.mjs` is a thin file of v7 cases on top of
`scripts/verify-lib.mjs`, which holds the machinery — the devnet SDK with its
quorum-rotation reconnect proxy, readback-decided write outcomes, the strict
wrong-reason-fails rejection matchers, the PASS/FAIL ledger, and a
`runBattery()` shell owning the CLI, the dry run and the report. Each case is a
table of `[label, write, ACCEPT | expected-rejection]` rows: a refused write
leaves the chain untouched, so rejection rows are order-independent and the
table is as strong as the same cases written out longhand.

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

It runs live only with `--contract <id>` (or `V7_CONTRACT_ID`) and has no
default id. `--self-test` (or `--dry-run`) builds every shape the live run
writes, including both tombstone replaces, and makes no network call.

The battery deliberately does not re-prove the previous cut's query surface: the
indexes, ranked axes and windowed twins are byte-identical, and that cut's
battery covered them live.

## Local validation

With the beta.2 packages:

- `npx tsc --noEmit`, `npm run lint`, `npx knip` — clean.
- `npx vitest run` — 384 tests across 49 files, including
  `lib/contract-topology.test.ts` and `lib/error-utils.test.ts`. Both guards
  were verified to actually fail when the thing they pin is mutated.
- `npm run build:devnet` — the static export succeeds.
- `node scripts/validate-contract-offline.mjs contracts/yappr-social-contract-v7.json`
  — full-validation parse at protocol 14, all social invariants pass.
- `node scripts/verify-v7.mjs --self-test`, `node scripts/seed/run-seeder.mjs
  --self-test` — pass.
- `npx playwright test --list topology` — 21 devnet tests collect under v7.

Both SDK dependencies resolve to one beta.2 WASM runtime.

## Deployment

**The contract ids and `NEXT_PUBLIC_CONTRACT_TOPOLOGY` must move as a unit, in
the deploy commit.** `.github/workflows/deploy.yml` rebuilds `/devnet` from
`.env.devnet` on every push to `staging`, and a v7 client against an older
contract fails totally rather than degrading — the older cut lists `author` in
`post`/`reply` `required`, the v7 client stops writing it, so every post, reply
and tombstone fails schema validation while likes keep working: a config fault
that presents as a posting bug. `getContractTopology()` therefore THROWS on a
`NEXT_PUBLIC_CONTRACT_TOPOLOGY` that is set but is not a cut this build knows,
and `app/contract/page.tsx` resolves it at module scope, so `next build` fails
rather than silently falling back to v2 and shipping a client for the wrong
contract. The seeder's `defaultTopology()` throws for the same reason. `scripts/register-social-v3-draft.mjs`
(file-agnostic despite the name) defaults `--contract-file` to the v7 JSON.
Registration order and contract-group mechanics are unchanged from the beta.1
document; the full runbook is in [`SOCIAL_CONTRACT.md`](./SOCIAL_CONTRACT.md).

## Deployment evidence

> **Stub — to be filled by the deployment.** Nothing below has been observed yet.
> Record here, with the same standard as the beta.1 document: the live
> Drive/DAPI version and protocol; the registered v7 contract id, its owner and
> its contract-group membership; proof that the previous social contract is
> absent or superseded; the `verify-v7.mjs` result (case by case, with the
> verbatim 40127/40128 rejection texts it captures); a live readback of
> `documentTypeImmutableProperties` on the registered contract; the seeded
> corpus totals; and the browser topology-suite result. A contract id printed by
> a publish call is not evidence that the contract is on chain — reconcile it
> with a proved fetch.
>
> One claim neither the offline parse nor any self-test can prove, and which
> therefore belongs here: that beta.2 really does **infer** `countable` from
> `rangeCountable`. Offline validation passes either way, and a wrong inference
> would silently kill the count trees behind `post.byOwner`,
> `follow.followerCount` and the five `like`/`beat` ranked axes that lost their
> explicit `countable`. Read one count back live off a stripped index before
> declaring the cut good.
