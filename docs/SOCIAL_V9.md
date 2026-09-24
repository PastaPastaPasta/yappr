# Social v9, blog v4, storefront v4, profile v2 — the 4.2.0-beta.4 cuts

Platform 4.2.0-beta.4 (protocol version 14) adds grammar that no live Yappr
contract can gain through `dataContractUpdate`: elected moderation, a warning
list, `distinctFrom`, `ownerRefersTo`, lookups through a unique index, and
typed scalar arrays. Moderation and list declarations are fixed when a
contract is created, and an update cannot add a keyword to an existing
document type. So every cut here is a fresh registration.

This document covers the contract-design half of the beta.4 "PR B". The SDK
pin is on `beta4/sdk`. The client switch-over comes later and is listed in the
[client TODO](#client-todo). Nothing here is deployed, and `.env.devnet` is
unchanged.

References, all read at tag `v4.2.0-beta.4` (`6c95cd8b`) in the platform
checkout:

- `rs-dpp/schema/meta_schemas/document/v3/document-meta.json`
- `rs-dpp/src/data_contract/config/moderation/{mod,elected}.rs`
- `rs-dpp/src/data_contract/document_type/class_methods/try_from_schema/v3/mod.rs`
- `book/src/data-model/contract-moderation.md`
- `docs/protocol/moderation-charters.md`
- `rs-platform-version/src/version/system_limits/v4.rs`

## Grammar and where it is verified

| Feature | Platform PR | Keyword | Offline check | Battery case |
| --- | --- | --- | --- | --- |
| Elected moderation | #4886 #4969 #4914 | `config.moderation.moderators {$type: "elected", …}` | build-v9 self-test; probes (windows, abilities, seat) | v9 e0, m1, m2, w1 (interim); election script (later) |
| Warning list | #4872 | `config.moderation.warnings: true` | build-v9; battery self-tests | v9 w1; blog b17; storefront s17 |
| distinctFrom | #4917 | `distinctFrom: "$ownerId"` on an identifier, or on typed-array `items` | wasm parse; probes | v9 d1, p1i, b1b; storefront s19 |
| Writer lookup gate | #4941 | `ownerRefersTo {permanentDocument, lookup}` | wasm parse (`documentTypeReferences` shows `$ownerId`) | v9 p1a, p1b, p1j |
| Deletable lookup | #4930 | `refersTo {deletableDocument, lookup}` | wasm parse; immutability probes | v9 p1d–p1h |
| Typed scalar arrays | #4922 #4923 #4928 #4924 | `type: array` + `items` + `maxItems` | wasm parse; serialization round-trip | v9 b1; blog b18; storefront s18 |

Consensus codes the client and batteries match on:

| Code | Meaning |
| --- | --- |
| 10419 | `DocumentPropertyNotDistinctError`: "property X must differ from $ownerId" |
| 10421 | `maxBytes` exceeded (a typed string element) |
| 10101 | JSON schema: a typed array over `maxItems`, a duplicate under `uniqueItems`, an element over `maxLength` or failing its `pattern` |
| 40120 | Referenced entity not found. The path names `$ownerId` for a writer gate and `recipientId` for the request gate. |
| 41117 | Clearing warnings from an identity that has none |
| 41118 | Warning limit reached (16 per identity) |
| 41119–41122 | Restore errors: no removal record / restore window elapsed / hash mismatch / already restored |
| 41200–41203 | Elected moderation: moderated type not yet usable / ability not granted / added-moderator cap reached / reason not listed |
| 41101 | The interim moderators are refused once a charter is seated |

## Social v9 (`contracts/yappr-social-contract-v9.json`)

The file is built from v8 by `scripts/build-v9-contract.py`. Its
`--self-test` asserts that the committed JSON matches a fresh build and pins
every decision below. The read surface is unchanged from v8: every index,
terminal, ranked axis, `timeRange` window, token cost, action fee and the
starter grant. So the client read path, the v8 write path (fee agreements and
the choice of YAPP or credits) and `verify-v8.mjs` all carry over as they are.

### Exact diff against v8

1. **Elected moderation.** The config stays at `$formatVersion: "2"`. The
   moderation block becomes:

   ```json
   "moderation": {
     "banlist": true, "suspensions": true, "warnings": true,
     "moderators": {
       "$type": "elected", "joinWindow": 86400, "voteWindow": 86400,
       "seatContestable": false, "maxAddedModerators": 10,
       "moderatedDocumentTypes": {
         "post":  ["deleteDocuments", "ban", "suspend", "warn"],
         "reply": ["deleteDocuments", "ban", "suspend", "warn"]
       },
       "interim": { "$type": "contractOwner" }, "ownerProtected": true
     }
   }
   ```

   The key names and values are rs-dpp's (`elected.rs` `property_names`,
   `ModerationAbility` in camelCase), and they read back unchanged from the
   parsed contract.
   - **The abilities and the interim form match the brief exactly.** The
     interim can be `contractOwner`, `appointedModerators`, `notYetUsable` or
     `noModeration`.
   - **No `electionDelay`.** The key is optional and unbounded. When it is
     left out, the first `electedCharter` can be filed as soon as the contract
     exists. The charter contract's `targetContractId` reads that through
     `contractRequirements: {moderation: "electionOpen"}`. A delay would only
     postpone when a team can open the contest.
   - **One-day windows**, the protocol minimum (`SystemLimits`: 86400 to
     2419200 s). A second applicant extends the contest to join + vote.
   - **`seatContestable: false`** means no `challengeCoolDown` is declared.
     Declaring one while the seat is not contestable fails to parse.
     Challenges ship after protocol 14 anyway, but this key is frozen now.
   - **`maxAddedModerators: 10`**, within the brief's 5–15 range. Each
     addition must come from the proposal's join requests, and removing one
     frees its slot.
   - **`ownerProtected: true`**: the seated team cannot ban, suspend or delete
     from the owner. The team always holds the moderators pot.
   - **Consequences for the owner.** While no charter is seated, the owner
     moderates exactly as on v8, with the same authority and protection, and
     is the only claimant of the moderators pot. Once a charter is seated:
     - the owner is refused with 41101;
     - the pot moves to the seated team;
     - every team ban, suspension, warning or deletion must name a `reason`
       document that its proposal lists (41203). The interim is never bound
       by that rule.
   - **`--moderators` is refused** for an elected cut
     (`register-lib.mjs withModerators`). Swapping in an appointed set would
     publish a moderation model nobody reviewed, and it could never be
     changed back (40002).
