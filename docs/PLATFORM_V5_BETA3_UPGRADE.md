# Platform 5.0.0-beta.3: the SDK bump and what it changes for Yappr

Sakura moves to drive/rs-dapi **5.0.0-beta.3** on 2026-10-08. The protocol version stays **14**: beta.3 has no version bump, no state migration and no upgrade code. Its consensus changes ship as PV14 version-table entries (`validate_document` 0→1, `document_base_transition_state_validation` 1→2, `document_delete_transition_state_validation` 0→1, and others). So all 13 validators must swap images together, and a beta.3 node cannot replay sakura from genesis. The platform team expects an in-place upgrade. If sakura is wiped instead, the redeploy follows the 5.0.0-beta.2 record ([PLATFORM_V5_BETA2_UPGRADE.md](PLATFORM_V5_BETA2_UPGRADE.md)), and a cut-over PR replaces every id in `.env.devnet`.

The previous upgrade is [PLATFORM_V5_BETA2_UPGRADE.md](PLATFORM_V5_BETA2_UPGRADE.md).

| PR | What |
| --- | --- |
| `chore/sdk-5.0.0-beta.3` | `@dashevo/evo-sdk`, `wasm-sdk` and `wasm-dpp2` 5.0.0-beta.3 in lockstep; the beta.3 document meta-schema v3 vendored (sha256 `7d4ddb30…`); consensus error 40147 mapped; this record. Merges only once sakura runs beta.3. |
| `fix/credits-while-yapp-locked` | pays credits while YAPP is paused, and maps 40711 (below) |
| pollr v6, social v14 | re-cuts that adopt `deleteConstraints` / `countPresent`; contract JSON and topology change only there |

## What beta.3 changes for Yappr

### YAPP payments are refused while the token is paused (40711)

Before beta.3, a document `tokenCost` payment ignored the token's pause and a frozen recipient (QA T1). #5325 makes the payment follow the token's own rules. From PV14, a payment that transfers or burns tokens is refused with `TokenIsPausedError` (**40711**) while the token is paused. The refusal is **paid**, and a delete or replace that carries a `tokenCost` is refused too. Only the contract owner paying itself is exempt.

Social v13's YAPP has `startAsPaused: true` and can never be unpaused. Yet post, reply, like and likeReply carry an optional YAPP `tokenCost`, and `planPayment()` pays YAPP whenever the balance covers it. This change is on the node side, so it hits the live `/devnet` bundle as soon as the nodes upgrade, whatever SDK the bundle uses. `fix/credits-while-yapp-locked` pays credits while `yappIsLocked()` holds and gives 40711 its copy. This PR does not touch 40711.

### New contract grammar

