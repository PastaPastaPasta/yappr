# Platform 5.0.0-beta.5: the SDK bump and what it changes for Yappr

Beta.5 (tagged 2026-10-12) follows [PLATFORM_V5_BETA4_UPGRADE.md](PLATFORM_V5_BETA4_UPGRADE.md). The protocol version stays **14**. Several of its changes alter PV14 behaviour, so every validator must swap images together; the platform team expects an in-place upgrade of sakura.

| PR | What |
| --- | --- |
| `chore/sdk-5.0.0-beta.5` (this one) | `@dashevo/evo-sdk`, `wasm-sdk` and `wasm-dpp2` 5.0.0-beta.5 in lockstep (with `package-lock.json` and the mobile `licenses.json` regenerated); the beta.5 document meta-schema v3 vendored (sha256 `d8676bfd…`); error copy for 40148 and 40149; this record. No contract or topology change. **Merge at the sakura beta.5 cut-over, not before** (see the next section). |
| beta.5 re-cuts (separate PR) | contracts using the beta.5-only grammar |

## SDK compatibility with sakura (beta.3 nodes)

The beta.4 SDK read beta.3 nodes. The beta.5 SDK does not read them fully. Measured read-only against sakura on 2026-10-12, with the same probe run once on a clean install of 5.0.0-beta.4 (control, 19 of 19 pass) and once on 5.0.0-beta.5:

| Read | beta.5 SDK on a pre-beta.5 node |
| --- | --- |
| connect, `epoch.current` (proved), `contracts.fetch` (social v14, pollr v6, blog v7, storefront v7) | works |
| DPNS `domain` query on a string index | works |
| `$ownerId` / `$createdAt` range queries on `post`, `follow`, `poll`, `blogPost` (unsigned-integer range, with and without an identifier prefix) | works |
| `identities.fetch`, `identities.byPublicKeyHash` (unique key) | works |
| Document query with an **equality on an unsigned-integer index key** (`vote` where `pollId == p and choice == 0`) | **fails**: `grovedb: invalid proof: V1 proof contains extra lower layer for key 80 not required by query` |
| Document **count** with the same equality | **silently returns nothing** (`[]` where beta.4 returns 1) |
| `identities.byNonUniquePublicKeyHash` | **fails**: `no proof in result` (beta.4: an empty list) |

The cut-over prep also saw the beta.5 SDK fail to connect to beta.3 nodes with a quorum-key-unavailable error, which these probes did not hit, so treat the table as the best case.

The cause is platform#5350 (unsigned-integer index values are now stored in numeric order, so a key encodes differently) and platform#5361 (the identity-by-public-key-hash request changed). A beta.4 SDK against beta.5 nodes breaks the same two paths from the other side, so **the SDK and the nodes move together**.

What this means in the app: a poll's choice tally and any other equality on an integer key, and the passkey and key-hash sign-in path that falls back to `byNonUniquePublicKeyHash` (`lib/services/identity-service.ts`), would break on `/devnet` while sakura runs beta.3 or beta.4. The count failure returns zeros instead of an error. Merge this PR when sakura's nodes report 5.0.0-beta.5, and cut `/devnet` over in the same window.

## What beta.5 changes for Yappr

### New where operators and constraint arguments

- `where` accepts `contains` and `containsAny` over a typed-array index (wasm-sdk `queries/document.rs`). `DocumentWhereOperator` in `@dashevo/wasm-sdk` already lists them, so `DocumentWhereClause` needs no change. Nothing here queries with them yet.
- `DataContract.checkDocumentPropertyConstraints(document, storedDocument)` takes the stored version as an optional second argument, for rules that read `$old.`. The offline scripts pass one argument, which still works for the rules they check. It does not judge `referenced` reads or `countOf`/`sumOf`.

### Error codes

| Code | Name | Where it appears | Copy |
| --- | --- | --- | --- |
| 40149 | `ReferencedDocumentPrecededError` | a commit-and-reveal create (`chooseFirst`) whose commitment another identity made first | "Someone else got there first, so this can't be completed." Permanent. Not a dead target, so it is excluded from `isReferenceNotFoundError`, whose "referenced ... for path" phrasing it shares |
| 40148 | `ReferencedDocumentRuleReadInvalidError` | contract registration or update, when a `propertyConstraints` rule reads a field through a reference that the referenced type cannot give | "This isn't available on this network right now. Try again later." Permanent. A contract-authoring error a running client should not meet |

Both are in `isPermanentProtocol14Error`, so a post or write is never retried on them. Neither is raised by a contract Yappr ships today.

### Meta-schema

`scripts/meta-schema/document-meta-v3.json` is the file at the `v5.0.0-beta.5` tag, byte for byte; `scripts/contract-probes.mjs` pins its sha256. The grammar adds:

- the `referenced` operand and `$old.` / `$revision` paths in `propertyConstraints` rules;
- the `referenceWhereCondition` forms (`const`, `notEqual`, `in`, ordering bounds) of a reference `where`;
- the `$ownerId` param of a `sys.hash` `findBy`, binding a commitment to its writer;
- `constraints` (`minimumAgeBlocks`, `chooseFirst`) beside `findBy`.

### Wasm size

The npm `wasm-sdk` 5.0.0-beta.5 wasm is about 26.38 MB. That is over Cloudflare Pages' 25 MiB asset limit if it is emitted; fix/wasm-sdk-dedupe (#728) stops emitting the asset, and this PR does not duplicate it.

## Upgrade run book

**In place:**

1. Get every sakura node onto beta.5 (`NETWORK=devnet node ops/status.mjs`: drive 5.0.0-beta.5, PV14, the height continuing).
2. Merge this PR and redeploy `/devnet` (`workflow_dispatch --ref staging`; a master-triggered deploy wipes `/devnet`).
3. Re-run the read batteries and the `/devnet` smoke on the beta.5 SDK, including a poll tally and a key-hash sign-in.
4. Then register the beta.5 re-cuts and the App Connect set. `scripts/register-app-connect-contracts.mjs` reads the Drive version from the status API and refuses to run against anything older than 5.0.0-beta.5.

**Wiped:** rebuild as in [PLATFORM_V5_BETA2_UPGRADE.md](PLATFORM_V5_BETA2_UPGRADE.md) and [SAKURA_BETA3_DEPLOY.md](SAKURA_BETA3_DEPLOY.md).
