# Platform 5.0.0-beta.4: the SDK bump and what it changes for Yappr

Beta.4 (tagged 2026-10-09) follows [PLATFORM_V5_BETA3_UPGRADE.md](PLATFORM_V5_BETA3_UPGRADE.md). The protocol version stays **14**, with no state migration; its consensus changes ship as PV14 version-table entries, so all validators must swap images together. The platform team expects an in-place upgrade of sakura.

| PR | What |
| --- | --- |
| `chore/sdk-5.0.0-beta.4` (this one) | `@dashevo/evo-sdk`, `wasm-sdk` and `wasm-dpp2` 5.0.0-beta.4 in lockstep (with `package-lock.json` and the mobile `licenses.json` regenerated); the beta.4 document meta-schema v3 vendored (sha256 `5f5360a6…`); the reconnect rules and error copy for `quorum source unavailable`; stale "no non-transferable flag" comments; this record. No contract or topology change. May merge before sakura upgrades. |
| social v15 (separate PR) | re-cut that adopts `transferable: false` on YAPP and the shorthands |

## What beta.4 changes for Yappr

### The SDK fetches a missing quorum key itself (platform#5313)

Before, the trusted context prefetched quorum keys once at `connect()`. A DKG rotation then made newer proofs fail with `invalid quorum: Quorum not found in cache`, the failing proofs banned every address (`no available addresses`), and only a rebuilt instance recovered. Measured on sakura with one read every 30 s from a single, never-rebuilt instance:

| SDK | Result |
| --- | --- |
| 5.0.0-beta.3 | 29 reads ok, then every read failed from about t=15 min to the end of the 30 min run |
| 5.0.0-beta.4 | 59 of 59 reads ok across the same 30 min |

What stays in `evoSdkService`:

| Failure | Rebuild? | Why |
| --- | --- | --- |
| `invalid quorum`, `quorum not found in cache` | yes | A backstop. The SDK still cannot learn a quorum the quorum service does not list (quorum-list-server#16). |
| `no available addresses` | yes | Every address was banned. Only a new instance has a clean pool. |
| `quorum source unavailable` (bare `Context provider error: quorum source unavailable: …`, or as the last error inside `no available addresses to retry, last error: …`) | **no** | The quorum service is unreachable. `connect()` prefetches from the same service, so a rebuild fails the same way. The next read succeeds once it is back. |

`isConnectionError` returns false for any message that contains `quorum source unavailable`, and `scripts/verify-lib.mjs` (`TRANSPORT_COLLAPSE`) does the same. `isUnverifiedOutcomeError` reads it as an answer that could not be verified (a write may have landed), and `categorizeError` shows "Dash Platform is temporarily unavailable. Please try again in a few moments."

### Non-transferable tokens (token config format 1, #5353)

A token configuration can now set `transferable: false`. It needs `$formatVersion` `"1"`, which a beta.3 node and a beta.3 wasm-dpp2 cannot decode. Token config **format 0 is always transferable.** Social v14's YAPP is format 0, so it stays transferable (Yappr offers no transfer UI) and every existing sakura contract decodes unchanged. A later social v15 re-cut adopts `transferable: false`.

### Property shorthands and byte-array rules (#5355, #5357, #5336)

- `"type": "identifier"` and `"type": "bytes"` with a `size` are property shorthands. From PV14 they are expanded to the byte array they stand for before the meta-schema runs, and the contract is stored as sent, so they save bytes on chain.
- Property constraint rules can read byte arrays: a `byteAt` operand (the byte, 0 to 255, at an index), and `startsWith` / `endsWith` over two byte arrays, with hex constants.

`scripts/meta-schema/document-meta-v3.json` is the file at the `v5.0.0-beta.4` tag, byte for byte, and `scripts/contract-probes.mjs` pins its sha256. No Yappr contract uses any of this yet.

## SDK compatibility

- A beta.4 SDK reads a **beta.3** node (the soak above ran beta.4 against sakura while it still ran beta.3). This PR can merge before the devnet upgrade.
- A format-0 contract (all 12 on sakura) encodes and decodes the same under either wasm-dpp2, so a beta.3 SDK keeps reading the upgraded chain. Only a contract holding a format-1 token is unreadable to beta.3.
- **Rule: never register a format-1 token configuration while any node runs beta.3.** The contract would be undecodable there. Register social v15 only after every sakura node reports beta.4.

## Upgrade run book

**In place** (safe for all 12 sakura contracts, since YAPP is format 0):

1. After the nodes swap, `NETWORK=devnet node ops/status.mjs` (drive 5.0.0-beta.4, PV14, the height continuing).
2. Re-run the read batteries and the `/devnet` smoke on the beta.4 SDK.
3. Only then cut social v15.

**Wiped:** rebuild as in [PLATFORM_V5_BETA2_UPGRADE.md](PLATFORM_V5_BETA2_UPGRADE.md) and [SAKURA_BETA3_DEPLOY.md](SAKURA_BETA3_DEPLOY.md).
