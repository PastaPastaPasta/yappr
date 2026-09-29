# Platform 4.2.0-beta.7: the SDK pin and bonsia devnet wiring

Investigation date: 2026-09-29. This document covers the beta.6 → beta.7 range
only. Everything earlier is in [`PLATFORM_BETA6_UPGRADE.md`](./PLATFORM_BETA6_UPGRADE.md).

It records the SDK pin PR (`beta7/sdk-bonsia`). That PR contains:
- the SDK bump, now from npm again;
- client fixes for beta.7;
- the wiring the devnet build needs to reach the new devnet **bonsia**.

**No contract JSON changes here.** The re-cut (`beta7/contracts-v10`) adopts the new grammar. A separate deploy PR switches `.env.devnet` to bonsia.

## Versions and scope

| Release | Commit | Changes reviewed |
| --- | --- | --- |
| `v4.2.0-beta.6` | `5298d20952fdd28aba426415e13c007e0b999fd9` | Starting point; see the beta.6 document. |
| `v4.2.0-beta.7` | `50d120372788985d9ee97ba04ae6b1e6603dfa0b` | 58 non-merge commits. Protocol version is still **14**. |

**All three packages are pinned to exactly `4.2.0-beta.7`, resolved from `registry.npmjs.org`:**
- `@dashevo/evo-sdk`
- `@dashevo/wasm-sdk`
- `@dashevo/wasm-dpp2`, a devDependency

The beta.6 GitHub-release tarballs are gone from the lockfile, so the `sdk-4.2.0-beta.6` prerelease can be deleted. `npm ls @dashevo/wasm-sdk` shows one copy, deduped under evo-sdk.

`@dashevo/wasm-dpp2` is for the offline contract validator.
- It is the only package that runs the node's document meta-schema and `validation` rules.
- wasm-sdk's `DataContract.fromJSON(json, true)` **accepts and silently drops** keys a node refuses (for example `canBeDeletedByModerators`, or a misspelt `documentsMutible`), and skips index-shape checks.
- A green wasm-sdk parse alone therefore proves nothing about those.
- The re-cut branch wires it into `scripts/validate-contract-offline.mjs`. Until then, `knip.json` ignores it.

## SDK lockstep: /devnet is broken until the bonsia deploy lands

**The beta.7 SDK cannot decode beta.6-grammar contracts.** Generation-3 contract parsing refuses `propertyAgreement`, `lookup` and `listElement` on every parse, not only at registration. For example, `contracts.fetch` of moutai's social v9 fails with "refersTo propertyAgreement was replaced by where…". Blog, storefront and pollr fail the same way.

So once this merges, **the `/devnet` build cannot read its contracts. It stays broken until the bonsia deploy PR lands** with re-cut contracts and the new `.env.devnet`. Nothing is lost: moutai is being retired anyway, and the SDK, the contracts and the env were always going to have to ship in one deploy.

Testnet is not affected. Its contracts predate the `refersTo` grammar entirely, and the beta.7 SDK reads them. This was checked with a headless load of the testnet build's `/feed`.

## What changed, grouped by effect on Yappr

