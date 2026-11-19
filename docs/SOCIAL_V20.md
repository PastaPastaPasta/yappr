# Social contract v20

Social v20 is [v19](SOCIAL_V19.md) with one more kept field: a moderator's
removal record of a `reply` also keeps `replyToReplyId`, the reply it answered.

- Reply removal records keep `[rootPostId, replyToReplyId, $createdAt, $updatedAt, $updatedAtBlockHeight]`
  (v19: `[rootPostId, $createdAt, $updatedAt, $updatedAtBlockHeight]`).

Nothing else changes: version, config, tokens, moderation declaration, fees,
indexes, required fields, document content and every other type's kept fields
are exactly v19's. `scripts/recoverable-contracts.test.mjs` and
`lib/contract-topology.test.ts` compare the two files.

## Why

A v19 record says which post a removed reply was under (`rootPostId`), but not
which reply it answered. A reader can show that a reply was removed, but cannot
put it at its depth, and the replies under it lose their parent chain: the
thread shows the hole at the top level with those replies under it.

`replyToReplyId` is an optional, immutable identifier of the reply itself
(`refersTo: moderatedDocument reply where {rootPostId: rootPostId}`). The record
of a nested reply keeps it; the record of a direct reply leaves it out, because
a record keeps only the listed fields the document holds (as a post's `tags`).

Removal record of a nested reply, v19:

```json
{
  "documentId": "<reply>", "documentOwnerId": "<author>", "moderatorId": "<moderator>",
  "reason": { "text": "..." }, "removedAt": "1794000000000", "documentHash": "<hash>",
  "keptFields": {
    "rootPostId": "<post>",
    "$createdAt": "1793990000000", "$updatedAt": "1793990000000", "$updatedAtBlockHeight": "680000"
  }
}
```

The same record on v20:

```json
{
  "documentId": "<reply>", "documentOwnerId": "<author>", "moderatorId": "<moderator>",
  "reason": { "text": "..." }, "removedAt": "1794000000000", "documentHash": "<hash>",
  "keptFields": {
    "rootPostId": "<post>",
    "replyToReplyId": "<the reply it answered>",
    "$createdAt": "1793990000000", "$updatedAt": "1793990000000", "$updatedAtBlockHeight": "680000"
  }
}
```

## The file

| Property | Value |
| --- | --- |
| File | `contracts/yappr-social-contract-v20.json` |
| SHA-256 | `3e6c962264392f3fc97cb57a7d983d2ae053f9d455ff64dde64b16805d7ae87e` |
| Signed create estimate | **18,277 B**, testnet and mainnet, rc.4 SDK (v19: 18,261 B); 1,723 B under the 20,000 B budget |
| Status | **Not registered on any network.** |

`deleteKeepsFields` is fixed once a contract is registered, so no update can add
the field to a registered contract. The testnet set registered on 2026-11-12
(social v19 `3M5Dafkrnh1CaDbvF1XVvJ67xAhGQvqBiNDtNFoMVASG`) keeps the v19 list
until a set is registered again, and its source file stays byte-identical
(SHA-256 `bae9bd60f16b917f39309a8ca2dcc495687ec35174fa9caa08a8b0311e318971`).
`.env.testnet` and the bundled testnet snapshot still name that set with
topology `v19`, and `/staging` keeps building from it: the build gate accepts
`v19` for exactly that group, owner, anchor and social contract, and requires
`v20` for every other release build (`scripts/release-config.cjs`).

Fresh registrations use v20: it is the social member of the default set in
`scripts/app-connect-entries.cjs`, and `.env.testnet.template` and
`.env.mainnet.template` select topology `v20`. Mainnet has registered nothing,
so it would register this file. Registering testnet again needs a new maker,
anchor and group, as D46 did.

## Client

`NEXT_PUBLIC_CONTRACT_TOPOLOGY=v20`. The descriptor and every predicate are
v19's except `removedRepliesKeepTheirParent()` (`lib/contract-topology.ts`),
read off the file's `deleteKeepsFields`.

- `toKeptFields` (`lib/services/moderation-service.ts`) decodes
  `replyToReplyId` into `RemovalKeptFields`.
- The thread page stands a placeholder in for a reply proved gone when a loaded
  reply nests under it (`withMissingReplyParents`,
  `lib/feed/deleted-reply-stubs.ts`). On v20 it reads the removal records of
  those placeholders and puts each one back under the reply it answered. A
  parent that is missing in turn (another removed reply, or an author's
  tombstone) is resolved the same way until none is left. A placeholder whose
  record names no parent stays at the top of the thread, as on v19, and so does
  every placeholder when the record read fails.
- The placeholder renders at any depth (`components/post/reply-thread.tsx`).

## Tooling

- `scripts/recover-deleted.mjs` needs nothing new: `replyToReplyId` is content,
  which the signed create supplies and the record's `documentHash` commits to.
  An offline regression rebuilds a v20 nested reply and a direct reply
  (`scripts/recovery/content.test.mjs`).
- `verify-v10.mjs --self-test` pins the v20 reply list. `prove-merged-counts.mjs`
  removes a nested reply (`kf-2n`) and a direct one (`kf-2`) and compares each
  record with the fields the document holds.
- `validate-contract-offline.mjs contracts/yappr-social-contract-v20.json
  --strict-size --network testnet` and `--network mainnet` pass (full
  validation on the rc.4 wasm-sdk, the node rules on wasm-dpp2).

No removal record has been written under v20 on a network: the kept value of a
nested reply and the omission for a direct one follow from Platform's rule for
kept fields and are covered offline only.