2. **Warnings.** `warnings: true`. A warning bars nothing. It is a readable
   record (a reason, which may cite up to 16 documents) that accumulates up to
   16 per identity until it is cleared.
3. **`distinctFrom: "$ownerId"`** on `follow.followingId`, `block.blockedId`,
   `followRequest.targetId` and `privateFeedGrant.recipientId`.
   `like.postAuthor` and `repost.postOwnerId` are deliberately left alone so
   that self-likes and self-reposts stay possible.
4. **Private-feed gates.**
   - `privateFeedGrant.ownerRefersTo` and `privateFeedRekey.ownerRefersTo` are
     `{type: permanentDocument, documentType: privateFeedState, lookup: {index:
     owner, keys: {$ownerId: "."}}}`. Only an identity that has a
     `privateFeedState` can grant or rekey. `privateFeedState` is already
     `canBeDeleted: false` and `documentsMutable: false`, and is unique on
     `$ownerId`. That makes it a valid permanent lookup target: nothing can
     move its key.
   - `privateFeedGrant.recipientId.refersTo` is `{type: deletableDocument,
     documentType: followRequest, lookup: {index: targetAndRequester, keys:
     {targetId: "$ownerId", $ownerId: "."}}}`. The grant's writer must be the
     request's `targetId`, and the recipient must be the request's owner.
     - `followRequest` already lists `targetId` as `immutable`, which a lookup
       key requires (tested: without it the contract is refused).
     - A deletable lookup cannot sit under an `immutable` list, but grants are
       `documentsMutable: false` (never replaced), so nothing re-validates the
       reference after creation. Removing the request later strands nothing.
   - `preallocated` is not involved: no index on these types preallocates.
