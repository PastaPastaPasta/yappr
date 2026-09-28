# Contract cuts for Platform 4.2.0-beta.5

Moutai was wiped for 4.2.0-beta.5, so every Yappr contract is registered fresh.
This document records which of the beta.5 grammar each contract adopts. The
SDK pin is on `beta5/sdk` (#576). Nothing here is deployed.

Sources, all read at tag `v4.2.0-beta.5` (`5c79d12d`) in the platform
checkout:

- `book/src/data-model/document-ttl.md`
- `book/src/data-model/documents.md` (Property Constraints)
- `packages/rs-dpp/schema/meta_schemas/document/v3/document-meta.json`
- `packages/rs-dpp/src/data_contract/document_type/property_constraints/mod.rs`
  (`node_count`)
- `packages/rs-platform-version/src/version/system_limits/v4.rs`
- `packages/app-connect-contract/schema/v1/app-connect-contract-documents.json`

## Summary

**Versioning.** Every file is edited in place under its canonical name, as
the beta.2 non-social cuts were, and no topology label moves (social `v9`,
storefront `v4`, blog `v4`, pollr `v4`, profile `v2`, DM `v4`/`v5`). The
reason is that nothing a client writes changes shape: each new rule only
refuses a document that no Yappr write path produces (see the audit below). A
client that targets beta.4 therefore behaves identically against these cuts.
The `report` type below is not part of this cut: it waits for the
[next v9 registration](#next-v9-registration-the-report-type).

| Contract | beta.5 grammar adopted | Signed create (cap 20,480) | Change |
| --- | --- | ---: | --- |
| social v9 | 9 `propertyConstraints` rules on `post`/`reply` | 18,291 B (was 16,972) | edited |
| storefront v4 | 3 rules on `storeItem`/`shippingZone` | 14,588 B (was 14,285) | edited |
| pollr v4 | 1 rule on `poll` | 6,028 B (was 5,625) | edited |
| blog v4 | 1 rule on `blogPost` | 6,282 B (was 6,138) | edited |
| profile v2 | none | 1,624 B | byte-identical |
| DM v4, DM v5 | none (**no TTL**, by decision) | 2,738 B, 3,674 B | byte-identical |
| key exchange v2 | none (TTL rejected, see below) | 1,459 B | byte-identical |
| key backup, vault, auth vault | none | 1,002 B, 710 B, 2,215 B | byte-identical |

The remaining files (`yappr-social-contract-v2.json`, `yappr-block-contract.json`,
`yappr-hashtag-contract.json`, `yappr-mention-contract.json`, `yappr-minimal.json`)
are testnet or legacy records that are never published to moutai; they are
unchanged.

Every social cut is still measured with `--strict-size`, and v9 has 1,709 B
of headroom under the 20,000-byte budget.

### sha256 of each file the publisher pins

```
a20635e492da83da7434d08a038ac1879566af4531265d8eb35ea0f9d2b2c29c  yappr-social-contract-v9.json
1db3372d50f42ce404cc1861ef22dfce2fb545f10044358f20dd4c35df8edc5d  yappr-profile-contract.json
db55419ae977311d5bcf087ec0396157272ee2234b81823da94cd2deb47330f7  encrypted-key-backup-contract.json
8b73b1c9569cf02291e894999ceedd2af87ea69c67fd5390a377298ba69089e4  key-exchange-v2.json
cbfe0181be53d58d0db76d28e36a3746f74b08b30c91e59a6797213073386fc5  yappr-vault-contract.json
5378686fbb93d398131667da9b7deb6acb0c8e51fa6c465d7ce77fdba7f8b2a7  yappr-auth-vault-contract.json
fb533f474e70f96e04cb82fbddcbb0dbe46eafb5a5cd5adcfca608e4559f3329  yappr-storefront-contract.json
6532779168b8c376288e9007bd809fbb21c311b935b2b8ba047f498e9a458590  yappr-blog-contract.json
7a86b1d2c9ccb15ceb62605c49d1375365e5b530698ab987d90c21eed5b59139  yappr-dm-contract.json
82c03a3c9e2fa747ebc98d3d4375fa394080f0b649c2c678847f74389b6796f3  yappr-dm-contract-v5.json
e107f561b58dd98a1f6cb3fe29dfc6e973c6dc13c45bfeea35195d632bce76ac  pollr-contract.json
```

The seven unchanged hashes equal the beta.4 publisher's pins. Key backup, key
exchange, vault and auth vault were published from the **testnet snapshot**
(`source-contracts.json`) on beta.4, not from these files; see
[notes for the publisher](#notes-for-the-publisher).

## Document TTL (#5007, #5033)

**Adopted nowhere.** A `ttl` deletes the document for every owner once it
expires, so it fits only data that is useless after a known interval and that
no other document needs to reference.

### key-exchange `loginKeyResponse`: rejected

This looked like the best candidate: a wallet's encrypted login response, which
the app reads once. It does not fit this contract, for three reasons.

1. **The document is the wallet's key-index record, not only a message.** Every
   wallet that implements the protocol **replaces** the one document per
   `(ownerId, contractId)`; none creates a second one:
   - `YAPPR_DET_SIGNER_SPEC.md` §7.3 and §10.5;
   - dash-evo-tool `feat/yappr-key-exchange-v2`, `key_exchange.rs`
     (`document_replace` on the existing document);
   - dash-wallet (Android) `PlatformDashConnectRepository.kt:256`
     ("REPLACE it ($revision + 1) rather than blindly create").

   The wallet also reads the stored `keyIndex` back to choose the index for the
   next login (`auto_detect_key_index`; spec §12.2 treats it as the anti-rollback
   floor: `requested < existing` is rejected). A TTL would delete that floor.
   Losing it silently resets rotation to index 0.
2. **A replace cannot move the expiry.** `$createdAt` never changes, so
   `$createdAt + ttl` is fixed at the first login. Every later replace pays
   storage only for the lifetime left. Once that lifetime passes, the replace is
   refused with 40140 (`DocumentExpiredError`), and until the cleanup runs, the
   `byOwnerAndContract` unique index still holds the value, so a fresh create is
   refused as a duplicate. With a one-day TTL, a user who logged in yesterday
   could not log in today until the cleanup block ran. The wallets would need
   new "delete, wait for the cleanup, then create" logic, which no wallet has.
3. **The replacement already exists.** The platform's **App Connect** system
   contract (`H8F9mP1BM55TE1ShsxPZHzhyinaMdY9bMmP85mkDhcJJ`, protocol 14, the
   same id on every network) carries this exact flow:
   - its `loginKeyResponse` is `indexOnly`, immutable and deletable, keyed
     `(appEphemeralPubKeyHash, $ownerId)`;
   - on re-login the wallet deletes its old response **by values** and creates
     a new one;
   - it declares **no `ttl` at beta.5**. It could not: TTL is refused on
     indexOnly types.

   Building a TTL scheme on a contract that App Connect supersedes is wasted
   work. A 2026-09-18 indexOnly re-cut of key-exchange was also measured at
   +42% credits per response and dropped (`NON_SOCIAL_CONTRACTS.md` §13).

**Recommendation (not implemented here):** move the Yappr login to App Connect
(`H8F9…`) once the wallets ship it, and retire `key-exchange-v2.json` then.
The two protocols differ in three ways that matter:

- the payload grows from 60 bytes to 60–572;
- there is no `contractId` or `keyIndex` property, so the key-index history
  moves into the wallet;
- the app's query changes from `(contractId, hash)` to `byRequest` on
  `(appEphemeralPubKeyHash)` with the `$ownerId` terminal.

That is a client and wallet migration, so it is out of scope for a contract
re-cut. Until it happens, `key-exchange-v2.json` is republished unchanged, and
login flows behave exactly as on beta.4.

### Other doctypes swept

| Doctype | Why not |
| --- | --- |
| DM `directMessage` / `dmMessage` / `readReceipt` / `dmSelfState` | **Decided: no TTL.** The platform will make TTL user-configurable later. The client sweep and retention setting stay. |
| social `followRequest` | A live request is the target of `privateFeedGrant.recipientId` (a deletable lookup). Expiring a request that is still pending would withdraw a user's ask without their action. |
| storefront `savedAddress` | A user's address book: not ephemeral. |
| storefront `orderStatusUpdate`, `storeOrder` | Order history; `storeOrder` is a `permanentDocument` target. |
| blog `blogFollow` | Already windowed by its `followersByDay` index `ttl`, which expires index entries and not documents. |
| social `beat`, `like`, `likeReply`, pollr `vote`/`multiVote` | `indexOnly`, where TTL is refused. |
| auth vault, vault, key backup | Key material, never ephemeral. |

## propertyConstraints (#5036–#5042)

### Adopted

Each rule encodes an invariant that every existing write path already
satisfies. The rules close gaps a hand-built transition could exploit: a
half-encrypted post the client renders as broken, an embed the client cannot
resolve, a poll with a hole in its options. Node counts use rs-dpp's
`node_count` (limit 32 per rule, 16 rules per type).

| Doctype | Rule | Meaning | Nodes |
| --- | --- | --- | ---: |
| post, reply | `privateAllOrNone` | `encryptedContent`, `epoch` and `nonce` are all present or all absent | 9 |
| post, reply | `privateHasNoMedia` | Not both `encryptedContent` and `mediaUrl`: the client refuses to create that combination (`post-service.ts:443`, `reply-service.ts:247`), because a public URL would leak the private post's media | 4 |
| post, reply | `tombstoneIsBlank` | `deleted` true ⇒ `content` is `''` or absent, and `mediaUrl` and `encryptedContent` are absent. `deleted` false or absent is not judged, so the 40128 (`immutable`) refusal of a revert is unchanged | 12 |
| post | `embedAllOrNone` | `embedContractId`, `embedDocType` and `embedId` are all present or all absent | 9 |
| post | `oneQuoteTarget` | Not both `quotedPostId` and `quotedReplyId` | 4 |
| post | `quoteNamesOwner` | A quote (`quotedPostId` or `quotedReplyId`) carries `quotedPostOwnerId`, which the "quotes of my posts" notification index is keyed by | 5 |
| storeItem | `pricedHasCurrency` | `basePrice` or `variants` ⇒ `currency` | 5 |
| shippingZone | `flatRateHasCurrency` | `flatRate` ⇒ `currency` | 3 |
| shippingZone | `tieredHasTiers` | `rateType` not `flat` ⇒ `tiers` present (the enum-constant form) | 5 |
| poll | `optionsContiguous` | `optionN` ⇒ `option(N-1)` for N = 3..9. The reader stops at the first gap (`pollr-poll-service.ts`), so options after a gap were silently unreachable, and ballots for them were uncountable | 22 |
| blogPost | `chunksContiguous` | `data2` ⇒ `data1` and `data3` ⇒ `data2`. `joinChunks` stops at the first gap, so the content was silently truncated | 7 |

`quoteNamesOwner` deliberately runs one way only. A tombstone whose dead
quote reference was cleared (`tombstone-helpers.ts`; verify-v8 m3f) keeps
`quotedPostOwnerId` without a quote target, and a rule running in both
directions would refuse that replace.

### Rejected, with the path that would break

| Candidate | Rejected because |
| --- | --- |
| `orderStatusUpdate` shipped ⇒ `trackingNumber` | The seller form makes tracking optional (`status-update-form.tsx`), and battery s4f ships without it. It also runs the other way: the form keeps a typed tracking number when the status changes (`app/orders/seller/page.tsx`), so tracking can accompany `delivered`. |
| `shippingZone` flat ⇒ `flatRate`; flat ⇒ no `tiers`; tiered ⇒ no `flatRate` | A free-shipping zone omits `flatRate` (`shipping-zone-modal.tsx`: `baseRate \|\| undefined`), and flat zones carry a pricing config in `tiers`. Tiered zones may carry a base rate (`calculateRate` reads it). |
| `storeItem` variants ⇒ no `basePrice`/`stockQuantity`; price or variants required | The inventory upload writes both `basePrice` and `variants` (`inventory-parser.ts`). An edit merges the old fields back in. Unpriced items exist. |
| `storeItem` stock 0 ⇔ `sold_out` | The inventory table sets stock 0 and leaves the item `active`. |
| `poll.endsAt > $createdAt` | System fields cannot be operands. The seeder also writes closed polls with a past `endsAt` on purpose. |
| `poll.multiChoice` never false | True of every writer, but the contract description allows `false` and the reader treats it as absent. A rule would add nothing the reader relies on. |
| post: non-empty `content` unless deleted | verify-v9 f3a blanks `content` without deleting, and the seeder corpus allows `""`. |
| post: an embed excludes a quote, or ciphertext | Only the compose UI enforces this (`compose-modal.tsx`); `createPost` itself does not. A blog-quote embed on an encrypted post is a real write. |
| reply linkage rules | `rootPostId`/`parentOwnerId` are required already; `replyToReplyId` is legitimately optional and clearable. |
| blog `publishedAt` / DM / profile | There is no co-occurrence invariant to encode. `publishedAt` is already write-once through `immutableAllowSetting`. |

### Room

Social v9 grows by 1,319 B, to 18,291 B signed, which is still 1,709 B under
the 20,000-byte budget. Every rule fits with room to spare (the largest is 22
of 32 nodes, and post carries 6 of 16 rules), so nothing had to be dropped.

## Next v9 registration: the `report` type

**Not in the v9 published on 2026-09-28** (`HCAoKyuA…`, from the file at sha256
`a20635e4…` above). The repo's v9 file carries it for the next registration
of v9, which gets a new contract id: an update cannot add it, because an
elected declaration is fixed at creation in every field, so `report` could
never join `moderatedDocumentTypes` and a seated team could never dismiss a
report (41201). Until that registration, the client must not ship against
`HCAoKyuA…`: it would offer reports the contract cannot take.

| | Published v9 | With `report` |
| --- | ---: | ---: |
| Signed create | 18,291 B | 19,798 B (202 B under the budget) |
| sha256 | `a20635e4…c29c` | `590e1e5d…a8d1` (superseded: the beta.6 re-cut folds `report` in, see [CONTRACTS_BETA6.md](CONTRACTS_BETA6.md)) |

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

## Other beta.5 changes, checked

- **#4983** (`immutableAllowSetting` on a deletableDocument reference): the only
  settable properties are `post.deleted`, `reply.deleted` and
  `blogPost.publishedAt`, and none of them is a reference.
- **#4982** (a contract reference with an `owner` requirement on a transferable
  type): no Yappr type is transferable or tradeable.
- **#4984** (a `$creatorId` key reference): Yappr has none.
- **#4995 / #5039** (contested documents before epoch 4; `contestFund`): this
  needs no contract change. Social v9's elected moderation is kept exactly as
  declared (interim `contractOwner`), and the election test is now unblocked.
- **YAPP token**: unchanged (non-transferable, non-purchasable).

## Validation and battery cases

```
node scripts/validate-contract-offline.mjs contracts/yappr-social-contract-v9.json --strict-size
node scripts/validate-contract-offline.mjs contracts/<each file above>
node scripts/validate-contract-offline.mjs --probes        # 48 probes (5 new for these rules)
node scripts/validate-contract-offline.mjs --constraints   # 49 accept/refuse cases, rs-dpp validation
node scripts/verify-{v9,storefront,pollr,blog}.mjs --self-test
```

- **`--constraints`** runs every case in `scripts/property-constraint-cases.mjs`
  through `ExtendedDocument.validate` from `@dashevo/wasm-dpp`. That is
  `DataContract::validate_document`, the check the node runs on a create or
  replace. It asserts the code (10422) and the rule the message names. The
  wasm-sdk the app ships has no document validator, so wasm-dpp is an optional
  install and not a dependency: `npm install --no-save <the SDK's wasm-dpp
  tarball>`. Without it, the run is skipped with a notice. Removing a rule
  turns its refusal cases into FAILs (checked).
- **Probes** added to `contract-probes.mjs`. All five are refused by the local
  parse:
  - a rule reading a missing property;
  - an enum constant outside the enum;
  - a string property used as an integer operand;
  - a 17th rule;
  - a 34-node rule.
- **Live cases**, which broadcast the refused creates of the same table and
  expect 10422 naming the rule:

  | Battery | Case | Covers |
  | --- | --- | --- |
  | verify-v9 | c1 | 8 post/reply create refusals, then a tombstone replace keeping `mediaUrl` (refused) and the same tombstone without it (lands) |
  | verify-v9 | r1 | (next v9 registration) reports: a post and a reply report land; a duplicate (40105), a wrong author (40127), a self-report (10419), a ghost post (40120) and the 3 `report` constraint refusals are refused; the reporter withdraws one; the interim owner dismisses the other, and the reporter may report again |
  | verify-storefront | s20 | 4 item/zone refusals under the seller's real store |
  | verify-pollr | p12 | 2 gapped polls |
  | verify-blog | b19 | 2 gapped posts under the fixture blog |

  The accepted side of each rule is the fixtures the existing cases already
  write. A live refusal counts only as 10422 naming the exact rule. The self-tests pin each contract's rule names (`DECLARED_RULES`).
- **Seeders.** Every storeItem (48), shippingZone (15), poll (14) and blogPost
  (46, edits included) the non-social seeders write passes rs-dpp validation
  under these cuts, checked with the same oracle. The social seeder writes
  plain posts, quotes that carry their owner, and replies, and never writes
  ciphertext or `deleted`.

## Notes for the publisher

- **Pin the sha256 values above.** The DM, profile, key backup, key exchange,
  vault and auth vault files did not change.
- **Key backup, key exchange, vault and auth vault.** The beta.4 run published
  these from the testnet snapshot (`source-contracts.json`), not from the repo
  files. That snapshot's key-exchange payload is `minItems 1 / maxItems 4096`,
  where the repo file has 60/60. Keep doing the same: nothing in beta.5 changes
  those four.
  - The repo copies of key backup, vault and auth vault use the pre-v1 `mutable`
    keyword, so they fail the meta-schema check and must not be published from
    file.
  - The snapshot schemas pass full validation under beta.5 (checked: 991, 1,461,
    659 and 2,220 B signed).
- **No login-flow change.** Key exchange is republished with the same schema,
  so the wallet create/replace flow and the app's `(contractId, hash)` poll work
  exactly as on beta.4.
- **No seeder change** is needed: every seeder shape satisfies the new rules.
- **Run the live cases after registration:**
  `verify-v9 --only c1`, `verify-storefront --only s20`, `verify-pollr --only p12`
  and `verify-blog --only b19`, alongside the usual batteries (and
  `verify-v9 --only r1` once v9 is registered with `report`). Each case runs
  alone: c1, s20 and b19 create or reuse their own fixture (anchor post,
  seller store, blog) when their fixture case has not run. A refusal scores only
  if it is 10422 AND the message names that exact rule. c1's refused creates
  carry the post action fee, so the refusal is the rule and not the fee.
  A refused create costs its sender a basic-validation fee only.
