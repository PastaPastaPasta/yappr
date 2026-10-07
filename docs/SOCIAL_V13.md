# Social v13, the mainnet candidate, and the blocks contract

Social v13 is social v12 ([SOCIAL_V12.md](SOCIAL_V12.md)) with the changes the user decided after the 2026-10-06 pre-mainnet audit. Most of them were prototyped and measured offline during the audit; this cut rebuilds them cleanly on Platform 5.0.0-beta.2. The `block`, `blockFilter` and `blockFollow` types move to a new standalone contract, `contracts/yappr-blocks-contract.json`.

This PR is contracts and tooling only. Nothing is registered on any network, and the client still has no `v13` topology: wiring it is the follow-up PR ([below](#client-work-for-the-follow-up-pr)).

| # | Decision | What changes |
| --- | --- | --- |
| 1 | **Moderation for mainnet** | Elected, `seatContestable: true` with a 30-day `challengeCoolDown`, a 7-day `joinWindow` and a 3-day `voteWindow` (mainnet's floor is one day; v12's 3600 s windows fail there with 10900), `maxAddedModerators: 10`, `ownerProtected: true`. The file keeps `interim: contractOwner` for devnets; **mainnet registers `notYetUsable`** at registration time ([below](#the-mainnet-interim)). |
| 2 | **Reply integrity** | A new required, immutable `reply.rootOwnerId`, bound to the root post's owner (`rootPostId.refersTo.where: {"$ownerId": "rootOwnerId"}`). The rule `parentIsRoot` makes a top-level reply's `parentOwnerId` that owner. A nested reply's parent must be in the same thread (`replyToReplyId.refersTo.where` adds `"rootPostId": "rootPostId"`). On v12 a top-level reply could name any `parentOwnerId` and forge "replied to you" notifications, and a nested reply could cross threads. `parentOwnerRecent` is unchanged. |
| 3 | **No reply-like author counter** | `likeReply.byAuthorReply` and `replyAuthor` are dropped. Nothing reads them on v12, and the preallocated counter cost a reply up to 15M credits. |
| 4 | **Reports** | Unique `byPost [postId, $ownerId]` and `byReply [replyId, $ownerId]` replace the four target indexes; `byTime` is gone. **Profile reports**: an optional `about` (1 = the profile), only on identity reports, with a unique `byTarget [targetOwnerId, about, $ownerId]`. **Private post and reply reports** may carry a `box` (≤5,120 B): the moderators' access key wrapped to each current moderator. **No DM reports** (DMs are not moderated). `reason` goes up to 9 (9 = sexual content involving minors). Exactly one target per report. A 50M-credit moderators action fee on create. |
| 5 | **Blocks split** | `block`, `blockFilter` and `blockFollow` move to `contracts/yappr-blocks-contract.json` (bare schemas, unmoderated, like the other feature contracts). `block.ownerBlocks` is dropped. Nothing in social refers to them. |
| 6 | **Media arrays** | `mediaUrls` (1–4 URLs), `mediaDigests` (40 B per item: sha256 + fingerprint) and `mediaKinds` (1 B per item: 0 image, 1 video, 2 gif) replace `mediaUrl`, `mediaHash` and `mediaFingerprint` on post and reply. The rule `media` makes the three lengths agree. |
| 7 | **Live marker** | `post.live` (`const: true`) is on every post that is not a tombstone, and off every tombstone. `ownerAndTime` becomes `[live, $ownerId, $createdAt]` with `skipIfAbsent`, so a tombstone leaves the author's timeline and post count. |
| 8 | **Compaction** | Explicit defaults stripped, rule names shortened, and the index names no client code names shortened. |

Everything else is v12's, including the like counters (`summableOffCountIndex`), `retractedWhen`, the tombstone, settled deletion and the YAPP token.

Topology label for the follow-up: `v13`. v2, v9, v10, v11 and v12 are untouched.

## The files

| | Social v13 | Blocks |
| --- | --- | --- |
| File | `contracts/yappr-social-contract-v13.json` | `contracts/yappr-blocks-contract.json` |
| sha256 | `d58a25cb6a4cb4a2652112fc04c584f142d6f9b2dfbd63f7f31530beac79b81f` | `45f04cba5f81db446cc4846ab36d32e949a99ce2068f31572a9ab5c23ae4a850` |
| Signed create (validator estimate) | **~18,824 B**: 1,176 B under the 20,000 B budget, 1,656 B under the 20,480 B cap. The same on mainnet (the interim is one enum either way). v12's estimate is 19,812 B and it published at 19,877 B, so expect about 18,890 B on chain | ~1,429 B |
| Document types | 12: bookmark, follow, followRequest, like, likeReply, post, privateFeedGrant, privateFeedRekey, privateFeedState, reply, report, yapprProfile | 3: block, blockFilter, blockFollow |
| Parses | wasm-sdk and wasm-dpp2 (5.0.0-beta.2) under full validation; `auditNodeRules` clean on devnet and with `--network mainnet`; meta-schema v3 clean | the same, with the default unmoderated config |

What each change adds to or saves from the signed size, measured leave-one-out (v13 with that one change put back to v12's shape). Leave-one-out deltas do not add up exactly (the rows sum to −1,035 B, the whole diff is −988 B): the changes share serialized structure, such as the post and reply rule maps.

| Change | Bytes |
| --- | ---: |
| 1 moderation declaration (contestable seat, windows) | +9 |
| 2 reply integrity (`rootOwnerId`, two `where` entries, `parentIsRoot`) | +303 |
| 3 drop `likeReply.byAuthorReply` and `replyAuthor` | −331 |
| 4 reports (profile target, `box`, rules, action fee; four target indexes merged into two, `byTime` dropped) | +224 |
| 5 blocks split (and `ownerBlocks` dropped) | −1,305 |
| 6 media arrays | +161 |
| 7 live marker | +191 |
| 8 explicit defaults stripped | −124 |
| 8 rule names shortened | −101 |
| 8 index names shortened | −62 |
| **v12 → v13** | **19,812 → 18,824 (−988)** |

## The diff against v12

| Type | v12 | v13 |
| --- | --- | --- |
| config | elected, `joinWindow`/`voteWindow` 3600, `seatContestable: false` | **`joinWindow: 604800`, `voteWindow: 259200`, `seatContestable: true`, `challengeCoolDown: 2592000`**; `maxAddedModerators: 10`, `ownerProtected: true` and the moderated set unchanged; interim `contractOwner` in the file, **`notYetUsable` on mainnet** |
| `block`, `blockFilter`, `blockFollow` | in social; `block.ownerBlocks [$ownerId, $createdAt]` | **moved to the blocks contract**; `ownerBlocks` dropped; everything else unchanged |
| `reply` | `rootPostId` → post (no `where`); `replyToReplyId` → reply `where {$ownerId: parentOwnerId}` | **`rootOwnerId`** (identifier, required, immutable); `rootPostId` `where {$ownerId: rootOwnerId}`; `replyToReplyId` `where {$ownerId: parentOwnerId, rootPostId: rootPostId}`; rule **`parentIsRoot`** `{ifThen: [{absent: replyToReplyId}, {equal: [parentOwnerId, rootOwnerId]}]}` |
| `likeReply` | `byAuthorReply [replyAuthor, replyId]` counter, `replyAuthor` (required), `replyId` `where {$ownerId: replyAuthor}` | **dropped**: only `byReply` and `replyId` remain |
| `report` | `ownerAndPost`, `ownerAndReply` (unique `[$ownerId, target]`), `byPost`, `byReply` (`[target]`), `byTime`, `byStatus`, `byModerator`; `reason` 0–8; no action fee | **`byPost [postId, $ownerId]`, `byReply [replyId, $ownerId]`, `byTarget [targetOwnerId, about, $ownerId]`** (all unique, `skipIfAbsent`), `byStatus`, `byModerator`; **`about`** (integer 1–1), **`box`** (byte array, 1–5,120 B); `reason` 0–**9**; rules `oneTarget` (three targets), **`boxOnContent`**, `otherNote`, `resolvedStatus`; **`actionFees.create.moderators: 50000000`** |
| `post`, `reply` | `mediaUrl` (string), `mediaHash` (32 B), `mediaFingerprint` (8 B), tied by `dependentRequired` | **`mediaUrls`** (typed array, 1–4 strings, pattern `^(https?|ipfs)://.+$`, `maxLength`/`maxBytes` 512), **`mediaDigests`** (byte array, 40–160 B), **`mediaKinds`** (byte array, 1–4 B); rule **`media`**; no `dependentRequired`; all three blanked by the tombstone and frozen while not tombstoned |
| `post` | `ownerAndTime [$ownerId, $createdAt]` | **`live`** (`boolean`, `const: true`, optional); rule **`live`**; conditional `immutable` entry; **`ownerAndTime [live, $ownerId, $createdAt]`**, `skipIfAbsent`, `rangeCountable`, `rankedCountable {at: $ownerId}` |
| `post`, `reply`, `like`, `likeReply`, `yapprProfile` | `documentsMutable: true` (post, reply), `canBeDeleted: true` (like, likeReply), `minLength` beside a pattern that implies it (`hashtag` 1, `paymentUris`/`socialLinks` items 3) | stripped (the contract defaults and the patterns say the same) |
| rule names | `embedAllOrNone`, `oneQuoteTarget`, `privateAllOrNone`, `privateHasNoMedia`, `quoteNamesOwner`, `notEmpty`, `tombstoneIsBlank`, `oneTarget`, `otherHasNote`, `resolvedHasStatus` | `embed`, `oneQuote`, `private`, `privateNoMedia`, `quoteOwner`, `notEmpty`, `blankTombstone`, `oneTarget`, `otherNote`, `resolvedStatus` |
| index names | `bookmark.ownerAndPost`/`ownerBookmarks`, `follow.ownerAndFollowing`, `followRequest.targetAndRequester`, `privateFeedGrant.ownerAndRecipient`/`ownerAndLeaf`, `privateFeedRekey.ownerAndKeyGeneration` | `ownerPost`/`ownerTime`, `pair`, `pair`, `recipient`/`leaf`, `generation`. No code under `lib/` or `mobile/` names these (only comments and the v10 topology tests do), and none is counted. Every index a count query or a named read uses keeps its name. |

## The changes

### 1. Moderation and the mainnet interim

The elected declaration is fixed once registered (40002 on any later change, the interim included; a `--probes` update probe pins it), so it is cut for mainnet now:

- **Windows:** applicants join for 7 days once the first applies, and masternodes vote for 3 days. Mainnet refuses a window under one day (10900).
- **Contestable seat:** `seatContestable: true` with `challengeCoolDown: 2592000` (30 days; the platform allows 14 days to 3 years). Nothing reads it before challenges ship after protocol version 14, but the key is frozen at creation, so it is set now. A seated team is then safe from a challenge for 30 days after each seat change.
- `maxAddedModerators: 10` and `ownerProtected: true`, as on v12. The team can hold the leader, up to 15 elected members and 10 added ones, so `deleteSettled { leader, approvals: 3 }` always fits.

#### The mainnet interim

The user decided that mainnet registers with `interim: {"$type": "notYetUsable"}`. Testnet is undecided. One file serves every network: the committed file declares `contractOwner` (a devnet needs an owner who moderates before any team is seated), and the interim is chosen when the contract is registered:

- `withInterim(config, { network, interim })` in `scripts/register-lib.mjs` swaps an elected declaration's interim: on mainnet to `notYetUsable`, elsewhere to the file's own, unless `--interim <kind>` names one (`contractOwner`, `notYetUsable` or `noModeration`; `appointedModerators` needs identities, so it can only come from a file).
- `register-feature-contract.mjs` registers with `withInterim` for `NETWORK`, so `NETWORK=mainnet node scripts/register-feature-contract.mjs --file yappr-social-contract-v13.json (--bot <n> --owner <id> | --persona <idx>)` publishes `notYetUsable`. With `--dry-run` instead of an owner it prints the declaration it would publish, offline.
- `validate-contract-offline.mjs --network mainnet` validates and sizes that same rendering and prints `interim: notYetUsable as registered on mainnet (the file declares contractOwner)`. `--interim` validates another.
- `register-social-v3-draft.mjs` (devnet only) takes `--interim` too.

**What `notYetUsable` means, and why it matters.** Nobody moderates and nobody claims the moderators' pot (the fees accumulate for the first team). The moderated document types, **post, reply, report and yapprProfile, cannot be written at all** until an election seats a team (41200). The other types (follow, bookmark, private feed) work. On mainnet Yappr can therefore not post until its first election has run: at least the 7-day join window plus the 3-day vote. Since the interim cannot be changed after registration (40002), a mainnet contract registered with it stays closed until a team is seated. That was the user's decision; the follow-up client must explain the state to users.

### 2. Reply integrity

On v12 nothing bound a top-level reply's `parentOwnerId`: anyone could write one naming any identity, and that identity's "replied to you" poll (`parentOwnerRecent`) would show it. A nested reply's parent was bound to `parentOwnerId`, but not to the thread, so a reply could hang under a reply of another thread.

| Write | v12 | v13 |
| --- | --- | --- |
| A top-level reply naming the post's owner | accepted | accepted |
| A top-level reply naming someone else as `parentOwnerId` | **accepted (forged notification)** | 10422 `parentIsRoot` |
| A reply naming someone else as `rootOwnerId` | (no such field) | 40127 (`rootPostId` `where`) |
| A nested reply whose parent is in another thread | **accepted** | 40127 (`replyToReplyId` `where`) |
| A nested reply naming the wrong parent owner | 40127 | 40127 |

So `rootOwnerId` is always the root post's owner, and a top-level reply's `parentOwnerId` is too. A nested reply's `parentOwnerId` is still its parent reply's owner. `parentOwnerRecent [$createdAt, parentOwnerId]` is unchanged and needs no second index: "replied to your post" and "replied to your reply" both arrive on it.

`rootOwnerId` is immutable with `rootPostId`, `replyToReplyId` and `parentOwnerId`. It is not in the moderator's removal record (`deleteKeepsFields` stays `rootPostId`, `$createdAt`): nothing refers to a reply's `rootOwnerId`, while the nested reply's `where` reads the parent's `rootPostId`, which the record keeps. The audit's alternative, dropping `parentOwnerId` for derived `rootPostId.$ownerId` indexes, was smaller but needed a second notification index; the user chose the stored field.

### 3. likeReply without the author counter

v12's `byAuthorReply` counter (one per reply, preallocated) existed for "likes on my replies" totals that no client reads. Without it a reply create is 7M to 15M credits cheaper (no preallocated counter), and a reply like no longer copies the reply's author. Reply likes are still counted per reply on `byReply`.

### 4. Reports

| Report | `postId` | `replyId` | `about` | `box` | `targetOwnerId` |
| --- | --- | --- | --- | --- | --- |
| a post | ✓ | | | allowed (the client sends one for a private post) | the post's owner (`where`) |
| a reply | | ✓ | | allowed (the client sends one for a private reply) | the reply's owner (`where`) |
| a profile | | | 1 | never | the reported identity |

- **One target.** `oneTarget` is `ifThenElse [present postId, no replyId and no about, ifThenElse [present replyId, no about, about]]`: exactly one of the three. An arithmetic form (`count` of the targets) is refused at registration: `count` reads arrays and byte arrays, not identifiers (a `--probes` probe pins it).
- **One report per reporter and target.** `byPost` and `byReply` are unique on `[target, $ownerId]` and `byTarget` on `[targetOwnerId, about, $ownerId]`, each `skipIfAbsent`, so a post report is not in `byTarget` and a profile report is in neither of the others. The same indexes list a target's reports. `byTime` is gone: the moderators' queue reads `byStatus` (open reports have no `status`).
- **`about`** is an integer, 1 for the profile. Its maximum is fixed at 1 for now; a contract update can raise it later (an update probe shows a larger maximum is accepted), and the rules already treat any `about` as an identity target.
- **The box.** A report of a private post or reply may carry `box`, up to 5,120 B: the key that lets the moderators read the reported content, wrapped to each current moderator. The user wants broad context, so the key is the private feed's CEK for the post's `keyGeneration`, not only the per-post key. Moderators can then read the author's other private posts of that generation. `boxOnContent` refuses a box on a profile report. Consensus does not read the box: its format, and which keys it is wrapped to, are the client's (follow-up). There is no `teamWraps`-style re-wrap field: a moderator seated after the report cannot open its box.
- **No DM reports.** DMs stay unmoderated; users block.
- **Reasons** 0–9; 8 ("something else") needs a `note` (`otherNote`); 9 is sexual content involving minors.
- **Fee.** A report pays a 50M-credit moderators action fee (3¢ at $60/DASH, on the epoch fee multiplier), on top of its network fee and like any post or reply fee. It goes to the moderators' pot. Reports still expire after 90 days (`ttl`).

### 5. The blocks contract

`contracts/yappr-blocks-contract.json` holds `block`, `blockFilter` and `blockFollow` as bare schemas (no `config`), so it registers with the default unmoderated config like DM or profile. The types are v12's except that `block.ownerBlocks` (`[$ownerId, $createdAt]`, read by no client) is dropped; a user's blocks list reads `ownerAndBlocked` (`$ownerId ==`). `blockFollow.followedBlockers` keeps its typed array of `identity` references. Moving them out saves 1,305 B of social, and each block write drops one index (about 17M credits on a first block). The legacy `contracts/yappr-block-contract.json` (the pre-v2 standalone contract) is unrelated and stays as it was.

### 6. Media arrays

| Field | Shape | Per item |
| --- | --- | --- |
| `mediaUrls` | typed array of 1–4 strings, `^(https?|ipfs)://.+$`, each ≤512 characters and bytes | the URL |
| `mediaDigests` | byte array, 40–160 B | sha256 of the bytes at the URL (32 B) + the 64-bit fingerprint ([SOCIAL_V10.md](SOCIAL_V10.md#the-media-fingerprint-pinned), 8 B) |
| `mediaKinds` | byte array, 1–4 B | 0 image, 1 video, 2 gif |

`media` is `allOf [count(mediaUrls) × 40 = count(mediaDigests), count(mediaUrls) = count(mediaKinds)]`. A field left out counts 0, so the rule also makes the three present together or not at all. `privateNoMedia` refuses `mediaUrls` beside ciphertext, `notEmpty` takes `mediaUrls` as content, and `blankTombstone` and the conditional `immutable` entries cover all three. Consensus cannot check the value of each kind byte (no rule reads inside a byte array), so a byte above 2 must be ignored by readers.

### 7. The live marker

On v12 a tombstone stayed in `ownerAndTime`, so it was counted in the author's post count and listed on their profile, and the client had to filter it out. v13 adds `live: {"type": "boolean", "const": true}`:

- `live` is `{ifThenElse: [{present: deleted}, {absent: live}, {present: live}]}`: every post carries `live: true` until it is tombstoned, and the tombstone leaves `live` out. `false` is refused by `const`.
- `{"property": "live", "when": {"absent": "deleted"}}` freezes it while the post is not a tombstone (redundant with the rule, but explicit).
- `ownerAndTime [live, $ownerId, $createdAt]` skips a document without `live`, so a tombstone drops out of the author's timeline, the author post count (`rangeCountable`) and top creators (`rankedCountable {at: $ownerId}`). Reads add `live == true` before `$ownerId`.
- `live` cannot be required: `ownerAndTime` could then never skip (a `--probes` probe pins the refusal).

### 8. Compaction

- **Defaults.** `documentsMutable: true` on post and reply and `canBeDeleted: true` on like and likeReply restate the config's contract defaults. `minLength` on `hashtag` (the pattern requires 1 to 61 characters) and on the `paymentUris`/`socialLinks` items (each pattern needs at least 3 characters) restates its pattern. The config block is serialized as fixed fields (dropping its default keys, or the default `joinWindow`, measures 0 B), so it keeps v12's keys and states the windows explicitly.
- **Rule names** appear only in 10422 errors. Rules are judged in the order of their names; the shorter names keep a tombstone's `blankTombstone` ahead of `live` and `media`, and a report's `boxOnContent` ahead of `oneTarget`.
- **Index names**: only those no client code names (grep of `lib/` and `mobile/`; count queries name their index). `following`, `followers`, `target`, every like, post, reply and report index, and every `owner` keep their names.

## Costs

`node scripts/validate-contract-offline.mjs <file> --cost` now prints a network fee per write: `documentCreateCost` (storage exact, processing estimated) for the first document with its index values and for a later one, with the action fee the contract adds. Cents are at $60/DASH, where 1M credits = 0.06¢. YAPP token costs are not credits and are not included. The estimator overstates the live fee: on v12 a later like was estimated at 22.5M and measured at 15.9M on sakura ([SOCIAL_V12.md](SOCIAL_V12.md#measured-costs)). v13 has not been measured live. A report's "later" figure above its "first" one is an estimator quirk (it was so on v12 too).

| Write | v12, first / later | **v13, first / later** | Action fee |
| --- | ---: | ---: | ---: |
| post, 140 characters | 127.2M (7.63¢) / 74.5M (4.47¢) | **135.5M (8.13¢) / 74.8M (4.49¢)** | 80M (4.80¢) |
| post, tagged | 184.4M (11.07¢) / 101.7M (6.10¢) | **192.8M (11.57¢) / 102.1M (6.12¢)** | 80M |
| post, one image | — | **145.4M (8.72¢) / 84.7M (5.08¢)** | 80M |
| post, four images | — | **174.5M (10.47¢) / 113.8M (6.83¢)** | 80M |
| private post (300 B ciphertext) | 133.3M (8.00¢) / 80.7M (4.84¢) | **141.7M (8.50¢) / 81.0M (4.86¢)** | 80M |
| quote | 176.0M (10.56¢) / 99.6M (5.98¢) | **190.4M (11.42¢) / 100.8M (6.05¢)** | 80M |
| repost (a bare quote) | 171.3M (10.28¢) / 94.9M (5.70¢) | **185.7M (11.14¢) / 96.1M (5.77¢)** | 80M |
| reply, 140 characters | 120.8M (7.25¢) / 57.6M (3.46¢) | **106.0M (6.36¢) / 50.8M (3.05¢)** | 16M (0.96¢) |
| reply to a reply | 123.6M (7.42¢) / 58.7M (3.52¢) | **108.8M (6.53¢) / 51.8M (3.11¢)** | 16M |
| reply, one image | — | **115.7M (6.94¢) / 60.5M (3.63¢)** | 16M |
| like | 74.4M (4.46¢) / 22.5M (1.35¢) | **the same** | |
| like, tagged post | 121.9M (7.31¢) / 38.8M (2.33¢) | **the same** | |
| reply like | 39.3M (2.36¢) / 11.8M (0.71¢) | **20.4M (1.22¢) / 10.3M (0.62¢)** | |
| report a post or a reply | 14.4M (0.86¢) / 16.2M (0.97¢) | **12.5M (0.75¢) / 13.5M (0.81¢)** | **50M (3.00¢)** |
| report a profile | — | **12.5M (0.75¢) / 13.5M (0.81¢)** | 50M |
| report a private post, 400 B box (about 3 moderators) | — | **14.8M (0.89¢) / 15.9M (0.95¢)** | 50M |
| report a private post, full 5,120 B box | — | **42.1M (2.52¢) / 43.1M (2.59¢)** | 50M |
| bookmark | 48.7M (2.92¢) / 31.8M (1.91¢) | **the same** | |
| follow | 86.1M (5.17¢) / 43.3M (2.60¢) | **the same** | |
| block (now in the blocks contract) | 48.9M (2.93¢) / 31.9M (1.91¢) | **31.4M (1.88¢) / 23.4M (1.41¢)** | |
| block filter (a 1 KB filter) | 56.5M (3.39¢) | **the same** | |

- **Posts:** the first post of an author pays about 8M more for the `live` level of `ownerAndTime`; later posts cost the same (+0.3M).
- **Replies:** about 15M cheaper with new index values and 7M with known ones (the preallocated `byAuthorReply` counter is gone), net of the 32 B `rootOwnerId` (about 1M). The `where` checks compare documents consensus already fetches for the references.
- **Reply likes:** about half on the first like of a reply (one fewer counter to update).
- **Reports:** slightly cheaper to store (two indexes fewer), but the 50M action fee makes a report about 3.8¢ in all. A report's storage is priced for its 90-day lifetime.
- **Media:** each image adds about 10M (its URL, at the estimator's 256-character middle size, plus 41 B of digest and kind). An `ipfs://` link is about a quarter of that length, so the live cost is lower.
- A tombstone (a replace) is not priced by `documentCreateCost`. On v12 it was measured at about 0 for a 140-character post; dropping `live` also removes the post's `ownerAndTime` entry.

## Tooling

- **`scripts/register-lib.mjs`** `withInterim`: the interim each network registers an elected contract with (mainnet `notYetUsable`), or `--interim`.
- **`scripts/validate-contract-offline.mjs`**: `--network mainnet` validates the mainnet rendering, `--interim <kind>` another one, and `--cost` adds the per-write table above. Run for this cut:
  - `node scripts/validate-contract-offline.mjs contracts/yappr-social-contract-v13.json --network mainnet --cost --strict-size`
  - `node scripts/validate-contract-offline.mjs contracts/yappr-blocks-contract.json --network mainnet --cost --strict-size`
  - `node scripts/validate-contract-offline.mjs --probes` and `--constraints`
- **`scripts/contract-probes.mjs`** (`--probes`), v13 probes:
  - controls: v13 as committed, v13 as mainnet registers it (`notYetUsable`), the blocks contract, and "no block type left in social and nothing refers to one";
  - refused: v12's 3600 s windows on mainnet (10900), a 13-day cool-down (10900), the arithmetic `oneTarget` (`count` of an identifier), `length` on `mediaUrls`, `parentIsRoot` comparing a field with itself, a required `live`, and two malformed `where` entries (40126);
  - `live` read back off the parsed contract: `const: true` and frozen while not tombstoned;
  - update probes: swapping the interim later (40002), changing `ownerAndTime` (10217) or the `media` rule (10246) are refused; a larger `about` maximum and a new optional report property are accepted;
  - **`where` agreements**: no package checks a `where` offline (the node fetches the target and refuses with 40127), so `--probes` reads each reference's `where` off the parsed contract and judges hand-written documents against it: the forged top-level reply, the nested reply crossing threads, the wrong parent owner and a report naming the wrong author disagree (40127), while v12 still lets the first two through.
- **`scripts/property-constraint-cases.mjs`** (`--constraints`), 50 v13 cases, among them: the forged top-level reply (`parentIsRoot`), media length mismatches (`media`), tombstones keeping media, digests, text or a quote (`blankTombstone`), a live post without `live` and a tombstone still `live` (`live`), the three report targets and every pair of them (`oneTarget`), a box on a profile report (`boxOnContent`), reason 9 without a note. The runner now also checks that each file's declared rule names are exactly the ones `DECLARED_RULES` pins for the live batteries.
- **`scripts/register-feature-contract.mjs`** registers the blocks contract and social v13: it carries a file's `tokens`, `$formatVersion` and `version`, applies `withInterim` for `NETWORK`, takes `--interim`, and asks for a social contract id only when the file prices something in YAPP. Nothing was broadcast.

Not updated (follow-up, with the client): the live batteries and fee tools that write social documents (`verify-v10.mjs`, `prove-merged-counts.mjs`, `measure-social-fees.mjs`, the seeder) still build v12 shapes, so v13 cannot be proven or measured live yet.

## Client work for the follow-up PR

- **Topology `v13`** in `lib/contract-topology.ts` (`NEXT_PUBLIC_CONTRACT_TOPOLOGY=v13`): v12's descriptor plus everything below.
- **Blocks contract**: a new contract id setting (for example `NEXT_PUBLIC_YAPPR_BLOCKS_CONTRACT_ID`). Read and write `block`, `blockFilter` and `blockFollow` there. List a user's blocks on `ownerAndBlocked` (no time order any more). Rebuild `blockFilter` on unblock (decided in the audit).
- **Replies**: write `rootOwnerId` (the root post's `$ownerId`) on every reply. A top-level reply's `parentOwnerId` is the same identity. A nested reply's parent must be in the same thread (already the case).
- **Reply likes**: stop writing `replyAuthor`. Nothing reads the author counter on v12.
- **Reports**:
  - "my report of X" reads `byPost`/`byReply` (`postId ==` and `$ownerId ==`), or `byTarget` for a profile (`targetOwnerId ==`, `about == 1`, `$ownerId ==`); a target's reports read the same indexes without `$ownerId`;
  - the moderator queue reads `byStatus` (`byTime` is gone);
  - profile reports (`about: 1`, no post or reply id) from the profile screen;
  - reason 9's label;
  - the 50M action fee (3¢) in the report UI's cost;
  - for a private post or reply, build `box`: fetch the current team (the seated charter's leader and active members, or the interim moderator), wrap the post's `keyGeneration` CEK to each member's encryption key, and pack the wraps into ≤5,120 B. Define a versioned format, and the moderators' unwrap and read path.
- **Media**: write `mediaUrls`/`mediaDigests`/`mediaKinds` (up to 4 items; digest = sha256 ‖ fingerprint; kind 0/1/2), read them back, and ignore an unknown kind byte. A tombstone leaves out all three.
- **Live marker**: every new post sets `live: true`. A tombstone replace leaves `live` out. Author timelines, profile post counts and top creators query `ownerAndTime` with `live == true` first. The client-side tombstone filter there can go.
- **Moderation**: show the `notYetUsable` state on mainnet (posting, replying, reporting and the profile extension refused with 41200 until a team is seated). Show the 7-day join and 3-day vote windows in the election UI. Mention that a seat becomes contestable (30-day cool-down) once challenges ship.
- **Error copy**: map the renamed 10422 rules (`blankTombstone`, `parentIsRoot`, `media`, `live`, `oneTarget`, `boxOnContent`, `otherNote`…). Today only comments name the old ones.
- **Index renames**: `bookmark.ownerPost`/`ownerTime`, `follow.pair`, `followRequest.pair`, `privateFeedGrant.recipient`/`leaf`, `privateFeedRekey.generation`, wherever the client starts naming them.
- **Mobile** (`mobile/`): the same shapes when the native apps move to v13.
- **Tooling**: v13 document shapes in `verify-v10.mjs`, `prove-merged-counts.mjs`, `measure-social-fees.mjs` and the seeder, then a sakura registration, the batteries and a live fee measurement before mainnet.

## Open items

- **No live proof.** Everything here is offline: both parsers, the node-rule audit, the constraint oracle and the `where` model. The `where` refusals (40127) and the `live` const are consensus behaviour that a devnet battery should broadcast before mainnet.
- **Field size.** The audit recorded a 5,120 B per-field cap at write time; `box` sits exactly at it. Neither parser enforces such a cap offline (a `maxItems` of 16,000 parses), so the cap is from the audit, not re-verified here.
- **`requiresIdentityDecryptionBoundedKey`** (making identities carry a decryption key for this contract) was considered for the box during the audit and is not adopted: the box's recipients are the moderators, whose keys the client looks up.
- **Testnet's interim** is still undecided (`--interim` picks it at registration).
