# Social contract v19

Social v19 is [v17](SOCIAL_V17.md) plus PR #931's update-height and kept-times
change, extended to every recoverable removal (D46). It retains deletion, ban,
suspension and warning moderation,
D39's one-day delete window and D41's leader-plus-one settled approvals.
Nothing from v18's hide-moderation experiment is included.

- `post.required`: `[$createdAt, $updatedAt, $updatedAtBlockHeight]`.
- `reply.required`: `[$createdAt, $updatedAt, $updatedAtBlockHeight, rootPostId]`.
- Post removal records keep `[tags, $createdAt, $updatedAt, $updatedAtBlockHeight]`.
- Reply removal records keep `[rootPostId, $createdAt, $updatedAt, $updatedAtBlockHeight]`.

`yapprProfile` also requires `$updatedAtBlockHeight` and keeps `$createdAt`,
`$updatedAt` and `$updatedAtBlockHeight`. Reports still discard removal records.
Only required and kept-field arrays change. Version, config, tokens, moderation
declaration, fees, indexes and document content stay exactly as v17.
Platform sets the required height on create and update; clients supply no new
content fields. A kept system property must also be required by its type.

The kept fields supply the times and heights. The signed create or replace
transition supplies the content and `$revision` (implicitly 1 on create).
The tool tries contract versions until the serialized document matches the
removal record's `documentHash`; the record does not supply `$contractVersion`.
See [RECOVERING_DELETED_CONTENT.md](RECOVERING_DELETED_CONTENT.md).

| Property | Value |
| --- | --- |
| File | `contracts/yappr-social-contract-v19.json` |
| SHA-256 | `bae9bd60f16b917f39309a8ca2dcc495687ec35174fa9caa08a8b0311e318971` |
| Signed create estimate | **18,261 B**, testnet and mainnet, rc.4 SDK; 1,739 B under the 20,000 B budget |
| Status | **Registered on testnet 2026-11-12**: `3M5Dafkrnh1CaDbvF1XVvJ67xAhGQvqBiNDtNFoMVASG` (maker `6dV6s3a6…`, nonce 2; [TESTNET_RELEASE.md](TESTNET_RELEASE.md#registration-record-2026-11-12)) |

Required fields and `deleteKeepsFields` are fixed on update, so v19 required a
fresh registration: `/staging` runs it from a new maker, app anchor and group
(2026-11-12), and mainnet will register that release set per D45/D46. The
registered v17 file (SHA-256
`77cf4308d40d916ce9f128e84f584344b57e3525c30d4d20509bf3a4485196bf`) and its
retired `4nYYMMs9…` contract stay unchanged. V18 and `/beta` also stay unchanged.

The required height adds 8 B to a stored post, reply or profile; the signed create
estimate grows 207 B over v17. Write fees have not been measured again.
Offline validation and a reconstruction regression cover the cut. On
2026-11-13 the seated social team removed a post and a reply on the registered
contract: each removal record kept exactly the type's `deleteKeepsFields` with
the document's own stored height and times, and the recovery tool rebuilt both
to the record's `documentHash` ([RECOVERING_DELETED_CONTENT.md](RECOVERING_DELETED_CONTENT.md#live-proof-on-the-v19-release-set-2026-11-13)).
