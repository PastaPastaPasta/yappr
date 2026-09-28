# Contract cuts for Platform 4.2.0-beta.6

Moutai was wiped for 4.2.0-beta.6, so every Yappr contract is registered
again. This cut changes **social v9** and **blog** only. Every other file is
byte-identical to the beta.5 cut ([CONTRACTS_BETA5.md](CONTRACTS_BETA5.md)),
so the publisher can reuse those registrations. The SDK pin is on
`beta6/sdk`, and nothing here is deployed.

Sources, all read at tag `v4.2.0-beta.6` (`5298d209`) in the platform
checkout:

- `book/src/contract-keywords/property-constraints.md` (#5100, #5083, #5085,
  #5071, #5078, #5047, #5048, #5073, #5109, #5115)
- `book/src/contract-keywords/refers-to.md` (`propertyAgreement`, #5123)
- `book/src/contract-keywords/indexes.md`, `aggregates.md`, `index-only.md`
- `book/src/data-model/contract-moderation.md` (#5108)
- `packages/rs-dpp/schema/meta_schemas/document/v3/document-meta.json`
  (vendored at `scripts/meta-schema/`, sha256 `88083a21…589f`, the same bytes
  `beta6/sdk` vendors)
- `packages/rs-platform-version/src/version/system_limits/v4.rs`

It also folds in **#579** (the `report` type and its client, by
QuantumExplorer), cherry-picked with its author kept. #579 waited for a v9
registration because an elected declaration is fixed at creation, so `report`
could never join `moderatedDocumentTypes` through a contract update.

## Summary

| Contract | Change | Signed create (cap 20,480, budget 20,000) |
| --- | --- | ---: |
| social v9 | `report` type (#579); one-hour election windows; `tombstoneIsBlank` as `ifThen` + `length`; quote and nested-reply owner bindings; two countable tombstone indexes | **19,885 B** (was 18,291; 115 B under the budget) |
| blog v4 → topology `v5` | comments-off enforced (D-29); only a blog's owner posts to it | 6,501 B (was 6,282) |
| storefront, pollr, profile, DM v4/v5, key exchange, key backup, vault, auth vault | none | byte-identical |

### sha256 of each file the publisher pins

```
311911b610d39a8ad4145fe49116a819621ef7a3f4e2631203c3831130d16b7e  yappr-social-contract-v9.json   (changed)
1f9f34cea3ccdf584a67b630c0dadb13c459edaedcd9184cd75c10272b4be351  yappr-blog-contract.json        (changed)
fb533f474e70f96e04cb82fbddcbb0dbe46eafb5a5cd5adcfca608e4559f3329  yappr-storefront-contract.json
e107f561b58dd98a1f6cb3fe29dfc6e973c6dc13c45bfeea35195d632bce76ac  pollr-contract.json
1db3372d50f42ce404cc1861ef22dfce2fb545f10044358f20dd4c35df8edc5d  yappr-profile-contract.json
7a86b1d2c9ccb15ceb62605c49d1375365e5b530698ab987d90c21eed5b59139  yappr-dm-contract.json
82c03a3c9e2fa747ebc98d3d4375fa394080f0b649c2c678847f74389b6796f3  yappr-dm-contract-v5.json
8b73b1c9569cf02291e894999ceedd2af87ea69c67fd5390a377298ba69089e4  key-exchange-v2.json
db55419ae977311d5bcf087ec0396157272ee2234b81823da94cd2deb47330f7  encrypted-key-backup-contract.json
cbfe0181be53d58d0db76d28e36a3746f74b08b30c91e59a6797213073386fc5  yappr-vault-contract.json
5378686fbb93d398131667da9b7deb6acb0c8e51fa6c465d7ce77fdba7f8b2a7  yappr-auth-vault-contract.json
```

The nine unchanged hashes equal the beta.5 pins. As on beta.5, key backup, key
exchange, vault and auth vault are published from the testnet snapshot
(`source-contracts.json`), not from these files.

## Adopted

### Social v9

| # | Change | Why | Δ signed |
| --- | --- | --- | ---: |
| 1 | The `report` doctype and `moderatedDocumentTypes.report = ["deleteDocuments"]` (#579) | Readers report a post or reply, and the moderators dismiss reports by deleting them. The design is in [the report type](#the-report-type) below | +1,507 |
| 2 | `joinWindow` and `voteWindow` go from 86,400 to **3,600** | #5108 keeps the one-day floor on mainnet only, and every other network takes 0. With one hour each, a contested election re-test runs in about two hours. A window of 0 would resolve in a block or two, leaving no time to file a second applicant or cast votes. `seatContestable: false` needs no cool-down | −4 |
| 3 | `tombstoneIsBlank` (post, reply) becomes `ifThen[deleted = 1, allOf[length(content) = 0, absent mediaUrl, absent encryptedContent]]` | The meaning is unchanged: `length` reads an absent `content` as 0, which replaces beta.5's `absent ∨ ""` pair. It saves bytes for 1 and 5 | −62 |
| 4 | `post.quotedPostId` and `post.quotedReplyId` agree `quotedPostOwnerId ← $ownerId`. `reply.replyToReplyId` agrees `parentOwnerId ← $ownerId` | Before this, the "quotes of my posts" and "replies to me" notification keys could name anyone. Every writer already sends the target's author (below) | +146 |
| 5 | Countable `post.quoteDeletedCount [quotedPostId, deleted]` and `reply.rootDeletedCount [rootPostId, deleted]` | **QA D-44**: quote and reply counts include tombstones. A count with `deleted == true` gives the tombstoned bucket, so live = total − tombstoned, in one extra grouped count. The write shape does not change; the client read change is a follow-up | +179 |
| — | Post and reply descriptions shortened to one line | Room for the above | −67 |

Post and reply now carry 10 of the 10 indexes a type may have.

### Blog (topology `v5`)

| Change | Why |
| --- | --- |
| `blogComment.postCommentsEnabled` (boolean) is bound by the `blogPostId` agreement to the post's `commentsEnabled`. The rule `commentsOpen: notEqual[ifAbsent(postCommentsEnabled, 1), 0]` refuses `false` | **QA D-29**: comments-off was enforced only in the UI. A rule cannot read the referenced post, so the agreement copies the flag into the comment, and the rule judges the copy. Both absent agree, so a post that never stored the flag (on by default) takes comments without it. A comment that lies about the flag (true, or left out, on a post that stores `false`) is refused 40127, and the honest `false` is refused 10422 |
| `blogPost.blogId` agrees `$ownerId ← $ownerId` (a writer gate) | Before this, anyone could create a `blogPost` naming someone else's blog. The reader filtered it out by owner, but the `blogAndSlug` unique index could be **squatted** by a stranger. The app composes only under the signed-in user's own blogs (`MyBlogsList` → `ComposePost`), and the seeder and batteries post under their own blogs |

The comment write shape changes, so blog moves to topology **`v5`**
(`NEXT_PUBLIC_BLOG_TOPOLOGY=v5`). Only `v5` sends `postCommentsEnabled`:

- a `v4` or `v1` build never sends the field (the testnet contract has no such
  property);
- `blogCommentService.createComment` reads the post, which it already did for
  the owner, and copies its flag. It refuses before paying when the flag is
  `false`, or when the post cannot be read, since guessing would be refused
  for every post that stores the flag.

## The `report` type

The beta.5 v9 published on 2026-09-28 (`HCAoKyuA…`) has no `report` type, and a
contract update cannot add it: the elected declaration is fixed at creation, so
`report` could never join `moderatedDocumentTypes`, and a seated team would get
41201 on every dismissal.

The type was written in #579 by QuantumExplorer against the beta.5 file and
folded into this cut. Its size and pin are part of the v9 figures above.

Readers report a post or reply to the moderators; the moderators remove it,
act on its author, or dismiss the reports. Yappr has no backend, so a report is
a document, and it lives in social v9 because that is where the moderators and
the reported types are. A separate contract would add a registration and an
env var, would have to be re-registered with every social cut (its references
name the social contract's id), and the social contract's moderators could not
delete its documents.

```json
"report": {
  "properties": {
    "postId":        { identifier, "refersTo": { "type": "deletableDocument", "documentType": "post",  "propertyAgreement": { "targetOwnerId": "$ownerId" } } },
    "replyId":       { identifier, "refersTo": { "type": "deletableDocument", "documentType": "reply", "propertyAgreement": { "targetOwnerId": "$ownerId" } } },
    "targetOwnerId": { identifier, "distinctFrom": "$ownerId" },
    "reason":        { "type": "integer", "minimum": 0, "maximum": 8 },
    "note":          { "type": "string", "minLength": 1, "maxLength": 500 }
  },
  "required": ["$createdAt", "targetOwnerId", "reason"],
  "indices": ["ownerAndPost (unique): $ownerId, postId", "ownerAndReply (unique): $ownerId, replyId",
              "byPost: postId", "byReply: replyId", "byTime: $createdAt"],
  "documentsMutable": false, "canBeDeletedByModerators": true,
  "propertyConstraints": { "oneTarget": …, "otherHasNote": … }
}
```

and `config.moderation.moderators.moderatedDocumentTypes.report` is
`["deleteDocuments"]`.

| Rule | What consensus refuses | Code |
| --- | --- | --- |
| `oneTarget` | a report naming both a post and a reply, or neither | 10422 |
| `otherHasNote` | reason 8 ("something else") without a note | 10422 |
| `refersTo` | a report of a post or reply that does not exist (a removed one included) | 40120 |
| `propertyAgreement` | `targetOwnerId` other than the target's author, so the queue can name the author even after the target is removed | 40127 |
| `distinctFrom` | reporting your own post or reply | 10419 |
| unique `ownerAndPost` / `ownerAndReply` | a second report of the same target by the same reporter. A unique index skips a document whose property is absent, so a reply report never collides on the post index. | 40105 |

The reason codes are frozen with the contract: 0 spam or scam, 1 harassment,
2 hate, 3 violence or threats, 4 sexual content, 5 self-harm, 6 illegal goods
or activity, 7 impersonation, 8 something else (`lib/reports.ts`, pinned
against this file by `lib/reports.test.ts`).

**Withdrawing and dismissing.** A report is immutable. Its reporter withdraws
it by deleting it (`canBeDeleted` is the contract default) and gets the storage
refund. The moderators dismiss it by deleting it as moderators, for the whole
team. That is why `report` is moderator-deletable and moderated for
`deleteDocuments` alone:

- every dismissal is its own moderation transition and leaves a removal record
  forever; the client cites the reported post in the record's
  `reason.documents`;
- a seated elected team must cite a charter reason for each one (41203), as for
  any deletion, so its charter needs a reason that fits a dismissal;
- the reporter gets no refund;
- a report filed by an identity the network protects from moderation cannot be
  dismissed (41102): whoever may moderate right now (the interim owner, or the
  seated leader and members) and, once a team is seated, the `ownerProtected`
  owner. The client offers moderators no Report item, withdraws a moderator's
  own reports when it dismisses (a withdrawal is the reporter's own delete),
  and leaves the rest for their authors to withdraw;
- the unique entry goes with the report, so the reporter may report the same
  post again after a dismissal.

Removing the reported post does not delete its reports. The queue shows them
as handled, once the removal record confirms the post is gone, and offers to
clear them, which costs the same per report. Before it dismisses, the queue
reads every report on the post again: reports withdrawn or dismissed meanwhile
drop out, and new ones are shown for review instead of being dismissed unseen.

**Privacy.** Reports are public: anyone can read who reported what, and why.
Encrypting them to the moderators is not possible while the team can change at
every election. The dialog says so before a report is filed.

**Queries.** `ownerAndPost`/`ownerAndReply` answer "have I reported this?".
`byTime` feeds the moderators' queue, newest first. `byPost`/`byReply` list
every report on one target when the moderators dismiss them. No index is
countable: the queue counts the reports it has read.

**Size.** The type adds 1,507 B signed. To fit, `byPost`/`byReply` carry no
`$createdAt` (the queue sorts client-side), and the type description is short.

## Rejected or deferred

| Candidate | Status and reason |
| --- | --- |
| QA D-36: refuse a poll ballot after `endsAt` | **Not expressible.** `vote`/`multiVote` are indexOnly, and an indexOnly type may not declare a rule that reads a system time. A rule also cannot read the referenced poll's `endsAt`. It stays a client fix (branch `fix/qa-f10-polls-tips` labels a closed-poll tally final only when it was read by close time) |
| poll `endsAt > $createdAt` (beta.5 "Rejected") | Now expressible (`$createdAt` is required on poll), but **still rejected**: the pollr seeder writes closed polls with a past `endsAt` on purpose (`flaky` −4, `pineapple` −11 and `survey-sins` −2 days). Pollr stays byte-identical |
| Embed vs quote exclusivity (beta.5 "Rejected") | Still rejected for the same reason as on beta.5: only `compose-modal` enforces it, and a blog-quote embed on an encrypted post is a real write. The grammar was never the blocker |
| D-14: no reply, quote or repost of a tombstone (the `*Deleted` copies through agreements) | **Deferred.** It is expressible with the same copy pattern as D-29, but every quote, reply and repost writer and the tombstone helper must carry the target's `deleted`, and a later replace must restate it. That is a client change of its own, larger than this cut |
| D-25: `storeOrder.storeStatus` copy, and `storeIsOpen` | **Deferred** with D-14, for the same reason (the checkout must copy `store.status`). Storefront stays byte-identical |
| `storeOrder.sellerId distinctFrom $ownerId` (no self-orders) | Rejected: verify-storefront s19a deliberately self-orders to prove the review `distinctFrom` |
| `countOf` caps (one store per owner, ballots per poll, posts per owner) | One store per owner is already the unique `store.owner` index, and `countOf` refuses a unique index anyway. Ballots are indexOnly, which `countOf` cannot count. `post.byOwner` is ranked, which `countOf` refuses. No product limit calls for a new countable index |
| Tombstone counts for `quotedReplyId` and `replyToReplyId` | They do not fit: post and reply are at 10/10 indexes |
| DM `bodyContiguous` | Keep DM unchanged (decided): no TTL and no re-cut |

### Other beta.6 changes, checked

- **#5123** (a preallocated agreement source must fit a tree key): social has no
  `preallocated` index. The only ones are pollr `vote.byPoll`/`byPollOwner`,
  keyed through `pollOwnerId ← poll.$ownerId` (32 B). Every file registers
  unchanged.
- **#5101** (empty objects read as absent; `$defs`): Yappr has no object
  properties and no `$defs`.
- **#5069 / #5074** (keyword changes on update refused): every cut here is a
  fresh registration.
- **#5076** (generation-3 parse refusals become paid consensus errors): this
  affects only a contract that fails to parse, and none does.
- **#5115** (no own-type totals on contested types): Yappr declares no `countOf`
  or `sumOf`.
- **#5112** (consensus codes reach JS): the battery matchers read the prose OR
  the `code=` that `describeErr` now carries. The client's code route is
  `beta6/sdk`'s (`consensusCodeOf`).

## Write paths checked against the new rules

| Rule | Writers | Holds because |
| --- | --- | --- |
| `quotedPostOwnerId ← $ownerId` | `resolveQuoteReference` (`quotingPost.author.id`, the author of the post or reply being quoted); `postService.createPost`; `run-seeder.mjs` quote (`quoted.ownerId`); verify-v8 m3 and verify-v9 fixtures (B's post, B's id) | Every writer names the author of the quoted document. The tombstone helper preserves `quotedPostOwnerId` and the reference verbatim. When the target has been removed, the reference is cleared, and a missing reference checks no agreement |
| `parentOwnerId ← $ownerId` on `replyToReplyId` | `publishThread` (`replyingTo.author.id` for the clicked target, the author's own id for their follow-up parts, which chain to the author's own replies); `run-seeder.mjs` (`parent.ownerId`, and `replyToReplyId` only when the parent is a reply); verify-v9 (direct replies only) | A direct reply carries no `replyToReplyId`, so it is not bound. A nested reply always names its parent's author |
| `tombstoneIsBlank` (rewritten) | `tombstoneDocument` writes `content: ''`, `deleted: true`, and drops media and ciphertext | Same meaning as beta.5 |
| blog `postCommentsEnabled` / `commentsOpen` | `blogCommentService.createComment` (v5); `seed/non-social/blog.mjs` (v5: `true`, since every seeded post stores the flag and only comments-on posts get comments); verify-blog fixtures (posts leave the flag out, so comments leave it out) | Covered by `blog-comment-service.test.ts` for all four topology and flag shapes |
| blog `blogId` owner gate | `ComposePost` under `MyBlogsList` (the owner's blogs only); `seed/non-social/blog.mjs` (`post.owner` is `blog.owner`); verify-blog (author on the author's blog) | No writer posts to another identity's blog |
| `report` | `reportService` (#579), with `targetOwnerId` taken from the target's author | Pinned by `lib/reports.test.ts` and the r1 cases |

## Validation and battery cases

```
node scripts/validate-contract-offline.mjs contracts/yappr-social-contract-v9.json --strict-size   # 19,885 B
node scripts/validate-contract-offline.mjs contracts/yappr-blog-contract.json --strict-size        # 6,501 B
node scripts/validate-contract-offline.mjs --probes        # 49 probes
node scripts/validate-contract-offline.mjs --constraints   # 53 cases, rs-dpp 4.2.0-beta.6 validation
node scripts/verify-{v9,blog,storefront,pollr}.mjs --self-test
```

- **`--network`** (new): the audit's election-window floor is 0 by default
  (devnet/testnet) and one day with `--network mainnet`. Social v9 as cut fails
  `--network mainnet` on purpose, because a mainnet registration must restore
  86,400.
- **Probes** changed for #5108:
  - "3600 s window" moves to a mainnet-only probe;
  - a 0 s control is added (accepted off mainnet);
  - a window over four weeks is added (refused everywhere);
  - the `tombstoneIsBlank` probe follows the `ifThen` path.
- **`--constraints`** now runs on the wasm-sdk alone: it evaluates each case
  with `DataContract.checkDocumentPropertyConstraints` (platform#5051), the
  rule check consensus runs, so the optional `@dashevo/wasm-dpp` install is
  gone. #579's six `report` cases run for the first time, with four new cases:
  - a tombstone that leaves `content` out (accepted);
  - three `blogComment` flag shapes (absent and `true` accepted, `false` refused
    `commentsOpen`).

  Removing `commentsOpen` or `otherHasNote` turns its refusal into a FAIL
  (checked).

### New live cases

| Battery | Case | Covers |
| --- | --- | --- |
| verify-v9 | o4 | A quote of B's post, or of B's reply, naming A as the owner is refused 40127; the reply quote naming B lands. A reply to B's reply naming A is refused 40127; naming B, it lands |
| verify-v9 | t1 | A quotes and replies to a fresh post of B's twice each, then tombstones one of each. Total counts read 2, and the `deleted == true` counts read 1 (`quoteDeletedCount`, `rootDeletedCount`) |
| verify-v9 | e0 | (existing) now pins 3600/3600 against the published declaration |
| verify-v9 | r1 | (#579) Reports: two creates land; the duplicate (40105), wrong author (40127), self-report (10419), ghost post (40120) and three constraint refusals are refused; the reporter withdraws one; the interim owner dismisses the other; the reporter reports again |
| verify-v9 | r2 | **Post-seat, for the publisher.** Once a team is seated (about two hours with one-hour windows), run `verify-v9 --only r2 --team-member bot:<n> --reason-doc <id>`. A member dismissing A's report without a listed reason is refused 41203, and with one it lands. The member's own report, and the `ownerProtected` owner's report, cannot be dismissed (41102). The case skips while no team is seated |
| verify-blog | b20 | Comments-off: a comment copying `true` lands; leaving the flag out on a `true` post is 40127; on a `false` post, the honest `false` is 10422 `commentsOpen`, and `true` or absent is 40127 |
| verify-blog | b21 | A stranger posting to the author's blog is refused 40127 |

## Notes for the publisher

- **Register social v9 and blog from these files**, and reuse the nine
  byte-identical registrations.
- **Set `NEXT_PUBLIC_BLOG_TOPOLOGY=v5`** in the devnet deploy that points at
  the new blog contract. A `v4` build against it cannot comment on any post
  that stores `commentsEnabled`.
- **Elections:** v9 declares 3600 s join and vote windows, which are
  devnet-only. A mainnet registration must restore at least 86,400.
- **Seeder:** run the blog seeder with `NEXT_PUBLIC_BLOG_TOPOLOGY=v5`. The
  social seeder needs no change, since its quotes and nested replies already
  name the real owners.
- **Report dismissals by a seated team** must cite a charter reason (41203). The
  E1 charter needs a reason that fits "dismiss a report" (for example, "report
  reviewed: no violation"). Reports filed by protected identities (the interim
  owner, the seated team, or the `ownerProtected` owner) cannot be dismissed
  (41102); their authors withdraw them.
- **Run after registration:**
  - `verify-v9 --only e0,o4,t1,c1,r1`
  - after the election seats a team: `verify-v9 --only r2 --team-member bot:<n> --reason-doc <id>`
  - `verify-blog --only b3,b19,b20,b21`
  - the usual full batteries

  A refusal scores only on its prose (or `code=`) and, for 10422, only when it
  names the exact rule.
