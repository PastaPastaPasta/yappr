# Platform 4.2.0-beta.1: Yappr upgrade and deployment

Investigation date: 2026-09-17. This document separates changes already adopted for
Moutai dev.11 from changes introduced in beta.1. Deployment evidence belongs at the
end; the release tag alone does not establish that a particular network was reset.

## Versions and scope

| Release | Commit | Changes reviewed |
| --- | --- | --- |
| `v4.2.0-dev.10` | `1a169881b492f174f842444d993d3e87ba5e8063` | Starting point; composite verification and compound-cursor fixes were already shipped. |
| `v4.2.0-dev.11` | `08d5f1ca9e3205eeaa3fcc08e47f045e653018c7` | 28 commits after dev.10. |
| `v4.2.0-beta.1` | `c96ff32a8b1e93275c47b9f587c3b89c42758c8c` | 49 additional commits; protocol version remains 14. |

Sources:

- [Beta.1 release](https://github.com/dashpay/platform/releases/tag/v4.2.0-beta.1)
- [Complete changelog at the release](https://github.com/dashpay/platform/blob/v4.2.0-beta.1/CHANGELOG.md)
- [dev.10 to dev.11 comparison](https://github.com/dashpay/platform/compare/v4.2.0-dev.10...v4.2.0-dev.11)
- [dev.11 to beta.1 comparison](https://github.com/dashpay/platform/compare/v4.2.0-dev.11...v4.2.0-beta.1)

The beta.1 release also summarizes everything in Platform 4.2 since 4.1. Document
references, `requiredSince`, indexOnly types, ranked indexes, time-range windows,
TTL, chained/composite queries and compound cursors in that summary are not all new
in beta.1. Yappr already uses many of them.

## Required application and deployment work

1. Align `@dashevo/evo-sdk` and `@dashevo/wasm-sdk` to exactly `4.2.0-beta.1`.
   Before this upgrade, staging used evo-sdk dev.11 and a direct wasm-sdk dev.10;
   the lockfile contained both WASM releases. The direct dependency is used at
   runtime by the identity update builder and username helpers, not just for types.
2. Verify the target network version, old maker identity and contract presence.
   After a reset, register funded identities and republish all ten contracts:
   social v6, profile, DM, storefront, key backup, key exchange, vault, auth vault,
   blog and Pollr. Use a separate deployment ledger and retain the recovery seed
   outside the repository.
3. Keep the social contract's `v6` topology and seven-day ranking TTL. The actual
   beta.1 diff introduces no new document schema, `refersTo`, property-agreement,
   indexOnly, timeRange, TTL or composite grammar requirement for this deployment.
4. Retain the existing contract-cloning correction: doctypes with
   `documentsKeepHistory: true` must declare `canBeDeleted: false`. This applies to
   the legacy blog schema copied from testnet.
5. Replace the public contract IDs, maker/token authority and E2E identity IDs
   together. Refresh and prune the bundled Moutai contract snapshot. Old bundled
   contracts and browser-persisted SDK caches are not evidence that an old contract
   still exists on a reset chain.
6. Recreate profiles, usernames and representative social activity. Fund YAPP for
   identities that will post; reset its direct-purchase price and minimum purchase.
   Preserve like/beat companion writes so both all-time and windowed views have data.
7. Validate live reads and writes as well as the local build: empty and populated
   rankings, direct first-page composite, later-page timeline cursors, indexOnly
   unlike/delete, replies, quoted posts, names and reference enforcement.

Contract group membership is a useful deployment-time addition, described below.
Using restricted or limited login keys is a separate application feature.

## Dev.11 work already adopted by Yappr

[Yappr #403](https://github.com/PastaPastaPasta/yappr/pull/403), commit
`2a47957f491dc9965f6f64b87674f9a4db69404e`, re-provisioned Moutai after its dev.11
reset. It registered a new maker, two bots and all ten contracts, and refreshed the
bundled contract snapshot. Its application changes included:

- Devnet protocol-version floor 14, removing the prior DPNS warm-up fetch.
- Direct use of `contracts.addKnown` and `contracts.getLatestVersions`.
- Bundled contracts decoded without reapplying today's structural rules to
  contracts accepted under earlier rules.
- Contract-version revalidation outside the initial rendering path.
- Ranked/composite homepage support with a timeline fallback for older networks.

| Platform dev.11 change | Yappr relevance |
| --- | --- |
| Contract enumeration [#4733](https://github.com/dashpay/platform/pull/4733), Swift/Kotlin exposure [#4734](https://github.com/dashpay/platform/pull/4734) | Optional contract discovery; not needed by known-ID app queries. |
| Devnet PV14 floor and learned-version persistence [#4735](https://github.com/dashpay/platform/pull/4735) | Already adopted. |
| Contract persistence [#4744](https://github.com/dashpay/platform/pull/4744), explicit seeding [#4746](https://github.com/dashpay/platform/pull/4746) | Already adopted through bundled snapshots and SDK persistence. |
| Latest-version query [#4739](https://github.com/dashpay/platform/pull/4739), version-only items [#4749](https://github.com/dashpay/platform/pull/4749) | Already used for cheap freshness checks; #4749 changes the PV14 contract tree. |
| Empty pinned-prefix ranking/HAVING proofs [#4753](https://github.com/dashpay/platform/pull/4753) | Fresh days and unused hashtags return proved empty pages. GroveDB became 6.0.1. |
| Perpetual distribution caps [#4747](https://github.com/dashpay/platform/pull/4747), epoch weighting [#4750](https://github.com/dashpay/platform/pull/4750), zero-interval rejection [#4752](https://github.com/dashpay/platform/pull/4752) | YAPP has `perpetualDistribution: null`; no token redesign required. |
| Stuck dust withdrawals [#4737](https://github.com/dashpay/platform/pull/4737) | Network reliability; no Yappr withdrawal flow found. |
| Committed-block finality on failed checkpoint [#4748](https://github.com/dashpay/platform/pull/4748) | Node reliability. |
| Native WASM-build import fix [#4743](https://github.com/dashpay/platform/pull/4743) | Build correctness upstream; no app API change. |

The remaining dev.11 commits cover shielded-wallet snapshots, shutdown ordering,
interrupted restore, native tests and CI. They require no Yappr schema changes.

## New beta.1 changes

| Change | Effect on Yappr |
| --- | --- |
| Contract groups [#4791](https://github.com/dashpay/platform/pull/4791), group queries [#4792](https://github.com/dashpay/platform/pull/4792) | Can declare Yappr's contract family at publication and prove membership. |
| Contract/document-type authentication bounds [#4780](https://github.com/dashpay/platform/pull/4780) | Future scoped application keys. Existing unrestricted keys remain usable. |
| Group-bound authentication keys [#4793](https://github.com/dashpay/platform/pull/4793), review hardening [#4801](https://github.com/dashpay/platform/pull/4801) | One application key can cover a declared contract family. Requires login/key-selection work to adopt. |
| Authentication-key budgets/expiry [#4798](https://github.com/dashpay/platform/pull/4798), budget query [#4802](https://github.com/dashpay/platform/pull/4802) | Consensus supports limited sessions; convenience creation and usable-key selection helpers remain follow-up work. |
| Concurrent quorum prefetch; explicit-address discovery skip [#4766](https://github.com/dashpay/platform/pull/4766) | Automatic startup improvement with Yappr's configured devnet addresses. |
| DPNS identity record conversion [#4769](https://github.com/dashpay/platform/pull/4769) | Native name resolution accepts Identifier, byte-array and base58 text forms. Existing native-first resolution benefits automatically. |
| Transaction-aware contract cache [#4755](https://github.com/dashpay/platform/pull/4755) | An aborted block cannot leave an uncommitted contract in Drive's cache. Helps contract creation/update reliability. |
| Contested document collision rejection [#4662](https://github.com/dashpay/platform/pull/4662), vote-tree recreation [#4758](https://github.com/dashpay/platform/pull/4758) | DPNS consensus hardening, including re-contesting a resource. |
| DashPay profile shielded address [#4768](https://github.com/dashpay/platform/pull/4768) | System DashPay schema change, not a required change to Yappr's separate profile schema. |
| Withdrawal accounting normalization [eaf5d4c698](https://github.com/dashpay/platform/commit/eaf5d4c698) | Fee-inclusive minimums and Core-fee accounting/caps. No active Yappr Platform-withdrawal call found. |
| Persisted protocol-version votes [#4754](https://github.com/dashpay/platform/pull/4754) | Votes survive restart for the epoch tally. |
| Incremental state persistence [#4571](https://github.com/dashpay/platform/pull/4571), compact auxiliary entries [#4772](https://github.com/dashpay/platform/pull/4772) | Node performance and persistence improvements. |
| Block timing [#4573](https://github.com/dashpay/platform/pull/4573), prompt withdrawal blocks [#4741](https://github.com/dashpay/platform/pull/4741), Tenderdash 1.8 [#4661](https://github.com/dashpay/platform/pull/4661) | Node diagnostics, scheduling and underlying consensus-engine upgrade. |
| Live Tenderdash app-version status [#4136](https://github.com/dashpay/platform/pull/4136) | More accurate operator status reporting. |

Remaining beta.1 changes reviewed, without application migration requirements:

- Platform wallet: asset-lock resume race #4636, persistent ownership of unconfirmed
  outgoing sends #4659, swept-payment verdict #4651, HASH160 profile signing #4653,
  shared provider-key reconstruction #4587, and a duplicate dev-dependency repair.
- Android/Kotlin: keystore recovery on defective devices #4643, ordered wallet
  startup #4658 and publishing/POM handling #4759.
- Swift: off-main contract queries #4775, native error-type preservation and French
  mnemonic regression coverage #4454.
- JS withdrawal test minimums #4781; aggregate `groupBy` documentation #4576.
- Nightly test scheduling #4757, PR-hygiene revisions, skill naming and release files.

The existing JS document APIs are unchanged. New facades are
`sdk.contractGroups.{info,members,forContract}` and
`sdk.identities.keysRemainingBudgets` (with corresponding proof-info variants).

## Contract groups at deployment

The beta.1 release summary calls these groups of identities, but the actual
[protocol definition](https://github.com/dashpay/platform/blob/v4.2.0-beta.1/docs/protocol/contract-groups.md)
is an identity-owned set of **contracts, document types and tokens**. This is
separate from a data contract's `groups` field for token governance.

A `DataContractCreateTransition` V1 can register a group and enroll its new contract
in that group atomically. Later contract creates by the group owner or an admin can
enroll those new contracts. Membership is recorded only at contract creation;
there is no update or leaving. This is why a fresh deployment is the useful time
to establish the group, even if scoped login keys are a later feature.

- Group registration is `{ name?, description?, admins? }`; there is no separate
  counter, label or user-supplied ID.
- The group ID is `sha256d("contract_group" || ownerIdBytes || nonceU64BigEndian)`.
- Use the same identity nonce that creates the first contract. The contract's own
  ID uses `sha256d(ownerIdBytes || nonceU64BigEndian)` and therefore differs.
- `name` is 1–64 characters when present; `description` is 1–256. Optional admins
  are existing non-masternode identities, at most 16, excluding the owner.
- Enroll whole contracts with `{ contractGroupId, member: "contract" }`.
  Whole-contract membership covers its document types and tokens, including future
  additions. Do not also declare redundant individual members for the same group.
- Each contract can carry at most 16 membership declarations. Ten contracts in one
  group are ten separate create transitions, each with one declaration.

The beta.1 `contracts.publish` convenience options do not carry group fields. The
WASM DPP exposes an explicit path:

```js
const create = new DataContractCreateTransition(dataContract, nonce, platformVersion);
// First contract only:
create.setContractGroup({ name: 'Yappr', description: 'Yappr devnet contracts' });
// Every contract, including the first. This setter takes bytes for the ID.
create.setContractGroupMemberships([
  { contractGroupId: groupIdBytes, member: 'contract' },
]);
const transition = create.toStateTransition();
transition.verifyPublicKey(identityKey);
transition.sign(privateKey, identityKey);
await sdk.stateTransitions.broadcastAndWait(transition, settings);
```

`identityKey` must be an enabled CRITICAL authentication key suitable for contract
creation. Use one SDK/WASM module instance for contracts, keys and transitions.
Read the owner's confirmed nonce before assembly; serialize deployment writes.
After a timeout, reconcile the expected contract ID and group membership before
allocating another nonce. A timeout can follow successful publication.

Readback uses `contracts.fetch(contractId)`, `contractGroups.info(groupId)` and
`contractGroups.forContract(contractId)`. The full family is enumerable using
`contractGroups.members({contractGroupId, kind:'contracts', limit:100})`, following
`nextStartAfter` until absent. Explicitly add the proved contract to the SDK cache
with `contracts.addKnown` when using the generic transition path.

Setting these fields on the create transition does not mutate the data contract's
`groups`, YAPP token rules or document schemas. Offline beta.1 WASM checks verified
that the assembled v6 contract survives grouped transition construction, signing,
and JSON/byte round trips unchanged, and a subsequent membership-only create works.
These checks do not substitute for on-chain group readback.

## Scoped and limited authentication: remaining application work

Sources:

- [Contract-bound authentication rules](https://github.com/dashpay/platform/blob/v4.2.0-beta.1/docs/protocol/contract-bound-authentication-keys.md)
- [Budgets and expiry rules](https://github.com/dashpay/platform/blob/v4.2.0-beta.1/docs/protocol/authentication-key-limits.md)

Scoped authentication keys are non-MASTER and can sign only in-scope batch
operations. They cannot sign identity updates, contract writes, credit transfers,
withdrawals or votes. Whole-contract/group scope can include token operations;
document-type scope cannot. Group membership can grow as its owner/admins publish
new members, so trusting a group also trusts that future scope expansion.

A V1 identity public key may carry `totalBudget` in credits and `expiresAt` in
milliseconds. The budget covers fees and outgoing credits such as purchases; it
is not a token-amount cap. Metered processing fees may overshoot the remaining
budget on a final transition. Limits are immutable; a replacement key is needed
to grant more. Keys without limits remain V0 and retain existing behavior.

Beta.1 can read remaining budgets through `identities.keysRemainingBudgets`.
However, the protocol documentation explicitly excludes SDK convenience helpers
for creating limited keys and choosing usable signing keys. The WASM public-key
constructor still builds V0; canonical JSON/object conversion delegates to the
new enum. Yappr's own normalized key shape does not preserve budget/expiry fields
and its selection flow does not implement those eligibility checks.

A follow-up adopting this feature should preserve the fields, check scope,
expiry and remaining budget, implement renewal/revocation UI, and distinguish
consensus refusals from transport failures. Group-bound or limited keys cannot be
registered through shielded identity creation; add them later through an identity
update. This deployment need not change existing user keys to use these features.

## Ranking TTL retained

The v6 schema's time-range indexes retain `ttl: 604800` seconds:

| Index | Window | Step |
| --- | --- | --- |
| `like.byDayPost` | 86400 seconds | 86400 seconds |
| `like.byDayAuthorPost` | 86400 seconds | 86400 seconds |
| `beat.byDayHashtagPost` | 86400 seconds | 86400 seconds |
| `beat.byRollingHashtagPost` | 86400 seconds | 21600 seconds |

`beat.byPost` and `beat.byPostTime` remain permanent indexes used to find delete
tuples. Expiring old time buckets does not delete every like row or the all-time
ranking. There is no additional beta.1 TTL schema change.

## Correction to the earlier composite diagnosis

[Platform #4729](https://github.com/dashpay/platform/pull/4729) changed shared
`rs-drive` code that also runs inside the SDK verifier. It normalized composite
component limits into per-instance caps so subset verification uses the same
budget form as the merged proof.

For the original multi-component timeline composition, the merged query is
unchanged byte-for-byte. The old client misread that proof with a global limit;
updating client verification can fix that shape. It was inaccurate to claim that
every old node necessarily generated an invalid proof requiring a backend upgrade.

The same PR also corrected server materialization across empty preallocated
branches and page-only proof construction. Those cases do require the server-side
change. Beta.1 includes both, but the distinction matters when diagnosing the
original error.

No composite query grammar changed after dev.10 in this range. Composite pages
still lack document cursors, so Yappr's ordinary timeline cursor path for later
pages remains justified, particularly when timestamps tie. The intermediate-index
proof-size concern is separate, tracked in [GroveDB #962](https://github.com/dashpay/grovedb/issues/962);
this release range does not establish that it was fixed.

## Confirmed SDK defect: `waitTimeoutMs` panics in WASM

The published beta.1 SDK crashes when an explicit `waitTimeoutMs` reaches the
shared state-transition wait path. This was reproduced in Node.js 22.23.2 with
`@dashevo/evo-sdk@4.2.0-beta.1`; it is an SDK runtime defect, not a rejected
contract or a GroveDB proof error. The initial social and profile publications
both landed before their confirmation waits crashed.

The release source explains the failure:

- [`PutSettingsInput` conversion](https://github.com/dashpay/platform/blob/c96ff32a8b1e93275c47b9f587c3b89c42758c8c/packages/wasm-sdk/src/settings.rs#L229)
  maps `waitTimeoutMs` to `Some(Duration)`.
- [The shared wait implementation](https://github.com/dashpay/platform/blob/c96ff32a8b1e93275c47b9f587c3b89c42758c8c/packages/rs-sdk/src/platform/transition/broadcast.rs#L438)
  then calls `tokio::time::timeout` without a WASM-specific implementation.
  That timer reaches the unsupported standard-library clock and panics with
  `library/std/src/sys/time/unsupported.rs:13:9: time not implemented on this platform`.
- [The generic WASM API](https://github.com/dashpay/platform/blob/c96ff32a8b1e93275c47b9f587c3b89c42758c8c/packages/wasm-sdk/src/state_transitions/broadcast.rs#L155)
  forwards these settings unchanged. The Rust broadcast happens before the wait,
  so a panic does not establish that the write failed.

A read-only A/B reproduction used the same already-published social-contract
transition, avoiding another broadcast:

```js
// sdk is connected; confirmedTransition is the retained, already-published ST.
// Run each case in a separate Node process because the panic terminates WASM.
await sdk.stateTransitions.waitForResponse(confirmedTransition, {
  timeoutMs: 10000,
  waitTimeoutMs: 90000,
}); // Rust panic / RuntimeError: unreachable, process exit 1

await sdk.stateTransitions.waitForResponse(confirmedTransition, {
  timeoutMs: 10000,
}); // verified response, process exit 0
```

Both cases completed in under one second; the failure is timer construction,
not expiry of the requested 90-second deadline. The source and successful control
isolate `waitTimeoutMs` as the trigger. Private operational artifacts retain the
exact reproduction and control logs; no new state transition was submitted.

The affected path is shared by `waitForResponse`, `broadcastAndWait`,
`waitForAffectedState` and `broadcastAndWaitForAffectedState`. Higher-level writes
that pass `settings.waitTimeoutMs` can also reach it: for example,
[`documents.create` forwards its optional settings](https://github.com/dashpay/platform/blob/c96ff32a8b1e93275c47b9f587c3b89c42758c8c/packages/wasm-sdk/src/state_transitions/document.rs#L199)
to the same SDK wait machinery. Yappr's ordinary provisioning and document writes
do not set that field, so they use the non-timeout branch. The transport setting
`timeoutMs` is distinct and passed in the successful control.

For this deployment, grouped contract publication uses
`stateTransitions.broadcastStateTransition` followed by paced, proof-verified
contract and group-membership readback. Omitting `waitTimeoutMs` also permits the
generic verified wait. Preserve the original signed transition and expected ID
after an ambiguous result; reconcile them before assigning another nonce.

The upstream fix belongs in the shared SDK wait implementation: provide a
WASM-compatible asynchronous deadline, retaining the native timeout behavior, and
exercise the explicit timeout through a compiled WASM regression test. Silently
discarding the user's timeout would not implement the promised API. No upstream
issue or PR has been opened as part of this investigation.

## Deployment evidence

Observed on 2026-09-17: live Drive/DAPI report `4.2.0-beta.1`, protocol 14,
and Tenderdash 1.8. The prior dev.11 maker and social contract were proved absent
on the fresh Platform chain. Core history persisted.

The deployment registered a fresh, privately retained maker at
`3JKc6iVG74LEMSrAtB4VSHPQW2mtgKAw8s3Ki6tTFcRQ`, funded from the Moutai faucet.
All ten contracts were published under that owner and enrolled as whole-contract
members of group `DYDGmjxwQwZhRm7zxp12pd52vB9pCunxEPerF9TfvQZe`. Group info,
per-contract memberships and enumeration independently confirmed all ten members.
Public contract IDs are recorded in `.env.devnet`; the pruned bundled snapshot
contains the same ten contracts. Recovery keys and signed transition checkpoints
are retained outside the repository.

The original 100 corpus identities were restored with their original IDs and
public keys by replaying their saved Core asset locks, along with all 185 saved
top-ups. A separate CI identity was restored from its saved lock and top-up:
`EShbqnfLdmctGWaUCnU3FNKMenYmxiQEiawY3q2pLQm2`. Devnet CI now uses the existing
`E2E_DEVNET_SEED_PHRASE` secret, independently of the testnet seed. This incorporates
the fixture wiring from #497 and the topology setup/readiness fixes from #511
and #503. Authenticated traces remain disabled.

Before seeding, twelve live checks passed: runtime version, all ten contract
owners/versions, group membership, all four `ttl:604800` indexes, unwritten daily
buckets inside retention, unused hashtag pins for today/all-time, current-day
and all-time empty rankings, and the actual anonymous/authenticated feed composites
against ordinary reads. Queries outside the TTL horizon are intentionally refused
because expired buckets may be partially removed; they are not valid empty-bucket
test fixtures.

Local validation: TypeScript, all 276 unit tests across 38 files, ESLint, knip,
the production devnet build, v6 schema generation self-test, and provisioner/seeder
self-tests pass with the beta.1 packages. Both SDK dependencies resolve to one
beta.1 WASM runtime.

All 100 personas have restored profiles and DPNS names and received 4,000 YAPP
from the maker. The CI bot also has its name/profile and 4,000 YAPP. Token
`5kCSVmXxPgJe2K9RwK1K8E2JXHm26PDcRnJY4q9dVYyC` has a direct-purchase price
of 1,000,000 credits per token, minimum 100.

The initial populated checkpoint confirmed 1,184 corpus operations: 493 posts,
5 quotes, 71 replies, 180 likes, 4 reply likes, 428 follows and 3 reposts. The
18,000-operation corpus continues from its journal; five rate-limited/dependent
operations are retried at lower concurrency. Both failed post creates were
independently proved absent before retry, avoiding duplicate posts.

At this stable checkpoint (height 462), all populated query gates passed:

- Actual 20-row anonymous (8 components) and authenticated (10 components)
  composites matched the ordinary timeline and independent enrichment reads.
- All-time and daily positive rankings agreed with independent counts.
- Three cursor pages of 20 matched a 60-row baseline, with no duplicate IDs.
  This included 48 adjacent timestamp ties and ties at both page boundaries.
- Positive enrichment covered likes, replies, 17 profiles and 17 names. Quoted
  posts, reposts and viewer marks were absent from that particular latest page;
  their empty results matched independent queries.
- The browser topology suite passed **20 tests**, skipping eight tests specific
  to the old v4 schema. It exercised posts/replies, quoted replies, tombstones,
  tagged/untagged like and unlike, profile/tag rankings and global Today views.
  Global ranking tests accept seeded leaders instead of assuming the CI bot's
  single-like fixture outranks the corpus; pinned surfaces retain exact checks.

An independent code-review-validator review approved the deployment changes
and validation fixes. No further safe simplification was warranted.

