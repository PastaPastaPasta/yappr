# Platform 4.2.0-beta.6: consensus codes in JS, the propertyConstraints language, generatedFrom

Investigation date: 2026-09-28. This document covers the beta.5 → beta.6 range
only. Everything earlier is in [`PLATFORM_BETA5_UPGRADE.md`](./PLATFORM_BETA5_UPGRADE.md).
It records the SDK pin PR (`beta6/sdk`): the SDK version bump, the numeric
consensus codes, a check that the hand-built create still decodes exactly, the
beta.6 document meta-schema, and an offline check of every contract. **No
contract JSON changes here.** A separate re-cut PR will adopt the new grammar.

## Versions and scope

| Release | Commit | Changes reviewed |
| --- | --- | --- |
| `v4.2.0-beta.5` | `5c79d12dfcf44f0ab1100d703ff48134ee8c6ce3` | Starting point; see the beta.5 document. |
| `v4.2.0-beta.6` | `5298d20952fdd28aba426415e13c007e0b999fd9` | 64 non-merge commits. Protocol version is still **14** (`LATEST_VERSION = PROTOCOL_VERSION_14`). Every consensus change is behind it. |

Both `@dashevo/evo-sdk` and `@dashevo/wasm-sdk` are pinned to exactly
`4.2.0-beta.6`. `npm ls @dashevo/wasm-sdk` shows one copy, deduped under
evo-sdk.

## The npm situation and the temporary tarball source

**Neither package is on npm.** The platform release run (36428401128) failed
in its `build-npm` job before anything was published. The evo-sdk manifest
depends on `@dashevo/wasm-sdk: 4.2.0-beta.6`, so the registry cannot install
either package.

