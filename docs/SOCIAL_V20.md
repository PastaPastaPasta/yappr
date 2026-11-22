# Social contract v20

Social v20 is [v19](SOCIAL_V19.md) with two changes: a moderator's removal
record of a `reply` also keeps `replyToReplyId`, the reply it answered, and three
identifiers a document stores must name something that exists
([below](#ids-that-must-exist)).

- Reply removal records keep `[rootPostId, replyToReplyId, $createdAt, $updatedAt, $updatedAtBlockHeight]`
  (v19: `[rootPostId, $createdAt, $updatedAt, $updatedAtBlockHeight]`).
- `followRequest.targetId` and `report.targetOwnerId` declare
  `"refersTo": { "type": "identity" }`, and `post.embedContractId` declares
  `"refersTo": { "type": "contract" }` (v19: none of the three declares a reference).

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

## Ids that must exist

`follow.followingId` and the elements of `mentionedUserIds` already declare
`"refersTo": { "type": "identity" }`: Platform refuses a write naming an
identity that does not exist (`ReferencedEntityNotFoundError`, 40120). Three
other identifiers declared nothing on v19, so a document could name something
that was never there. v20 gives each the same check:

| Property | v19 | v20 | A write is refused (40120) when |
| --- | --- | --- | --- |
| `followRequest.targetId` | `distinctFrom: "$ownerId"` | adds `refersTo: { "type": "identity" }` | the identity asked for access does not exist |
| `report.targetOwnerId` | `distinctFrom: "$ownerId"` | adds `refersTo: { "type": "identity" }` | the reported identity does not exist |
| `post.embedContractId` | no check | `refersTo: { "type": "contract" }` | the embed names a data contract that does not exist |

- **`report.targetOwnerId`.** A report of a post or reply was already tied to
  the content's owner (`where: { "$ownerId": "targetOwnerId" }` on `postId` and
  `replyId`), so only an account report (`about: 1`) could name an identity
  that does not exist. The declaration sits on the property, so every report
  reads the identity.
- **`post.embedContractId`.** Only the contract is checked.
  `embedDocType` and `embedId` stay as they were: an embed may point at any
  document type, deletable ones included, and a document reference would have
  to name one type and one kind of target.
- **Unchanged around them.** `followRequest.targetId` stays immutable and stays
  the key `privateFeedGrant.recipientId` finds a request by (`findBy`);
  `targetOwnerId` is still what the `where` of `postId` and `replyId` compares;
  `embedContractId` stays frozen while the post is not a tombstone. An identity
  or contract reference under an immutable property is allowed (the restriction
  is on `deletableDocument` references), and identities and contracts are never
  removed, so a checked reference never dangles.
- **When it is checked.** On create. A replace checks an identity or contract
  reference again only when the value changed: a follow request's target cannot
  change, a report cannot be replaced, and a tombstone drops the embed, which
  leaves nothing to check. A moderator's restore checks no reference.
- **Cost.** One more billed read on the write: the identity's revision for a
  follow request and for every report, the contract for a post that carries an
  embed (a post without one reads nothing more). The offline estimate
  (`validate-contract-offline.mjs --cost`) does not count reference reads. On
  testnet (2026-11-22, SDK 5.0.0-rc.4) the read added ≈13–15k credits per
  write: see MAINNET_V20_CHECKLIST.md, section 12, item 9. A rerun on SDK
  5.0.3 is still open.
- **Client.** Nothing changes: the app asks to follow a profile it has loaded,
  reports an account or content it shows, and embeds a poll of the Pollr
  contract (`lib/poll-embed.ts`) or a quoted blog post of the blog contract
  (`lib/feed/resolve-quoted-posts.ts`), both members of the release set. No
  write built by the app named a made-up id.

`refersTo` is fixed on update (10246), like `deleteKeepsFields`: a registered
contract cannot gain these checks.

## The file

| Property | Value |
| --- | --- |
| File | `contracts/yappr-social-contract-v20.json` |
| SHA-256 | `40614b818a9acfb75a2323981f3edf5dc1adfa74db28eff2157e18b759662e98` |
| Signed create estimate | **18,361 B**, testnet and mainnet, rc.4 SDK (v19: 18,261 B; 16 B for the kept field, 84 B for the three references); 1,639 B under the 20,000 B budget |
| Status | **Registered on testnet** 2026-11-20 as `63JuBhMjZKyBVJzj7ubCmGEacPsa8VtvgQomMsVrd36D`, the ninth member of the 2026-11-12 group (maker nonce 9, 18,359 B, 91.79e9 credits; [record](TESTNET_RELEASE.md#social-v20-append-2026-11-20)). Not registered on mainnet. |

`deleteKeepsFields` and `refersTo` are fixed once a contract is registered, so no
update can add the kept field or the three references to a registered contract. The testnet set registered on 2026-11-12
(social v19 `3M5Dafkrnh1CaDbvF1XVvJ67xAhGQvqBiNDtNFoMVASG`) keeps the v19 schema,
and its source file stays byte-identical
(SHA-256 `bae9bd60f16b917f39309a8ca2dcc495687ec35174fa9caa08a8b0311e318971`).
Since 2026-11-20 `.env.testnet` and the bundled testnet snapshot name social v20
in that group with topology `v20`, and `/staging` builds from it; v19 stays a
pinned, unused member. The build gate still accepts `v19` for exactly that group,
owner, anchor and v19 social contract, and requires `v20` for every other
release build (`scripts/release-config.cjs`).

Fresh registrations use v20: it is the social member of the default set in
`scripts/app-connect-entries.cjs`, and `.env.testnet.template` and
`.env.mainnet.template` select topology `v20`. Mainnet has registered nothing,
so it would register this file.

### Testnet: appended to the 2026-11-12 group

`/staging` moves to v20 by appending it to the registered group rather than
registering a new set. Memberships can only be added, so the group then holds
nine members: the eight registered on 2026-11-12, with social v19 kept but
unused, and social v20 after them. That is one create and one seated social
team. A fresh set would need eight creates, three teams, a new maker (the
tooling refuses a second fresh set from `6dV6s3a6…`) and a storage reset, and
would leave staging's blog, store, DM and passkey data behind.

The maker `6dV6s3a6…` plans the nine entries (`TESTNET_RELEASE_SET` and
`planTestnetReleaseSet` in `scripts/app-connect-set.mjs`) and resumes its
2026-11-12 journal. It uses that set's policy: `notYetUsable`, one-hour
windows and delay, and a cool-down of 1,209,600 s.

```sh
NETWORK=testnet node scripts/register-app-connect-contracts.mjs --dry-run \
  --append-after passkeyVault --start-nonce 1 --maker 6dV6s3a6Qyr6n3fn1wWmjzc3FanqhnBV2V57469MiPog \
  --interim notYetUsable --election-windows 3600,3600 --election-delay 3600 --challenge-cool-down 1209600
```

Then the same command runs with `--signed-dry-run`, and then with `--live --production`. Both also take
`--maker-key-file <0600 file> --maker-key-id 1`, and `--live` takes `--journal <the 2026-11-12 journal>`.

The append ran on 2026-11-20 as planned (nonce 9, the predicted id;
[record](TESTNET_RELEASE.md#social-v20-append-2026-11-20)). The read-only dry run passed on 2026-11-19 at height 716436 (proved epoch
20492, PV14, Drive 5.0.0-rc.8). It proved all eight members in the group,
with the maker at nonce 8 and holding 129.14e9 credits. Social v20 is planned
at nonce 9 as `63JuBhMjZKyBVJzj7ubCmGEacPsa8VtvgQomMsVrd36D`. The estimate is
92.94e9 credits (≈5,576¢), and the balance gate needs 111.53e9. The id holds
only while the maker spends no other nonce first.

**Order.** The App Connect client requires the group's members to equal its
pins exactly (`checkAppConnectTrust`). Once social v20 joins, a build that pins
eight members refuses new App Connect sign-ins as `unexpected-members`.
Sessions already signed in keep signing for the eight pinned members. A build
that pins nine fails the same way before the create (`missing-members`), so no
one build bridges the two states. Memberships cannot be removed, so there is
no rollback to the eight-member build, and a failed cut-over is fixed forward.
Keep the window between the create and the redeploy short:

1. Before registering, prepare the cut-over branch. `.env.testnet` gets the
   planned id, topology `v20`, all nine pins (`id:1`), YAPP
   `tokens.calculateId(<v20 id>, 0)` and `STORAGE_EPOCH=testnet-release-3`
   (D21). The group stays the same, but the social contract and YAPP token
   change, and browser state is kept per identity, not per contract. For
   example, the starter-grant marker (`lib/starter-grant.ts`) would hide a
   v20 grant from someone who claimed v19 YAPP in the same browser. A clean
   start drops all of it, and people sign in again. Set
   `E2E_STORAGE_SCOPE` to match (`testnet-release-3:staging`). The build gate already accepts social
   v19 as an unused pin of this group when the build names another social
   contract (`unusedMembersOf` in `scripts/release-config.cjs`).
2. Run `--signed-dry-run` and confirm the maker's nonce is still 8.
3. Run `--live`. Check the landed id against the branch. If it differs, take
   the id from the journal.
4. Refresh the bundled testnet snapshot (`NETWORK=testnet npm run
   contracts:snapshot -- --prune`, with `CONTRACT_IDS` naming the `/testing`
   defaults as in the activation and the unused social v19
   `3M5Dafkrnh1CaDbvF1XVvJ67xAhGQvqBiNDtNFoMVASG`: no contract variable names it
   any more, and deployment monitoring checks every group pin against the
   snapshot), then build, push and merge into `staging` at once. `/staging` refuses new App Connect sign-ins from step 3 until this
   deploy is live.
5. File the social charter for the new contract with
   `file-release-charters.mjs`, as on 2026-11-12. The contract accepts no
   posts (`notYetUsable`) until its team is seated, which takes about two hours
   with the one-hour windows and delay.


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
- The web thread page and the mobile engine (`mobile/engine/src/api/posts.ts`,
  first load and continuation) share those reads:
  `lib/feed/missing-reply-parent-reads.ts`, which asks for the records a hundred
  ids at a time.
- The placeholder renders at any depth (`components/post/reply-thread.tsx`; the
  mobile thread rows already carry each row's depth).

## Tooling

- `scripts/recover-deleted.mjs` needs nothing new: `replyToReplyId` is content,
  which the signed create supplies and the record's `documentHash` commits to.
  An offline regression rebuilds a v20 nested reply and a direct reply
  (`scripts/recovery/content.test.mjs`).
- `verify-v10.mjs` reads the three references off the file: `d1e`, `r1z3a` and
  `c1e` expect 40120 for a follow request to, an account report of and an embed
  from something that does not exist, and `c1f` an embed naming a contract that
  exists. The m2/s1 unpriced probe (a follow request to a made-up id through
  v19) asks the contract's owner on v20, and `measure-social-fees.mjs` reports
  the poster's account instead of a made-up one. None of these has run on a
  network; `--self-test` and `--dry-run` cover them offline.
- `verify-v10.mjs --self-test` pins the v20 reply list. `prove-merged-counts.mjs`
  removes a nested reply (`kf-2n`) and a direct one (`kf-2`) and compares each
  record with the fields the document holds.
- `validate-contract-offline.mjs contracts/yappr-social-contract-v20.json
  --strict-size --network testnet` and `--network mainnet` pass (full
  validation on the rc.4 wasm-sdk, the node rules on wasm-dpp2).

On testnet (2026-11-22, SDK 5.0.0-rc.4) a moderator removed a direct and a
nested reply under v20: the nested record kept `replyToReplyId`, the direct one
omitted it, and both were recovered and hash-verified (MAINNET_V20_CHECKLIST.md,
section 12, item 9). A rerun on SDK 5.0.3 is still open.
