# Blog v11

Blog v11 is the registered blog v9 deletion-moderation schema plus
D46's recoverable-removal rule. The registered source file stays byte-identical.

Mutable `blog` and `blogPost` require `$createdAt`, `$updatedAt` and
`$updatedAtBlockHeight` and keep all three in removal records. `blogPost`
also keeps `blogId`. Immutable `blogComment` requires and keeps `$createdAt`
and `$createdAtBlockHeight`, alongside its existing kept `blogPostId`.
Reports still discard removal records. Blog v10's hide moderation is excluded.

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
| File | `contracts/yappr-blog-contract-v11.json` |
| SHA-256 | `d1a53c31803a2f6f057700b358755b4d927318bfdcd5d2cb5b6718e8942dca6c` |
| Signed create estimate | **9,454 B**, testnet and mainnet, rc.4 SDK; 10,546 B under 20,000 B |
| Status | **Registered on testnet 2026-11-12**: `E813f6SAMzvquTM9G6LFgtDJjm1h3B4V8J6qkQ2KYW7e` (maker `6dV6s3a6…`, nonce 5; [TESTNET_RELEASE.md](TESTNET_RELEASE.md#registration-record-2026-11-12)) |

Both full offline parsers, node rules and strict-size checks pass on both
networks. It joined social v19 and the other release members in the fresh
`/staging` maker, app and group on 2026-11-12; mainnet follows that set
(D45/D46). The live recovery proof of 2026-11-13 removed and rebuilt every
moderator-deletable type of this cut ([RECOVERING_DELETED_CONTENT.md](RECOVERING_DELETED_CONTENT.md#live-proof-on-the-v19-release-set-2026-11-13)).