| Group | Commits | Effect on Yappr |
| --- | --- | --- |
| **refersTo `findBy` / `where`** | #5197 | `propertyAgreement` becomes `where`, with key and value flipped. `lookup {index, keys}` becomes `findBy keys`. `listElement` is removed. 40127 now ends "(where on …)", 40137 reads "invalid refersTo findBy (…) declared at …", and 40138 reads "invalid refersTo inList … declared at …". **Contract re-cut:** a mechanical translation. **Client:** `isReferenceRequirementError` matches both the old and the new 40137/40138 phrasings (testnet still renders the old ones). The 40127 matcher keys on "does not agree with the referenced document", which is unchanged; tests pin the `where` text. |
| **Moderator field changes** | #5158 #5161 | `moderatorAbilities {delete, deleteWithin, deleteKeepsRecord, deleteRefundsOwner, changeFields}` replaces `canBeDeletedByModerators[For]`. New `sdk.contracts.moderatorChangeDocumentFields`. Documents carry `$moderatedAt` and `$moderatedBy`. `moderatorDeleteDocument` may resolve `undefined` on a type that keeps no record (the app ignores its return value). New codes 41123, 41124 and 10905. **Re-cut** (report status); client adoption follows with the re-cut. |
| **skipIfAbsent anywhere** | #5162 | Stored and windowed indexes may skip absent values. This lets `beat` fold into `like`, and plain posts save about 30–40% in fees. **Re-cut.** |
| **indexOnly create/delete resolve** | #5136 | `documents.create`/`delete` on an indexOnly type now wait for the affected state instead of throwing "received a verified VerifiedDocuments snapshot…". **Client:** `deleteDocumentByValues` loses its snapshot catch and `isAffectedStateSnapshotError` is deleted. The chain read-backs stay: they settle timeouts and stale tuples, and an affected-state proof shows the entry, not that this transition wrote it. Creates stay hand-built (below), and those already used `waitForAffectedState`. |
| **Vote polls by end date** | #5139 | `votePollsByEndDate` takes integer or bigint `startTimeMs`/`endTimeMs`. beta.5 and beta.6 refused every bound. **Client:** the election panel's end-time read is bounded above by the latest end a live contest can have (join + vote windows from now, plus 10 min of slack). Later pages pass the last entry's bigint back unchanged. |
| **masternodeVote** | #5138, #5137 | Takes the ProTxHash as an Identifier or hex and returns the recorded `Vote`. check_tx refuses a vote that a block would refuse (40307). **Client: none**; the app casts no votes, and the op scripts can drop nonce polling. |
| **contestFund on hand-built creates** | #5163 | `new DocumentCreateTransition({document, identityContractNonce, dataContract})` fills in the contest fund, and `sdk.documents.contestFundToJoin` gives the live price. No Yappr doctype is contested. **Client: none.** |
| **Cost and layout** | #5159 #5153 | `documentCreateCost` and `documentTypeLayout` are offline and synchronous. **Candidates** for validator `--cost` and a compose cost preview; not adopted here. |
| **validateUpdate** | #5140 | `DataContract.validateUpdate` exists only in wasm-dpp2. Yappr re-cuts rather than updating, so it has no product use. |
| **New consensus codes** | #5041 #5158 | 10423 (commit-reveal preimage), 10905, 40142 `ReferencedDocumentRequirementNotMetError`, 41123 and 41124. **Client:** 40142 shares the "referenced … for path" phrasing with a dead target, so `isReferenceRequirementError` claims it before `isReferenceNotFoundError` can. The moderator-field codes get copy with the re-cut. |
| **Other consensus fixes** | #5173 #5127 #5104 #5103 #5170 | These cover index null flags per path, duplicate nested unique values (40105), dotted `summable`/`averageable` (refused), and indexOnly prefix-pivot pages (refused). #5170 adds `integerRange` buckets. None of Yappr's reads use a refused shape. **Client: none.** |

### The hand-built create stays

`DocumentCreateOptions` still has no `actionFeeAgreement` at beta.7. rs-sdk has `with_action_fee_agreement`, but wasm-sdk does not plumb it through. Post and reply creates on social v9 need the agreement (40132 without it), so `lib/manual-batch.ts` remains.

`lib/manual-batch.test.ts` passes unchanged on beta.7. It checks that the signed bytes decode and re-encode byte for byte with nothing left over, and that the fee agreement, the token payment and the derived id all survive the round trip.

## Bonsia

bonsia replaces moutai as the devnet behind `yap.pr/devnet`. It runs Platform 4.2.0-beta.7 on a fresh Core chain, so no moutai identity or asset lock carries over.

| | |
| --- | --- |
| SDK `devnetName` | **`bonsia-g1`**. The node's network id is `dash-devnet-bonsia-g1`, and `bonsia` gets "malformed response". |
| DAPI | 13 evonodes, `https://68.67.122.{224..230,242..247}:1443`. They are raw IPs with Let's Encrypt IP-SAN certificates, and CORS allows `https://yap.pr`. There is no `seed-N` DNS. |
| Quorums | `https://quorums.bonsia.networks.dash.org`. **Must be set explicitly:** the default derived from `bonsia-g1` would be `quorums.bonsia-g1…`, which does not exist. |
| Insight | `https://insight.bonsia.networks.dash.org/insight-api`. It reports `"network":"testnet"`, so testnet address and WIF prefixes apply. |
| Explorer / faucet | `explorer.bonsia.networks.dash.org` / `faucet.bonsia.networks.dash.org` (10 DASH per request, 20 per hour) |