| Keyword or rule | What it does | Yappr |
| --- | --- | --- |
| `deleteConstraints` | Rules the stored document must meet for its **owner** to delete it, in the `propertyConstraints` grammar, refused with **40147** `DocumentDeleteConstraintViolatedError` (a paid state error). Its budget is separate from `propertyConstraints`: 16 rules of 32 nodes, reading 4 distinct totals. Moderator deletes, `ttl` expiry, restore and `consume` are not judged. It is refused on `canBeDeleted: false` / `"onlyWhenConsumed"`, on `indexOnly`, and on a type a consuming `refersTo` targets. Rules are fixed at creation. | 40147 is mapped here: `isDeleteConstraintError`, copy "This can't be deleted anymore.", permanent, never retried. The mobile engine classifies it as `RULE_VIOLATION`. Pollr v6 ("no delete after votes") and social v14 adopt it. |
| `$id` as a `countOf` / `sumOf` filter value | Counts the documents that point at this one: `{ "noVotes": { "equal": [{ "countOf": ["vote", { "pollId": "$id" }] }, 0] } }` | The pollr v6 rule |
| `countPresent` | How many of two or more paths a document holds. It costs **1 + n** nodes against a rule's 32-node budget. Errors still report as 10422. | Candidate for report's "exactly one target" rule in social v14 |
| `skipIfAbsent` on derived index properties | An index skips a document whose reference, or referenced field, is absent | Not used yet |
| Registration bounds | The `ttl` sum bound refuses a summed property on a `ttl` type unless its minimum is ≥ 0 or both bounds lie within ±2^27 (#5316). A bound on the `$ref` walk is added. Both apply under full validation only. | All live contracts pass. None uses `$ref`. The only document-level `ttl` is social v13 `report`, which sums nothing. |
| Repeated nested keys | `validate_document` v1 refuses a repeated key inside a nested object with 10103, before the `maxBytes`, `distinctFrom` and rule checks (#5326, QA C1/C2) | The client never builds one |

`scripts/meta-schema/document-meta-v3.json` is rs-dpp's meta-schema at the `v5.0.0-beta.3` tag, byte for byte. `scripts/contract-probes.mjs` pins its sha256. `auditNodeRules` counts no rule nodes, because both wasm parses enforce the 16 × 32 budget (and countPresent's 1 + n) themselves. Its header records the beta.3 budgets.

### QA fixes (from the 2026-10-07 beta.2 campaign)

| Finding | Fix | Effect on Yappr |
| --- | --- | --- |
| P1, contested-poll wedge | #5321: each block first deletes empty end-date trees among the due polls, then awards | Sakura's 9 overdue polls (2026-10-07 07:01Z–09:47Z) should award within about 5 blocks of an in-place upgrade. Elections are unblocked. |
| T1, token payments ignore pause | #5325 | The 40711 section above |
| M1, restore skips totals | #5329: a moderator restore judges `propertyConstraints` `countOf` / `sumOf` (a paid 10422) | `moderationService.restoreDocument` can now meet 10422. It is already mapped. |
| Q4, empty-id requests ban nodes | #5333: query errors return `INVALID_ARGUMENT`. #5334: the SDK refuses proved requests with an empty id list locally, and stops banning nodes on older-node query strings. | The empty-list guards stay. The call now throws instead of banning, but does not return an empty Map. |
| W-H1, chained query proofs | #5328 (prover and verifier) | Yappr makes no chained queries |
| T2, group burn balance | #5324: `TokenBurnResult.remainingBalance` is now undefined for a group-burn co-signer | Yappr never burns tokens. The query inspector records whatever comes back. |
| T3, group proposals | #5314 | Not used |

The JS SDK surface barely changed: in wasm-sdk only `state_transitions/token.rs`, in wasm-dpp2 only the `countPresent` TS type, and js-evo-sdk only bumps its version. The rest of the release is rs-dapi-client and drive.

## SDK workarounds that stay

None of these is fixed in beta.3. Each was checked against the tag.

| Workaround | Why it stays |
| --- | --- |
| **F-2**: a fresh SDK process after `scripts/update-social-contract.mjs` | `contract_update` (wasm-sdk `contract.rs`) still never calls `cache_contract`. The client never updates contracts. |
| **ID-2**: `allocateIdentityContractNonce` (`lib/document-id.ts`), `identity-nonce.ts`, and `wasm.refreshIdentityNonce` after manual creates | The nonce cache still merges with `max(cached, platform)`, so 24+ refusals still wedge an identity in that SDK instance |
| **H1**: always proved / trusted (`evo-sdk-service.ts`) | `proofs: false` still reaches `unimplemented!` in rs-sdk |
| **SDK-1**: the `MAX_SAFE_INTEGER` guards (`identity-service.ts`, `set-yapp-price.mjs`) | wasm-dpp2 `toJSON` beyond 2^53 is unchanged |
| **No `actionFeeAgreement` on `DocumentCreateOptions`** (L17/L24): `lib/manual-batch.ts`, the hand-built create path in `state-transition-service.ts`, `assertUnpricedAction`, the batteries' hand-built batches | Still absent from wasm-sdk and js-evo-sdk |
| **Empty-id guards**: `if (toFetch.length === 0)`, `_revalidateBundledContracts`' `ids.length === 0` | #5334 turns an empty list into a thrown `INVALID_ARGUMENT`, not an empty result |
| **Connection rebuild** on `no available addresses` and stale quorums (`CONNECTION_ERROR_MARKERS`, `reconnect()`) | Quorum rotation (platform#5236) is not in beta.3 |
| **#696's DPNS owner check** (ID-1) | DPNS `records.identity` is still never checked against the domain owner |

## Upgrade run book

Private ops directories (mode 0700; never print a key-bearing file):

- `~/.local/share/yappr-sakura-20261008`: the beta.3 ops runtime. It has its own `package.json` and `node_modules` (the beta.3 SDKs) and symlinks the key material read-only into `../yappr-sakura-20261006`. Its `RECOVERY.md` lists what is linked.
- `~/.local/share/yappr-sakura-20261006` and `-20261007` stay on the beta.2 runtime, as the rollback.

**In place** (contracts, identities, DPNS, the group and the E1 contest survive):

1. `NETWORK=devnet node ops/status.mjs` (expect drive 5.0.0-beta.3, PV14, the height continuing), `ops/probe-status.mjs` (maker nonce 15), `ops/verify-v13-contracts.mjs` (101/101), and the vote-poll probe (no overdue polls, winners recorded).
2. Merge this PR, after CI's `npm ci` is green against the published packages.
3. Run the batteries on the beta.3 runtime, patched for 40711 (`ops/run-batteries-v13.sh`; run k2 before fresh). Then the devnet topology e2e (`npm run build:devnet && E2E_BASE_PATH=/devnet E2E_ENV_FILE=.env.devnet NETWORK=devnet npx playwright test --project=write topology dpns-username-entry`), then the `/testing` smoke.
4. Re-run QA for P1, T1 (40711), M1, Q4 and C1.

**Wiped:** rebuild as in [PLATFORM_V5_BETA2_UPGRADE.md](PLATFORM_V5_BETA2_UPGRADE.md) and [SAKURA_V13_DEPLOY.md](SAKURA_V13_DEPLOY.md). The keys are the same but the identity ids are new, so every contract id changes. Then make a cut-over PR for `.env.devnet`, the contract snapshots and the topology fixtures.
