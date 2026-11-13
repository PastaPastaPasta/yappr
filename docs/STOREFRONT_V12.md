# Storefront v12

Storefront v12 is the registered storefront v10 deletion-moderation schema plus
D46's recoverable-removal rule. The registered source file stays byte-identical.

Mutable `store` and `storeItem` require and keep `$createdAt`, `$updatedAt`
and `$updatedAtBlockHeight`. Immutable `storeReview` and `itemReview` require
and keep `$createdAt` and `$createdAtBlockHeight`. Reports still discard
removal records. Storefront v11's hide moderation is excluded.

Only required and kept-field arrays change. Version, config, moderation
declaration, delete windows, settled approvals, indexes and fees are unchanged.
Platform supplies the system values; clients add no document content fields.
The kept fields supply the times and heights. The signed transition supplies
the content and `$revision` (implicitly 1 on create); the tool tries contract
versions until the serialized document matches the removal record's
`documentHash`. The record does not supply `$contractVersion`.
See [RECOVERING_DELETED_CONTENT.md](RECOVERING_DELETED_CONTENT.md).

| Property | Value |
| --- | --- |
| File | `contracts/yappr-storefront-contract-v12.json` |
| SHA-256 | `873dc5c665c78cbd8390de181d4bb373068d042a405c002620e123b24df0f214` |
| Signed create estimate | **19,068 B**, testnet and mainnet, rc.4 SDK; 932 B under 20,000 B |
| Status | **Registered on testnet 2026-11-12**: `EkFqdQFuiMbxTbrokrarJb2z2U25s11BFyi1wREPCjaJ` (maker `6dV6s3a6…`, nonce 7; [TESTNET_RELEASE.md](TESTNET_RELEASE.md#registration-record-2026-11-12)) |

Both full offline parsers, node rules and strict-size checks pass on both
networks. It joined social v19 and the other release members in the fresh
`/staging` maker, app and group on 2026-11-12; mainnet follows that set
(D45/D46). The live recovery proof of 2026-11-13 removed and rebuilt every
moderator-deletable type of this cut ([RECOVERING_DELETED_CONTENT.md](RECOVERING_DELETED_CONTENT.md#live-proof-on-the-v19-release-set-2026-11-13)).
