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
| Status | **Not yet registered** |

Both full offline parsers, node rules and strict-size checks pass on both
networks. No live registration or recovery proof is claimed for this cut.
It joins social v19 and the other release members in a fresh `/staging`
maker, app and group; mainnet follows that set (D45/D46). Existing testnet ids,
snapshots and the `/beta` experiment stay pinned until cut-over.