5. **`blockFollow.followedBlockers`** changes from packed bytes (one byteArray
   of up to 3200 bytes, ids laid end to end) to a typed array:
   - `minItems: 1`, `maxItems: 100` (today's `MAX_BLOCK_FOLLOWS`) and
     `uniqueItems`;
   - each item is an identifier with `refersTo: {type: identity}` and
     `distinctFrom: "$ownerId"`;
   - 100 references fit within the budget of 256 per document.

6. **Every property `description` is dropped** (doctype descriptions stay).
   A contract create is one state transition, capped at
   `max_state_transition_size` = 20,480 bytes: rs-dapi refuses a larger
   broadcast, and Drive decodes it as 10602. v8 was already 20,207 bytes
   unsigned, and items 1–5 bring v9 to 20,900, which is over the cap. Property
   descriptions are 3,083 bytes of annotation that nothing reads. Without them
   v9 is **16,872 bytes unsigned, about 16,972 signed**, under the 20,000-byte
   headroom budget.

Every other doctype property, index, immutable list, token, cost, fee and
grant is byte-identical to v8.

### Checked and ruled out

- **`canBeDeletedByModerators` on a contested type.** No v9 type has a
  contested index, so the rule (a restore cannot go through a vote) does not
  apply. A negative probe confirms the parser refuses the combination.
- **More typed arrays in social.** Typed arrays cannot be indexed, so
  `postHashtag` and `postMention` stay doctypes. `blockFilter.filterData` is a
  bloom filter, genuinely bytes, and stays a byteArray.
- **Out of scope by instruction:** `maxBytes` on post content,
  `encryptedFor`, merging `quotedPostId` with `quotedReplyId`, and tips
  (PR #567's doctypes are not included).

### Private-feed flow analysis

The gate stops the grants that no Yappr flow writes. It does not stop the ones
the flows do write. Every path that writes or deletes a grant or rekey:

| Flow | Code | Request exists at grant time? | Under the v9 gate |
| --- | --- | --- | --- |
| Approve a request | `components/settings/private-feed-follow-requests.tsx:127` → `privateFeedService.approveFollower` (`lib/services/private-feed-service.ts:329`, create at :481) | **Yes, when the list was read.** The approve list comes from on-chain requests (`getFollowRequestsForOwner`, `private-feed-follower-service.ts:201`), and approval deletes nothing. **Race:** a follower who cancels (`cancelRequest`, `private-feed-follower-service.ts:160`) between the owner's list read and the grant makes the grant fail with 40120 on `recipientId`, after the owner's client has done the ECIES work. | Allowed; the race is refused (correctly: nobody asked any more). Client TODO 13. |
| Stale-request cleanup after approval | `cleanupStaleFollowRequest` (`private-feed-follower-service.ts:850`), run from `getAccessStatus` (:808) and `recoverFollowerKeys` (:766) | The follower deletes the request only after a grant exists. | Grant is unaffected: it is never replaced, so the deletable lookup is never re-validated |
| Revoke | `revokeFollower` (`private-feed-service.ts:523`): creates a rekey (:753), deletes the grant (:779) | — | The rekey passes the owner gate. The delete is ungated. |
| Block → auto-revoke | `blockService.blockUser` (`lib/services/block-service.ts:121`) → `autoRevokePrivateFeedAccess` (:177) → `revokeFollower` (:200) when the blocked user holds a grant | — | Same as revoke: a rekey by the owner (gated on the owner's own `privateFeedState`, which exists since there is a grant) and a grant delete |
| Re-approve after a revoke | The follower re-requests (`requestAccess`, `private-feed-follower-service.ts:91`; it refuses only while a grant or request exists), then the owner approves as above | **Yes**, the new request | Allowed |
| Feed reset | `resetPrivateFeed` (`private-feed-service.ts:915`): deletes every grant (:953) and rekey (:993), replaces `privateFeedState` (:1064) | Followers must re-request ("PRD §9.2", cited at `private-feed-service.ts:906`; the PRD is not in the repo) | Allowed, but **see the blocker below** |
| Owner-initiated grant to an existing follower | none: no code path | — | Would be refused (40120). This is the intended behaviour. |
| Re-issuing grants on rekey | none: a rekey is one `privateFeedRekey` document, and grants are not reissued | — | — |
| `docs/YAPPR_PRIVATE_FEED_SPEC.md` §8.7 ("issue a fresh PrivateFeedGrant" after a missing rekey document) and §13.2 (tree capacity upgrade: new grants to every follower) | Spec text only, never implemented | Not necessarily | Would need each follower to have a live request, i.e. to ask again first. Noted for the spec. |

**Verdict: the gate fits every implemented flow, and I kept it at full
strength.**

**Pre-existing conflict, which v9 did not introduce:**

- `resetPrivateFeed` replaces `privateFeedState` through
  `stateTransitionService.updateDocument` (`private-feed-service.ts:1064`).
  That type has been `documentsMutable: false` since v2, so Drive refuses the
  replace on every live cut, and a reset fails after it has already deleted
  every grant and rekey.
- `ownerRefersTo permanentDocument` requires the state to stay permanent.
  Making it mutable would still satisfy the lookup rules, because `$ownerId`
  never moves.
- Two options, for the user to choose:
  - **(a)** Make `privateFeedState` `documentsMutable: true` with `immutable:
    ["treeCapacity", "maxEpoch"]`, so a reset can rotate `encryptedSeed`.
  - **(b)** Keep the state immutable and have the client refuse or hide
    "reset" (for example, "create a new identity for a fresh feed").
- I left the v8 declaration unchanged and flag it here rather than choosing.

## Blog v4, storefront v4, profile v2 (in place)

Precedent: the beta.3 cut edited `yappr-blog-contract.json` and
`yappr-storefront-contract.json` in place under their canonical file names,
and recorded the cut label in the topology env (`BLOG_TOPOLOGY=v3`,
`STOREFRONT_TOPOLOGY=v3`). These cuts do the same.

**The labels are bumped** (blog v4, storefront v4, profile v2), because the
write encoding changes. A v3 client writing `labels: "a,b"` to a v4 contract
is refused, and so is a v4 client writing a list to v3. `blogIsV2()` and
`storefrontIsV2()` stay true, but the client needs a new predicate per
contract to choose the encoding. Profile has no topology gate today, so it
needs its first one.

| Contract | Change |
| --- | --- |
| blog v4 | `config.moderation.warnings: true`. `blog.labels` becomes a typed array of ≤64 strings; `blogPost.labels` ≤16 strings; each 1–40 chars, ≤160 bytes, unique. |
| storefront v4 | `warnings: true`. `storeItem.tags` ≤32 strings (1–64 chars, ≤128 bytes, unique). `storeItem.imageUrls` ≤8 strings (≤512, `^(https?\|ipfs)://.+$`, unique). `storeReview.sellerId` `distinctFrom: "$ownerId"`. |
| profile v2 | `paymentUris` ≤16 strings (3–512, `^[A-Za-z][A-Za-z0-9+.-]*:.+$`, unique). `socialLinks` ≤16 strings in the form `"<platform>:<handle>"` (3–256, `^[a-z]{1,16}:.+$`, unique). |

- **`storeReview.sellerId`.** The order's writer gate already makes the
  reviewer the buyer. `distinctFrom` additionally refuses a seller who ordered
  from their own store and then rates it.
- **`itemReview`** carries no seller field, so there is nothing to mark
  distinct.
- **DM v4 is not touched.** DM v5 supersedes it for new conversations
  (`feat/dm-v5`), and v4 is not being republished for beta.4. The client
  already stops self-messaging (`app/messages/page.tsx:209`).

### Deliberately left as strings

- `store.paymentUris` (an array of `{scheme, uri, label?}` objects)
- `store.contactMethods` (`SocialLink[]` or a legacy object)
- `storeItem.variants` (a nested object)
- `shippingZone.tiers` (a nested object)

Typed arrays hold scalars only, so objects would need a lossy re-encoding.
`shippingZone.postalPatterns` is a scalar list, but nothing in the UI or the
seeders writes it. Converting it is a cheap follow-up if wanted.

## Typed-array encoding migration

Wire shape (probed with beta.4 wasm, `verify-v9 --self-test`):

- Write a plain JS array: strings, or 32-byte `Uint8Array`s / base58 strings
  for identifiers.
- `Document.toJSON()` reads it back as an array. Identifier elements come back
  as base58 strings; `toObject()` gives `Uint8Array`s.
- The old string or packed encodings are refused on serialization ("a typed
  array value must be a list").
- An empty list is allowed where `minItems` is absent. On `blockFollow`
  (`minItems: 1`) the client already deletes the document when the list
  empties (`block-service.ts:580`).

| Field | Today: write (file:line) | Today: read (file:line) | v9/v4 write | Old readers kept for |
| --- | --- | --- | --- | --- |
| social `blockFollow.followedBlockers` | `encodeUserIdArray` packs 32 × n bytes (`lib/services/block-service.ts:484`; callers :524, :541, :602) | `decodeUserIdArray` slices 32-byte chunks (`block-service.ts:470`; from :456) | `string[]` of base58 ids (or `Uint8Array[]`), 1–100, unique, never the owner | v2–v8 (`!blockFollowsAreTyped()`) |
| profile `paymentUris` | `JSON.stringify(string[])` (`lib/services/unified-profile-service.ts:468`; create :714, update :780) | `parsePaymentUris` → `JSON.parse` + scheme whitelist (`unified-profile-service.ts:446`) | `string[]` of URIs, ≤16. The whitelist stays client-side. | profile v1 (testnet/prod) |
| profile `socialLinks` | `JSON.stringify(SocialLink[])` (`unified-profile-service.ts:484`) | `parseSocialLinks` → `JSON.parse` (`unified-profile-service.ts:477`) | `string[]` of `"platform:handle"`, ≤16. Split on the FIRST `:` (a Mastodon handle contains `@host`, not `:`). | profile v1 |
| blog `blog.labels` | CSV passthrough (`lib/services/blog-service.ts:97/:103`; built at `components/blog/blog-settings.tsx:61` and `components/blog/compose-post.tsx:278`) | raw string (`blog-service.ts:85`) → `parseLabels` (`lib/blog/content-utils.ts:92`) | `string[]`, ≤64 × 40 chars. Omit the field when empty. | blog v1–v3 |
| blog `blogPost.labels` | CSV, **`''` always written** (`compose-post.tsx:241` → `lib/services/blog-post-service.ts:139/:162`) | raw string (`blog-post-service.ts:105`); substring search (:265) | `string[]`, ≤16. Omit when empty (`[]` is also valid). Search by element. | blog v1–v3 |
| storefront `storeItem.tags` | `JSON.stringify(string[])` (`lib/services/store-item-service.ts:190/:242`; CSV import `lib/upload/inventory-parser.ts:643`) | `parseJsonArray` (`store-item-service.ts:40`, `lib/utils/json-parsing.ts:10`; it already accepts a parsed array) | `string[]`, ≤32 × 64 chars | storefront v1–v3 |
| storefront `storeItem.imageUrls` | `JSON.stringify(string[])` (`store-item-service.ts:191/:243`; UI caps at 4, `app/store/item/add/page.tsx:363`) | `parseJsonArray` (`store-item-service.ts:41`) | `string[]`, ≤8, http(s) or ipfs | storefront v1–v3 |

Old readers, as they behave today when handed a v4 list:

- storefront `parseJsonArray` (`lib/utils/json-parsing.ts:10`) already passes
  an array through: **no read change needed**.
- profile `parseJsonSafe` (`unified-profile-service.ts:542`) calls
  `JSON.parse` on the array, which coerces it to `"a,b"` and throws, so it
  silently returns `[]`. **Must change.**
- blog `parseLabels` (`content-utils.ts:92`) calls `value.split`, which
  **throws** a TypeError on an array. **Must change.**
- block `decodeUserIdArray` (`block-service.ts:470`) runs `normalizeBytes`
  over a list of ids, whose result is not the packed bytes: expect garbage or
  `[]`. **Must change.**

Every one of these must accept both shapes (a list, or a string or packed
bytes as today), because testnet and production keep the old cuts. Writers
switch on the topology predicate.

## Client TODO

None of this is done here. File:line refers to `origin/staging` at `2cb7fdbe`, re-checked on this branch.

**Topology plumbing**

1. `lib/constants.ts`: add `BLOG_TOPOLOGIES` `'v4'` (:125) and
   `STOREFRONT_TOPOLOGIES` `'v4'` (:93), plus predicates (`blogLabelsAreTyped`,
   `storefrontArraysAreTyped`), and a first `NEXT_PUBLIC_PROFILE_TOPOLOGY`
   gate. `CONTRACT_TOPOLOGIES` already ends in `'v9'`.
2. `scripts/seed/seed-lib.mjs:117`: append `'v9'` to `TOPOLOGIES` and
   `HASHTAG_MAX` (v9 = 61), so the seeders accept `--topology v9`.
3. `.env.devnet`: change the ids and topology in the deploy PR, never here.

**Moderation** (`lib/services/moderation-service.ts`, `components/settings/contract-moderation-settings.tsx`)

4. `getTeam` (:127) reads only `appointedModerators`. For `elected`, read the
   interim (`electedModeration().interim`). Once
   `sdk.moderationCharters.seatedCharter(contractId)` returns a charter,
   `isModerator` (:140) must use `sdk.moderationCharters.team(contractId)`
   instead. The owner stops being a moderator after seating (41101), and the
   moderator menu items must follow.
5. `getStanding` (:172) and `listEntries` (:189) hard-code
   `['banlist','suspensions']`. Use `moderationLists()` and add `'warnings'`.
6. Add `warnUser` and `clearUserWarnings` wrappers, a warnings panel (count
   per identity, reasons, cited documents), and a banner that shows the viewer
   their own warnings.
7. Add restore: `sdk.contracts.moderatorRestoreDocument` with the document
   fetched **before** deletion. The client must keep it, because the hash has
   to match (41121) and the window is 7 days (41120). The removal records
   already carry `documentHash`, `restoredBy` and `restoredAt`.
8. A seated team must put a `reasonDocumentId` on every
   ban/suspend/warn/delete (41203). The moderator modals need a reason picker
   fed from the seated proposal's `reasons`.
9. `lib/error-utils.ts`: add classifiers for 10419 (not distinct), 41117,
   41118, 41119–41122, 41200–41203, and 41101 after seating ("the elected
   team moderates now"). Add them to `isPermanentProtocol14Error` (:459).
10. The pot claim: after seating the interim claim is refused (41113). Hide
    the owner's claim button once a charter is seated.

**distinctFrom**

11. `lib/services/follow-service.ts:33` `followUser` has no self-guard. Add
    one (v9 refuses it with 10419; earlier cuts accept it).
    `block-service.ts:127` and `:500` already guard. `requestAccess`
    (`private-feed-follower-service.ts:91`) should refuse `ownerId === myId`.
12. The storefront review UI should hide "review" on an order where
    `sellerId === viewer`.

**Private feed**

13. `approveFollower` (`private-feed-service.ts:329`, create at :481), on
    v9 (`privateFeedWritesAreGated()`):
    - re-read the request (`getFollowRequest`) BEFORE the ECIES work, and
      stop with "the follower withdrew their request" when it is gone;
    - map a 40120 whose path is `recipientId` to the same message (the race
      the re-read cannot close), and one on `$ownerId` to "enable your private
      feed first";
    - on success, `private-feed-follow-requests.tsx:134` already drops the
      row. On the withdrawn case it should drop it too, with that message.
14. `enablePrivateFeed` must succeed before any rekey or grant (40120 on
    `$ownerId`). The UI already orders it this way.
15. Decide on the `resetPrivateFeed` blocker (option a or b above).

**Typed arrays**: see the migration table. Writers switch on the predicate,
and readers accept both shapes:

16. `block-service.ts:470/:484` — the typed list on v9 (`blockFollowsAreTyped()`).
17. `unified-profile-service.ts:446/:468/:477/:484` plus `app/user/page.tsx:167/:301`.
    Socials become `"platform:handle"` strings; `types/user.ts` keeps
    `SocialLink` as the parsed form.
18. `blog-service.ts:85/:97/:103`, `blog-post-service.ts:105/:139/:162/:265`,
    `compose-post.tsx:241`, `blog-settings.tsx:61`, `content-utils.ts:92/:97`.
19. `store-item-service.ts:190/:191/:242/:243`; `inventory-parser.ts:722`
    passes arrays already.
20. **Latent bug, found here:** `BaseDocumentService.update()`
    (`lib/services/document-service.ts:309`, merge at :326–327) builds the
    replace from `get()`, which returns the TRANSFORMED document, and
    `store-item-service`/`shipping-zone-service` do not override
    `extractContentFields` the way blog does (`blog-service.ts:61`). So any
    field the caller leaves out is re-sent parsed:
    - an item stock edit (`components/store/inventory-table.tsx:263`) re-sends
      `tags`/`imageUrls` as arrays and `variants` as an object;
    - a zone edit (`app/store/manage/page.tsx:232`) re-sends `postalPatterns`
      as an array and `tiers` as an object.

    On v1–v3 the replace fails to encode, because every one of those is a
    string there. On v4, `tags`/`imageUrls` happen to be right, but
    `variants`, `tiers` and `postalPatterns` are still strings, so the replace
    still fails. Fix it on every cut: override `extractContentFields` to
    re-encode each field the way the topology stores it.
21. Seeders: `scripts/seed/non-social/blog.mjs:156` (CSV label literals,
    LIMITS :28), `storefront.mjs:297/:298` (`JSON.stringify`), and
    `seed-lib.mjs profileLimits` (:298), which reads `maxLength` off the
    profile fields and must read `items.maxLength` for arrays.

## Validation

```
python3 scripts/build-v9-contract.py --self-test
node scripts/validate-contract-offline.mjs contracts/yappr-social-contract-v9.json
node scripts/validate-contract-offline.mjs contracts/yappr-blog-contract.json
node scripts/validate-contract-offline.mjs contracts/yappr-storefront-contract.json
node scripts/validate-contract-offline.mjs contracts/yappr-profile-contract.json
node scripts/validate-contract-offline.mjs --probes
node scripts/verify-v9.mjs --self-test
node scripts/verify-blog.mjs --self-test
node scripts/verify-storefront.mjs --self-test
node scripts/register-social-v3-draft.mjs --dry-run --contract-file yappr-social-contract-v9.json
NETWORK=devnet node scripts/register-feature-contract.mjs --file yappr-blog-contract.json --dry-run
```

**Size and meta-schema gates.** `validate-contract-offline.mjs` measures the
create transition of every file (`DataContractCreateTransition.toBytes()` plus
100 B for the signature):

- A file over the 20,480-byte cap FAILS.
- A file over the 20,000-byte headroom budget warns. With `--strict-size`,
  which `build-v9-contract.py --self-test` passes for v9, it fails.
- It validates every doctype with ajv against rs-dpp's document meta-schema
  v3, vendored at `scripts/meta-schema/document-meta-v3.json` and pinned by
  sha256. When ajv is not installed (it is only a transitive dependency),
  the check is skipped with a notice.

Measured sizes (signed estimate):

| Cut | Signed estimate |
| --- | --- |
| social v8 | ~20,307 B (warns; published as-is on beta.3) |
| social v9 | ~16,972 B |
| storefront v4 | ~14,285 B |
| blog v4 | ~6,138 B |
| profile v2 | ~1,624 B |

**What the beta.4 wasm parse does not check** (measured):

- The JSON meta-schema: an unknown keyword parses.
- The 20,480-byte state transition cap.
- `ContractModerationConfig::validate` (10900): a 3600 s election window
  parses locally.
- `max_typed_array_items` and `max_references_per_document`.
- The deletability of reference targets (40122/40131).
- A deletable lookup held under `immutable`.

The node checks all of these. `scripts/contract-probes.mjs`
(`auditNodeRules`) re-implements the ones these cuts depend on from the rs-dpp
source, and `validate-contract-offline.mjs` runs it on every file. `--probes`
runs 28 probes and records which layer refuses each one: 13 are refused by
the local parse, 12 only by the node (audited here, including the meta-schema
and the transition size), and 3 are controls that must pass.

Live, on a beta.4 devnet, after registration:

```
NETWORK=devnet node scripts/register-social-v3-draft.mjs --maker --contract-file yappr-social-contract-v9.json --fund <botA,botB>
NETWORK=devnet node scripts/verify-v9.mjs --contract <id>
NETWORK=devnet node scripts/verify-v8.mjs --contract <id>      # v8's fees/costs/grant still hold on v9
NETWORK=devnet node scripts/verify-blog.mjs --contract <id> --moderator <ownerPersona>
NETWORK=devnet node scripts/verify-storefront.mjs --contract <id> --moderator <ownerPersona>
```

The election itself is a separate script (`ELECTION_HOOKS` in
`verify-v9.mjs`). It spans at least one day of join window plus a day of
voting, and every interim case in `verify-v9` skips once a charter is seated.