To unblock this PR, both packages were **built locally from the tag**
(`5298d209`) on 2026-09-28. They are mirrored as assets of the yappr prerelease
[`sdk-4.2.0-beta.6`](https://github.com/PastaPastaPasta/yappr/releases/tag/sdk-4.2.0-beta.6),
and `package-lock.json` resolves both from there:

| Package | `resolved` | `integrity` |
| --- | --- | --- |
| `@dashevo/wasm-sdk` | `…/releases/download/sdk-4.2.0-beta.6/dashevo-wasm-sdk-4.2.0-beta.6.tgz` | `sha512-JfAFk52rXhva/9/hDFzTOM2hEk4GbMpPbSgBcO7l1KSH9lcIo8ntcy/dPtZ0+H1geGO566KCXSJkT+HbnYGIeg==` |
| `@dashevo/evo-sdk` | `…/releases/download/sdk-4.2.0-beta.6/dashevo-evo-sdk-4.2.0-beta.6.tgz` | `sha512-y5l+BPqIfZVT7IzuLlAnpisq5+RHoRZ93BW96FGVKbfN9r9POOW7P77Hr4f5VBING6Y72w0NVdMlVjx67l2OSg==` |

`rm -rf node_modules && npm ci` installs from these URLs with no network
access to the npm registry needed for them.

**These tarballs are not the official artifacts.** They were built locally
from the tag. They are **not byte-identical** to what the platform CI will
publish, because the wasm build, the bundle and the tarball metadata differ
between machines. The integrities above will therefore not match the npm
packages. **When npm publishes 4.2.0-beta.6, regenerate the lockfile** so that
both entries point at `registry.npmjs.org` with the registry's integrities, and
stop using the release mirror. Until then, anyone installing this branch trusts
the yappr release assets, not npm.

## What changed, grouped by effect on Yappr

| Group | Commits | Effect on Yappr |
| --- | --- | --- |
| **Consensus codes reach JS** | [#5112](https://github.com/dashpay/platform/pull/5112) `dd01f49142` | `WasmSdkError.code` now carries the consensus code (`10422`, `40132`, …) whenever the error is a consensus error. That covers a Platform refusal at CheckTx and a refusal the SDK catches before broadcast (a `ProtocolError::ConsensusError`, or a `DataContractError`, which it maps to the code Platform would send). Before this, most of these arrived with `code = -1`, and the broadcast and wait errors were rebuilt as `Generic` with the code dropped. `WasmSdkError::with_context` now keeps the kind, the code and the retriable flag, and prefixes the message ("Failed to broadcast: Protocol error: …"). A new `DocumentGeneratedFromErrorCode` enum (10424) was added. **Client: `lib/error-utils.ts` accepts the numeric code** (below). |
| **propertyConstraints language** | #5045 #5046 #5047 #5048 #5071 #5073 #5078 #5083 #5085 #5100 #5101 #5109 #5115 #5121 | Rules can now compare string, identifier and `$ownerId` operands, use `ifAbsent` string defaults, `length`/`byteLength`/`count`, `$createdAt`/`$updatedAt`/`$transferredAt` (and their heights), `contains`, `startsWith`/`endsWith`, `ifThen`/`ifThenElse`, `notIn`, `min`/`max`/`abs`, and `countOf`/`sumOf` totals read from count and sum trees. #5101 reads an empty object as absent and follows `$defs` refs. #5115 refuses own-type totals on contested types. Violations are still **10422**, and the prose `breaks its propertyConstraints rule` did not change. **Contract re-cut:** new candidates. **Client: none**; the matcher already covers 10422. |
| **propertyConstraints in the JS SDK** | [#5051](https://github.com/dashpay/platform/pull/5051) `1b30651da7`, #5121 | New `DataContract.documentTypePropertyConstraints(type)`, `documentPropertyConstraints` and `checkDocumentPropertyConstraints(document)`, a local pre-check that uses consensus's own code. These are additive. **Client: not adopted here.** It is a candidate for the re-cut PR, which adds rules the UI can pre-check before paying. |
| **`generatedFrom`** | [#5099](https://github.com/dashpay/platform/pull/5099) `8c29a53ca2`, #5114 | A string property can be generated by the platform from other properties with a system function (for example a homograph-safe normalized label). A value other than the generated one is refused with **10424** `DocumentPropertyNotGeneratedError`. The create transition builder regenerates these properties, and so does the SDK's contest-fund resolver. No Yappr contract declares one, and no system contract adopted it at this tag. **Client: none today.** |
| **Contract registration and update refusals** | #5076 #5074 #5069 #5123 #5050 #5055 #5053 | Parser-generation-3 refusals are now consensus errors, not protocol errors. A reordered `entryPayload` is accepted. Token-cost and unruled-keyword changes on update are refused with a consensus error. A preallocated agreement source must fit a tree key. Nested `required`/`transient` entries parse by prefix. The shipped order of basic consensus errors is restored. **No committed contract trips any of these** (see "Offline contract validation"). |
| **Elected moderation windows** | [#5108](https://github.com/dashpay/platform/pull/5108) `fc6e39488a` | Off mainnet, election windows may now be 0, where before they had to be at least one day; mainnet keeps one day. This makes devnet election tests faster. `auditNodeRules` still applies the one-day floor on every network, so it is stricter than a devnet node, never looser. The 3600 s window probes still pass, and they describe mainnet. **Re-cut / ops:** a short-window moutai cut must relax the audit for devnet first. |
| **SDK behaviour** | [#5059](https://github.com/dashpay/platform/pull/5059) `5870cdde4b`, [#5058](https://github.com/dashpay/platform/pull/5058) `37a7785a7b`, [#4973](https://github.com/dashpay/platform/pull/4973) `e776f957a1` | #5059: `StateTransitionResult.ownerBalance` becomes a getter, and its JSON form is a string above 2^53. Yappr's `ownerBalanceOf` reads the `ownerBalance` BigInt that `broadcast.rs` puts on the wait result, and that did not change. #5058: the SDK no longer refuses an empty or zero-amount `priceTiers` map itself, and rs-dpp decides. Yappr never passes `priceTiers` to the facade (`scripts/set-yapp-price.mjs` builds the transition by hand with a non-empty schedule). #4973: each DAPI attempt is bounded by `timeout + connectTimeout` through the response body. That applies on native targets only; in the browser `grpc-timeout` is still just sent as a header. **No client change.** |
| **Drive and consensus fixes** | #5081 #5084 #5079 #5086 #5056 #5052 | Block finalization and vote extension signing across rounds; size estimates for strings of 16,384+ characters; once-per-identity claim trees. **No effect on Yappr.** |
| **Swift, Kotlin, docs, CI** | #5064 #5066 #5097 #5098 #5106 #5116 #5117 #5120, book chapters, release-runner fixes, the version bump | **No change.** The release-runner fixes did not stop `build-npm` from failing. |

## Consensus codes: prose first, numeric code second

Testnet still runs pre-beta.6 nodes and SDK paths that deliver prose with
`code = -1`, so **every matcher still reads the prose first**, and none of the
prose patterns were removed. The numeric code is now a second route:

- `consensusCodeOf(error)` returns the numeric `code` of the error, or of a
  nested `error`/`cause`, when it is a five-digit integer. Otherwise it returns
  null. `-1`, gRPC statuses, DOMException codes and string codes are never read
  as a consensus code. A freed wasm error whose getter throws is also handled.
- `hasConsensusCode(error, codes)` takes the error, not the message. It accepts
  the numeric code or a labelled code in the message (`code=40128`,
  `"code":40128`, case-insensitive), and never bare digits.
- Matchers that had no numeric route before now have one: 40700 (token
  balance), 40702 (frozen account), 40120–40125 (reference family), 40127
  (property agreement), and 40128 through the shared helper. `isWriteGateError`
  still needs the `$ownerId` prose to tell a gate from a value mismatch. The
  code alone says only that it is a 40127. `isTrailingBytesError` also stays
  prose-only, because a numeric 10002 is any parse failure and only the
  trailing-bytes cause is the code defect it reports.

`lib/error-utils.test.ts` pins both shapes: every matcher is recognised by a
`WasmSdkError`-shaped object carrying only its code behind opaque prose, and
the same object with `code: -1` is not claimed. It also pins that the older
prose still matches with `code: -1`, that a numeric 40140 stays out of
`isTimeoutError`, and that one code never claims a neighbour.

## The hand-built create still decodes exactly

beta.6's `DocumentCreateOptions` still has no `actionFeeAgreement` (fields:
`document`, `identityKey`, `signer`, `tokenPaymentInfo`, `contestFund`,
`settings`, checked against the installed `.d.ts`). The v9 post and reply
creates therefore stay hand-built in `lib/manual-batch.ts`. beta.6 changed no
field of the batch or document create transition. The rs-dpp diff there is
import cleanup and the `generatedFrom` regeneration, which is inert for types
that declare no generated property.

The v9-shaped post create from `lib/manual-batch.test.ts` (YAPP payment with
`gasFeesPaidBy: 2`, and an 80,000,000-credit moderators fee agreement) was
built by `buildSignedCreateTransition` under each wasm and compared:

```text
beta.5 wasm: 321 bytes, decode + re-encode identical: true
beta.6 wasm: 321 bytes, decode + re-encode identical: true
beta.5 bytes == beta.6 bytes: true
```

The beta.5 document's Rust proof (the node's own exact decoder accepts these
321 bytes and refuses a 1-byte suffix) therefore still applies byte for byte.
`lib/manual-batch.test.ts` runs the round trip in CI against the beta.6 wasm.

## Offline contract validation

`scripts/meta-schema/document-meta-v3.json` is now the beta.6 copy
(`packages/rs-dpp/schema/meta_schemas/document/v3/document-meta.json` at the
tag, sha256 `88083a21…`, pinned in `scripts/contract-probes.mjs`). It adds
`generatedFrom` and the new propertyConstraints grammar.

Every file in `contracts/` was run through
`node scripts/validate-contract-offline.mjs <file>` on beta.6, and again on the
beta.5 wasm with the beta.5 meta-schema as a baseline. **Every outcome and
every create size is identical.** beta.6 adds no refusal for any committed
contract.

| Contract | beta.6 | Create size |
| --- | --- | ---: |
| `yappr-social-contract-v9.json` | OK | 18,291 B |
| `yappr-storefront-contract.json` | OK | 14,588 B |
| `yappr-blog-contract.json` | OK | 6,282 B |
| `pollr-contract.json` | OK | 6,028 B |
| `yappr-dm-contract-v5.json` | OK | 3,674 B |
| `yappr-dm-contract.json` | OK | 2,738 B |
| `yappr-profile-contract.json` | OK | 1,624 B |
| `key-exchange-v2.json` | OK | 1,459 B |
| vault, auth vault, key backup, block, hashtag, mention | meta-schema (legacy `mutable`) | unchanged |
| `yappr-social-contract-v2.json`, `yappr-minimal.json` | wasm refuses | — |

The last two rows are the same known cases the beta.5 document explains.
`node scripts/validate-contract-offline.mjs --probes` passes all 48 probes on
beta.6, and on the beta.5 baseline too.

## What is NOT in this PR

- Contract JSON edits that adopt the new propertyConstraints operands,
  `generatedFrom`, or 0-length election windows on moutai. That is the re-cut
  PR.
- `checkDocumentPropertyConstraints` pre-checks in the UI. They only pay off
  once the re-cut adds rules the UI can break.
- `.env.*` and any devnet registration.
- Regenerating the lockfile from npm. Not possible until npm publishes.

## Local validation

On `beta6/sdk`, after `rm -rf node_modules && npm ci`:

- `npm ls @dashevo/wasm-sdk`: one copy, `4.2.0-beta.6`, deduped under evo-sdk.
- `npm run lint` and `npm run lint:dead` (knip) are clean.
- `npm run test`: 106 files and 1,211 tests pass.
- `npm run build` and `npm run build:devnet`: both static exports succeed.
- `validate-contract-offline.mjs` on every contract, plus `--probes` (48/48).
  The results are in the table above.

**Not verified until a beta.6 network runs:** that a beta.6 node puts the
numeric code on each refusal Yappr can hit, and that the prose still matches.
The SDK side is pinned by platform's own unit tests (`wasm-sdk/src/error.rs`).