The app already reads these from `NEXT_PUBLIC_DEVNET_NAME`, `NEXT_PUBLIC_QUORUM_URL`, `NEXT_PUBLIC_DAPI_ADDRESSES` (a comma list; raw IPs are fine) and `NEXT_PUBLIC_INSIGHT_API_URL` (`lib/constants.ts`). The scripts read the same names through `scripts/sdk-env.mjs`. This PR changes none of that, and `.env.devnet` still names moutai until the deploy PR.

Two smaller consequences of the rename:
- The bundled-contract snapshot is keyed `devnet-<name>`. A bonsia build finds no bundle and fetches its contracts, until the deploy PR snapshots `devnet-bonsia-g1`.
- The identity bridge URL becomes `?network=devnet-bonsia-g1`.

### The double-slash transport bug

This is a latent SDK bug. Since the wasm SDK was introduced (platform#2405), rs-dapi-client's `wasm_channel.rs` has built the client's base URL from `uri.to_string()`, which ends in a `/`. tonic-web-wasm-client 0.9.1 (`src/call.rs`) then appends the method path with `base_url.push_str(&request.uri().to_string())`, and that path starts with its own `/`. So every DAPI call goes to `https://68.67.122.224:1443//org.dash.platform.dapi.v0.Platform/getStatus`.

A gateway with envoy's `merge_slashes` answers it anyway: testnet, mainnet and moutai all do. **bonsia's envoy at first did not.** It returned 404 with an empty body, which the SDK reports as `MalformedResponse` ("malformed response").

Infra has since enabled `merge_slashes`. At first 11 of the 13 nodes answered `//` with 200 and `.229`/`.230` still 404'd. By 17:52Z on 2026-09-29 all 13 answered 200.

The SDK still emits `//`, though. A node rebuilt from the old gateway config, or any other devnet set up like it, would fail the same way. So the shim stays as a narrow safety net.

`lib/services/dapi-path-shim.ts` is that workaround. `EvoSdkService` installs it before it builds a devnet SDK, and only then.
- It wraps `globalThis.fetch`, which the wasm glue calls with a `Request`.
- It rewrites only requests whose origin is one of the configured DAPI addresses **and** whose path begins with `//org.dash.platform.`, collapsing that leading `//` to `/`.
- The quorum prefetch, Insight, and anything else go through untouched.
- A second install only adds origins, so the shim is idempotent. On a gateway that already merges slashes it changes nothing the gateway would not have done.
- `dapi-path-shim.test.ts` covers the rewrite rule and the wrapper.

**Remove the shim once platform fixes the SDK** so that it stops emitting `//`, for example by trimming the base URL's trailing slash in `wasm_channel.rs`.

Node scripts reach bonsia through `scripts/sdk-env.mjs`, which does not install the shim. They work against every node that merges slashes. Should a straggler matter, the deploy PR can add the same rewrite there.

The devnet address config should list all 13 nodes:

```
NEXT_PUBLIC_DEVNET_NAME=bonsia-g1
NEXT_PUBLIC_QUORUM_URL=https://quorums.bonsia.networks.dash.org
NEXT_PUBLIC_DAPI_ADDRESSES=https://68.67.122.224:1443,https://68.67.122.225:1443,https://68.67.122.226:1443,https://68.67.122.227:1443,https://68.67.122.228:1443,https://68.67.122.229:1443,https://68.67.122.230:1443,https://68.67.122.242:1443,https://68.67.122.243:1443,https://68.67.122.244:1443,https://68.67.122.245:1443,https://68.67.122.246:1443,https://68.67.122.247:1443
NEXT_PUBLIC_INSIGHT_API_URL=https://insight.bonsia.networks.dash.org/insight-api
```

This is exactly the env the local `build:devnet` in "Validation" was run with. `.env.devnet` itself changes in the bonsia deploy PR, together with the new contract ids.

## Validation in this PR

- `npm run lint`, `npm run test`, `npm run build` (testnet) and `npm run lint:dead` all pass.
- `npm run build:devnet` passes, run against a local env pointing at bonsia (`bonsia-g1`, the quorum URL and the 13 IPs).
- **Testnet:** a headless browser load of the testnet build's `/feed` shows posts. The beta.7 SDK reads testnet's contracts.
- **bonsia:** a headless browser load of the local devnet build reaches the network. `system.status` answers, a proved fetch of the DashPay contract `Bwr4WHCPz5rFVAD87RqTs3izo4zpzwsEdKPWUT1NS1C7` resolves, and the console shows no "malformed response".
  - Yappr's contracts do not exist on bonsia yet, so the feed is empty.
