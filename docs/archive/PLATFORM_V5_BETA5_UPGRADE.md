# Platform 5.0.0-beta.5: the SDK bump, the contract re-cuts, and what they change for Yappr

Beta.5 (tagged 2026-10-12) follows [PLATFORM_V5_BETA4_UPGRADE.md](PLATFORM_V5_BETA4_UPGRADE.md). The protocol version stays **14**. Several of its changes alter PV14 behaviour, so every validator must swap images together; the platform team expects an in-place upgrade of sakura.

| PR | What |
| --- | --- |
| `chore/sdk-5.0.0-beta.5` (this one) | `@dashevo/evo-sdk`, `wasm-sdk` and `wasm-dpp2` 5.0.0-beta.5 in lockstep (with `package-lock.json` and the mobile `licenses.json` regenerated); the beta.5 document meta-schema v3 vendored (sha256 `d8676bfd…`); error copy for 40148 and 40149; this record. No contract or topology change. **Merge at the sakura beta.5 cut-over, not before** (see the next section). |
| `feat/beta5-recuts` (#729) | pollr v7, storefront v8, blog v8 and social v15's mentions and report rule, their clients, batteries and tooling ([The contract re-cuts](#the-contract-re-cuts) below) |

## SDK compatibility with sakura (beta.3 nodes)

The beta.4 SDK read beta.3 nodes. The beta.5 SDK does not read them fully. Measured read-only against sakura on 2026-10-12, with the same probe run once on a clean install of 5.0.0-beta.4 (control, 19 of 19 pass) and once on 5.0.0-beta.5:

| Read | beta.5 SDK on a pre-beta.5 node |
| --- | --- |
| connect, `epoch.current` (proved), `contracts.fetch` (social v14, pollr v6, blog v7, storefront v7) | works |
| DPNS `domain` query on a string index | works |
| `$ownerId` / `$createdAt` range queries on `post`, `follow`, `poll`, `blogPost` (unsigned-integer range, with and without an identifier prefix) | works |
| `identities.fetch`, `identities.byPublicKeyHash` (unique key) | works |
| Document query with an **equality on an unsigned-integer index key** (`vote` where `pollId == p and choice == 0`) | **fails**: `grovedb: invalid proof: V1 proof contains extra lower layer for key 80 not required by query` |
| Document **count** with the same equality | **silently returns nothing** (`[]` where beta.4 returns 1) |
| `identities.byNonUniquePublicKeyHash` | **fails**: `no proof in result` (beta.4: an empty list) |

The cut-over prep also saw the beta.5 SDK fail to connect to beta.3 nodes with a quorum-key-unavailable error, which these probes did not hit, so treat the table as the best case.

The cause is platform#5350 (unsigned-integer index values are now stored in numeric order, so a key encodes differently) and platform#5361 (the identity-by-public-key-hash request changed). A beta.4 SDK against beta.5 nodes breaks the same two paths from the other side, so **the SDK and the nodes move together**.

What this means in the app: a poll's choice tally and any other equality on an integer key, and the passkey and key-hash sign-in path that falls back to `byNonUniquePublicKeyHash` (`lib/services/identity-service.ts`), would break on `/devnet` while sakura runs beta.3 or beta.4. The count failure returns zeros instead of an error. Merge this PR when sakura's nodes report 5.0.0-beta.5, and cut `/devnet` over in the same window.

## What beta.5 changes for Yappr

### New where operators and constraint arguments

- `where` accepts `contains` and `containsAny` over a typed-array index (wasm-sdk `queries/document.rs`). `DocumentWhereOperator` in `@dashevo/wasm-sdk` already lists them, so `DocumentWhereClause` needs no change. The pollr v7 tally and the v15 "mentions of me" reads use them.
- `DataContract.checkDocumentPropertyConstraints(document, storedDocument)` takes the stored version as an optional second argument, for rules that read `$old.`. The offline scripts pass one argument, which still works for the rules they check. It does not judge `referenced` reads or `countOf`/`sumOf`.

### Error codes

| Code | Name | Where it appears | Copy |
| --- | --- | --- | --- |
| 40149 | `ReferencedDocumentPrecededError` | a commit-and-reveal create (`chooseFirst`) whose commitment another identity made first | "Someone else got there first, so this can't be completed." Permanent. Not a dead target, so it is excluded from `isReferenceNotFoundError`, whose "referenced ... for path" phrasing it shares |
| 40148 | `ReferencedDocumentRuleReadInvalidError` | contract registration or update, when a `propertyConstraints` rule reads a field through a reference that the referenced type cannot give | "This isn't available on this network right now. Try again later." Permanent. A contract-authoring error a running client should not meet |

Both are in `isPermanentProtocol14Error`, so a post or write is never retried on them. Neither is raised by a contract Yappr ships today.

### Meta-schema

`scripts/meta-schema/document-meta-v3.json` is the file at the `v5.0.0-beta.5` tag, byte for byte; `scripts/contract-probes.mjs` pins its sha256. The grammar adds:

- the `referenced` operand and `$old.` / `$revision` paths in `propertyConstraints` rules;
- the `referenceWhereCondition` forms (`const`, `notEqual`, `in`, ordering bounds) of a reference `where`;
- the `$ownerId` param of a `sys.hash` `findBy`, binding a commitment to its writer;
- `constraints` (`minimumAgeBlocks`, `chooseFirst`) beside `findBy`.

### Wasm size

The npm `wasm-sdk` 5.0.0-beta.5 wasm is about 26.38 MB. That is over Cloudflare Pages' 25 MiB asset limit if it is emitted; fix/wasm-sdk-dedupe (#728) stops emitting the asset, and this PR does not duplicate it.

## Upgrade run book

**In place:**

1. Get every sakura node onto beta.5 (`NETWORK=devnet node ops/status.mjs`: drive 5.0.0-beta.5, PV14, the height continuing).
2. Merge this PR and redeploy `/devnet` (`workflow_dispatch --ref staging`; a master-triggered deploy wipes `/devnet`).
3. Re-run the read batteries and the `/devnet` smoke on the beta.5 SDK, including a poll tally and a key-hash sign-in.
4. Then register the beta.5 re-cuts and the App Connect set. `scripts/register-app-connect-contracts.mjs` reads the Drive version from the status API and refuses to run against anything older than 5.0.0-beta.5.

**Wiped:** rebuild as in [PLATFORM_V5_BETA2_UPGRADE.md](PLATFORM_V5_BETA2_UPGRADE.md) and [SAKURA_BETA3_DEPLOY.md](SAKURA_BETA3_DEPLOY.md).

## The contract re-cuts

Sakura restarts from a beta.5 genesis, so every Yappr contract is registered fresh there by `scripts/register-app-connect-contracts.mjs` ([APP_CONNECT_CONTRACTS.md](../APP_CONNECT_CONTRACTS.md)). That lets four contracts be re-cut in place with the new grammar, with no compatibility shims.

### What beta.5 adds that the cuts use

| Feature | Platform PR | Used by |
| --- | --- | --- |
| `refersTo.where` conditions: `{ "const" }`, `{ "notEqual" }`, `{ "in" }` and orderings against the referenced document; a failed one is 40127 | #5369 | pollr (close time), storefront (open store), blog (comments on) |
| Rules reading the referenced document, `{ "referenced": [reference, field] }` | #5369 | pollr (option count, single choice) |
| Rules reading the stored version, `$old.` and `$revision` | #5373 | social report `staysResolved` |
| Indexes on the elements of a typed array, read with `contains` / `containsAny` | #5370, #5372 | pollr `choices`, social `mentionedUserIds` |
| Unsigned integer index keys in value order (plain big-endian bytes, no flipped top bit) | #5350 | every grouped count of a small unsigned integer (pollr choices, storefront ratings) |

### The cuts

Signed sizes are rs-dpp 5.0.0-beta.5's create transition with full validation (`b5val`), plus the repo's 100 B signature allowance, without the ~33 B group membership the publisher adds.

| File | Cut | sha256 | Signed | Before |
| --- | --- | --- | ---: | ---: |
| `pollr-contract.json` | pollr v7 (topology `v7`) | `4b660df8d095f931c9b422714ddb4ed7bcc629ab1ff5a9919d8df4079469b7d4` | 3,706 B | 4,173 B (v6) |
| `yappr-storefront-contract.json` | storefront v8 (`v8`) | `8f0feeebd2e8b1ac1cf415d93f47b606077118b192473938b39f7c324cd68ed8` | 16,316 B | 16,606 B (v7) |
| `yappr-blog-contract.json` | blog v8 (`v8`) | `79c8a4620cf1756cbc91dcb89d05fc902be74a703b24372f8cf93fe405c085a9` | 6,659 B | 6,756 B (v7) |
| `yappr-social-contract-v15.json` | social v15, re-cut in place (never registered) | `9b6c7eeda3194044040a9eb0822956f3dc81eaee99f0abea5f3e215b5762e078` | 16,458 B | 16,290 B |

All four pass `b5val` full validation, and are well under the 20,000 B budget.

#### Pollr v7: one ballot per voter

v6 kept one ballot per option for a multi-choice voter (`slot`, `choice`) and copied three poll fields into every ballot so a rule could read them. v7:

- **`vote`** holds `pollId` and an optional `choices` (distinct integers 0-9, 1 to 10 of them; absent = withdrawn, since an empty list is refused). `byPollVoter [pollId, $ownerId]` is unique: one ballot per voter per poll, created once and replaced after.
- **Close** is the reference's `where: { "endsAt": { "greaterThanOrEqual": "$updatedAt" } }`. An ordering bounded by `$updatedAt` is checked on every replace, so a create, a change or a withdrawal after the close is refused **40127** (v6: 10422 `writtenBeforeClose`). The client maps 40127 on a ballot write to "poll closed".
- **Rules read the poll** (`referenced`), so nothing is copied:
  - `choicesAreOptions` and `choicesAreOptionsHigh`: no element names an option the poll lacks. Elements are 0-9 and a poll has 2-10 options, so a bad element is one of `options.length + 0 … 7`; the two rules test `not contains` for offsets 0-3 and 4-7 (23 and 25 nodes; one rule would be 47, over the 32-node cap). Counting the elements against the options (variant A2's `count(choices) <= optionCount`) would let `[9]` through on a 3-option poll.
  - `singleChoice`: at most one element unless the poll is `multiChoice`.
- **`poll.optionCount` is gone** (and its `optionCountMatches` rule): it existed only for ballots to copy. A poll is `{ question, options, multiChoice, endsAt }`.
- **Tally**: `byPollChoice [pollId, choices]` is countable per element: a multi-choice ballot counts once under each choice. One grouped count, `choices containsAny [0..n-1]` grouped by `choices`, gives every option; `byPoll [pollId]` counts ballots, withdrawn ones too.
- **Unchanged product rules**, re-checked: ballots editable until the close and final after (the `where` above, and `canBeDeleted: false`); the owner may delete a poll only before its first ballot, withdrawn ones included (`deleteConstraints.noBallots`, counting `byPoll`); `endsAt` after creation and within 31 days.

The rule cases were also judged with rs-dpp 5.0.0-beta.5's own evaluator (`validate_referencing_property_constraints`) in a one-off harness: every accept and refuse in `property-constraint-cases.mjs` came out as recorded, at each boundary (an option equal to the count, the count + 4, 9 on a 9-option poll, 9 on a 10-option poll).

#### Storefront v8 and blog v8: conditions instead of copies

- **Storefront**: `storeOrder.storeStatus` (a copy of the store's status, bound by the reference and refused by `storeIsOpen` unless active) becomes `storeId.where.status: { "const": "active" }`. An order at a paused or closed store is 40127. The order carries one field less.
- **Blog**: `blogComment.postCommentsEnabled` (a copy of the post's flag, refused by `commentsOpen` when false) becomes `blogPostId.where.commentsEnabled: { "notEqual": { "const": false } }`. A post that leaves the flag out, or sets it true, takes comments; comments off, and a tombstone, is 40127.

Clients on v8 send neither copy and word a 40127 as "This store isn't taking orders right now" / "Comments are turned off for this post". v7 keeps working for `/devnet` until the cut-over.

#### Social v15: mentions and resolved reports

- **Multiple mentions** (product decision): post and reply carry `mentionedUserIds`, up to 8 identities (each `refersTo` identity), in place of the single `mentionedUserId`. `mentionedUserAndTime [mentionedUserIds, $createdAt]` enters a document once per mention, so "mentions of me" is `mentionedUserIds contains <me>`. A tombstone clears the list (`blankTombstone`) and the list is frozen unless deleted, as the single field was. +98 B. Hashtags stay single (`hashtag`, which trending and the likes bind to).
- **`staysResolved`** on `report`: `{ "ifThen": [{ "present": "$old.status" }, { "present": "status" }] }`. A moderator may change a resolved report's outcome or note, but never remove its status, which would reopen the reporter's withdrawal (`deleteConstraints.pending`). +70 B.

  The measured variant E made status final (`status == $old.status` once set). That conflicts with the app: status 1-3 are outcomes ("No action taken", "Content removed", "Author actioned"), and the report queue deliberately lets a moderator re-resolve (`resolutionFormStart`, `reportsNeedingResolution`; removing the reported post moves its reports to "Content removed"). The rule adopted keeps exactly the property that matters, that resolved stays resolved, and leaves the outcome editable.

### The client

- **Pollr** (`v7` replaces `v5`/`v6`; `v3` testnet and read-only `v4` unchanged): `pollrHasEditableBallots`, `planBallotWrite` (one create or replace per vote), `getMyBallot` off `byPollVoter`, the tally from one `containsAny` grouped count with a per-option `contains` fallback (`decodeChoiceKey` reads both key encodings), 40127 = closed, 40120 = gone, 40105/40106 = stale. A poll is written without `optionCount`. The card's flows are the same for the voter.
- **Storefront / blog v8**: no `storeStatus` / `postCommentsEnabled`; a 40127 naming the store's `status` is "This store isn't taking orders right now", a 40127 on a comment "Comments are turned off for this post". Rating group keys are read in both encodings.
- **Mentions (v15)**: `inlineMentions()` describes the cut's mention field (`mentionedUserId` on v10–v14, `mentionedUserIds` up to 8 on v15). A post or reply writes the first 8 distinct @names that resolve (`mentionFieldsFor`); the composer says "Only the first 8 people you mention will be notified." past 8. "Mentions of me" and the mention notifications read `mentionedUserIds contains <me>` (`mentionsOfUserQuery`). 

### Offline checks

The re-cuts were written while the repo's SDK was still 5.0.0-beta.4, which could not parse their grammar. That stop-gap is gone: on the 5.0.0-beta.5 SDK every check reads the files as written.

| Check | What it judges |
| --- | --- |
| wasm-sdk / wasm-dpp2 parse (`validate-contract-offline.mjs`, `--probes`) | the whole file; wasm-dpp2 refuses a bad element index (10205/10231) |
| `auditNodeRules` | what only the node checks: `where` conditions at registration (40126: referenced side exists and holds one value, literals of the property's type and in its enum, orderings on integers bounded by integers or required times), and the typed-array index rules again (one top-level array, ≤16 items or 4 under a window, element key limits, not unique, no skip on the array alone, ≤256 entries per document) |
| meta-schema (ajv) | the whole file, at the beta.5 tag |
| `--constraints` | every rule but those reading a referenced document, which no SDK pre-check reads (pollr's vote rules: the battery broadcasts them). The case runner pins `Date.now` to each case's instant, since the pre-check judges a write's recorded times by the device clock, and judges a replace against a stored version of the same document |
| `b5val` (rs-dpp 5.0.0-beta.5, out of tree) | full validation and the create's size; an rs-dpp evaluator harness also judged the pollr vote rules and the 31-day boundary |

The `where` cases model the new conditions off the file (`whereEntryHolds`): before, at and after a poll's close; an active, paused and closed store; comments on, unset and off.

```sh
node scripts/validate-contract-offline.mjs contracts/pollr-contract.json --strict-size
node scripts/validate-contract-offline.mjs --probes
node scripts/validate-contract-offline.mjs --constraints
```

### The register plan

- **Ids do not change**: they are `generateId(maker, nonce)`; the anchor, the group and the member order are as before.
- **Pins**: `APP_CONNECT_ENTRIES` pins the four new sha256s above (`verify-appconnect.mjs --self-test` checks them).
- **Plan**: `--plan --maker 9RPq2Ju… --start-nonce 13` builds the whole set. Signed estimates (100 B allowance, with the membership): app 742, social 16,491, blocks 1,293, DM v5 3,592, blog 6,692, pollr 3,739, storefront 16,349, auth vault 2,064 B. The connected modes refuse a node below Drive 5.0.0-beta.5 (`requireDriveVersion`).
- **Cost**: the set shrinks by about 690 B (pollr −467, storefront −290, blog −97, social +168).
- **Env**: the cut-over sets `NEXT_PUBLIC_POLLR_TOPOLOGY=v7`, `NEXT_PUBLIC_STOREFRONT_TOPOLOGY=v8`, `NEXT_PUBLIC_BLOG_TOPOLOGY=v8` and `NEXT_PUBLIC_CONTRACT_TOPOLOGY=v15` with the new ids.

### /devnet until the cut-over

The pollr client reads only v7 ballots (the v5/v6 slot-ballot code is gone), so `.env.devnet` keeps polls off (`NEXT_PUBLIC_POLLR_CONTRACT_ID=` blank, topology `v7`) until the cut-over registers pollr v7 and fills in every new id.
