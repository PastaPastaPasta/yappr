# Platform 5.0.0-beta.1: the blog v6 re-cut and the 5.0 tooling

Investigation date: 2026-09-30. This document covers the beta.7 → 5.0.0-beta.1
range only. Everything earlier is in [`PLATFORM_BETA7_UPGRADE.md`](./PLATFORM_BETA7_UPGRADE.md).

This branch contains what 5.0 makes mandatory, plus decision D5:
- the blog contract re-cut, **blog v6**;
- the contract tooling, which now validates against the 5.0 rules;
- the SDK pin, **5.0.0-beta.1** for all three `@dashevo` packages;
- D5: blog comments derive their post's owner (client topology `v6`).

**Nothing published.** The devnet cut-over to sakura (network wiring, new
contract ids, bundle snapshot, `.env.devnet` with `NEXT_PUBLIC_BLOG_TOPOLOGY=v6`)
is a separate PR.

## Versions and scope

| Release | Commit | Changes reviewed |
| --- | --- | --- |
| `v4.2.0-beta.7` | `50d120372788985d9ee97ba04ae6b1e6603dfa0b` | Starting point; see the beta.7 document. |
| `v5.0.0-beta.1` | `b95849a1767aa26fa794cf69a44d4fc107ee6528` | 20 commits. The 4.2 line was renamed 5.0, so this follows beta.7 directly. Protocol version is still **14**. |

### The SDK pin: 5.0.0-beta.1 from npm

All three packages are pinned to exactly `5.0.0-beta.1`, resolved from `registry.npmjs.org` (dist-tag `5.0-beta`):

| Package | npm tarball sha256 | npm shasum |
| --- | --- | --- |
| `@dashevo/evo-sdk` | `b16da85b309fad857e5ed9dadd79aae334fd39e0be6c5bc7f28da47101c712c6` | `2feddf37c7e9c79c2dc67df081aba1bdc0709892` |
| `@dashevo/wasm-sdk` | `02d797570d6066270daa5cc58ba7ab15fcb0f4a794950304dcdbb5933dc4fffe` | `e5589287d63dd750800f5d08d4e9dd3dac96e0a5` |
| `@dashevo/wasm-dpp2` (devDependency) | `94d68e88ce97451567ab5bf87470515ce55068e77be17e5ae30e318f3ee506f7` | `2d2f6f96a1f012a38aab902f8bdfe5fd113ebfa8` |

`npm ls @dashevo/wasm-sdk` shows one copy, deduped under evo-sdk.

npm had no 5.0.0-beta.1 on 2026-09-30 (the release run's `build-npm` job had failed), so the contract checks below first ran against the three packages **built locally from the tag** with `yarn pack`:

| Package | local tarball sha256 |
| --- | --- |
| `@dashevo/evo-sdk` 5.0.0-beta.1 | `3b66b2912fd181b898c870ea8116d66d3e81ac04f6d4743cd70fd3c82116f8e0` |
| `@dashevo/wasm-sdk` 5.0.0-beta.1 | `5bc14aea630afb52f17f07999ef98f52c4f75c4250ee7d142b9a7d276c269a72` |
| `@dashevo/wasm-dpp2` 5.0.0-beta.1 | `cd9a49939f7f570f33f29b24c8fc2b79c40a475ceb430e66c3805a8a40928db9` |

**The npm and local builds differ only by build environment.** Every packaged file was compared:
- the TypeScript declarations hold the same lines in a different order, except for the wasm-bindgen mangling hashes in internal closure names;
- the `.wasm` binaries and the JS glue therefore differ byte-wise (wasm-sdk 25,026,135 B on npm against 24,998,300 B local);
- every evo-sdk file except the bundled module and its source map is identical.

No exported API differs, and the checks in "Validation" were re-run on the npm packages with the same results.

### Lockstep: blog v6, the 5.0 SDK and the 5.0 nodes ship together

- **The 5.0 SDK cannot read the beta.7 blog.** 5.0 refuses `immutableAllowSetting` on every parse, not only at registration. A `contracts.fetch` of bonsia's live blog (`AKNfbco5…`) fails, and so do the superseded `6j8wA3xa…` and `FJ2AiWms…`. A 5.0 node runs the same parse, so it will not load them either.
- **The beta.7 SDK cannot read blog v6.** It refuses the cut with "moderatedDocument refersTo does not take where".
- **Every other Yappr contract parses on both.** That covers social v10, storefront, pollr, DM v4 and v5, key exchange and the vaults. A 5.0 SDK fetched 13 of bonsia's 16 contracts; the 3 failures are the blogs. Proved document reads also work.

So the tooling in this PR is 5.0 tooling.
- With the beta.7 packages, `validate-contract-offline.mjs` refused `contracts/yappr-blog-contract.json`, and `--probes` reported the five 5.0-only probes as failures. On the 5.0 pin both pass.
- The beta.7 bundle on `/devnet` loses its blog when the nodes upgrade, whatever this PR does. `lib/contracts/bundled/devnet-bonsia-g1.json` still holds the beta.7 blog. The loader falls back per contract, so only blog fails: blog pages error until the cut-over PR publishes v6, points `NEXT_PUBLIC_YAPPR_BLOG_CONTRACT_ID` at it and re-snapshots the bundle.

## What changed, grouped by effect on Yappr

| Group | Commits | Effect on Yappr |
| --- | --- | --- |
| **Conditional `immutable`** | #5217 | An `immutable` entry may be `{ "property": p, "when": condition }`, in `propertyConstraints` grammar, where `$old.<p>` reads the stored document. **`immutableAllowSetting` is refused on every parse.** `documentTypeImmutableProperties(t)` now returns `{ immutable, immutableWhen }`. **Breaking for blog** (`blogPost.publishedAt`). Social v9 also used it, but beta.7 already could not read v9. |
| **`moderatedDocument` references** | #5214 | A third reference kind, disjoint from the other two. Each type admits exactly one: **permanent** (nothing removes its documents), **moderated** (`canBeDeleted: false`, no `ttl`, a moderator delete that keeps records) or **deletable** (anything else). A moderated reference resolves to the document, or to its removal record once a moderator removes it. Registration refuses a `deletableDocument` reference at a moderated type (**40144**) and a `moderatedDocument` reference at any other type (**40143**). **Both wasm parsers accept the 40144 case**; only the node refuses it. **Breaking for blog:** `blog` and `blogPost` are moderated-kind. |
| **Derived index properties** | #5216 #5223 #5224 | An index may hold `"<ref>.<field>"`, read through a permanent or moderated reference instead of a copied value. It is not allowed on `indexOnly` types, so `like`/`likeReply` cannot use it. Usable for blog comments; see "Pending decisions". |
| **`outlivesDelete`** | #5232 #5233 | A delete leaves an indexOnly window's entries to expire, and when every `$createdAt` index outlives deletes, a delete stops carrying `$createdAt`. **Adopted in social v11** (D1, [SOCIAL_V11.md](SOCIAL_V11.md)). |
| **`deleteKeepsFields`, `deleteSettled`, preallocation through moderated references** | #5219 #5215 #5229 | Removal records can keep fields. A seated team can delete past `deleteWithin` with approvals (new codes 41204-41211). **`deleteKeepsFields` and `deleteSettled` are adopted in social v11** (D4, D3). Preallocation (D2) is not. |
| **Moderation reads** | #5230 #5213 | `contracts.moderationActionCounts` and team `approvalCount`/`seats`. The wasm-sdk now fetches the contract before it verifies a moderation proof. On v11 the moderation UI shows team approval counts, signers, seats and per-member action counts. `moderation-service.ts` uses the dedicated `contracts.moderator*` methods. |
| Swift, rs-sdk tests, release | #5202 #5209 #5218 #5234 and Swift follow-ups | None. |

**Error codes are additive only.** The new ones are 40143-40145 and 41204-41211, and no existing code moved. 40143 and 40144 are registration-only, so the tooling catches them, and the client raises none of the others until a feature that uses them is adopted.

**SDK surface.** No signature Yappr calls was removed. `DocumentCreateOptions` still has no `actionFeeAgreement`, so `lib/manual-batch.ts` stays. `documentCreateCost` printed identical figures for social v10 under beta.7 and 5.0.

## What this PR adopts

### Blog v6 (`contracts/yappr-blog-contract.json`, edited in place)

The first two changes are required to load on 5.0. The third (D5) is optional, and is taken at the same re-cut because it is free only then:

1. `blogPost.publishedAt` was listed in `immutable` and in `immutableAllowSetting` ("frozen, but a draft may set it once"). It becomes a conditional entry with the same meaning:

   ```json
   "immutable": ["blogId", { "property": "publishedAt", "when": { "present": "$old.publishedAt" } }]
   ```

   A replace may add `publishedAt` while the stored post has none, and may not change or drop it once stored. This is the exact form 5.0's refusal message suggests, and the parsed contract reports `{"immutable":["blogId"],"immutableWhen":{"publishedAt":{"present":"$old.publishedAt"}}}`.
2. `blogPost.blogId`, `blogComment.blogPostId` and `blogFollow.blogId` become **`moderatedDocument`** references. `blog` and `blogPost` have `canBeDeleted: false`, no `ttl` and a record-keeping moderator delete, so as `deletableDocument` references they would be refused with 40144.
   - A new comment, follow or post naming a removed target is still refused: a write must name a document in state.
   - What changes is a **replace**. A post whose blog was taken down can still be edited: the `blogId` owner gate compares `$ownerId`, which the removal record keeps. Under beta.7, such a post's required `blogId` could no longer be re-validated. No battery case covers this yet; the cut-over PR should add one to `verify-blog.mjs`.

3. **D5: a comment derives its post's owner** (#5216). `blogComment.blogPostOwnerId` is dropped. `postOwnerAndTime` indexes `blogPostId.$ownerId`, a derived index property read through the moderated reference, instead of the copied value, and the `$ownerId` entry leaves the `blogPostId` `where`.
   - `content` and `postCommentsEnabled` move up to positions 1 and 2.
   - The `blogComment` and `blogPost` descriptions now say what the index reads, not the dropped field.
   - It qualifies because `blogPost` is moderated-kind and comments are immutable. A derived property needs a permanent or moderated reference, and the probes pin the refusal through a `deletableDocument` one.
   - A comment costs **111.1M / 57.6M** credits (new / known index values) against 111.8M / 58.4M without D5. The document is 362 B against 394 B.

This changes the comment write surface, so the cut is **topology `v6`** (`blogCommentsDerivePostOwner()`):
- `blog-comment-service` stops writing `blogPostOwnerId` on v6.
- "Comments on my posts" pins `blogPostId.$ownerId ==` and orders on it. A query that pages with a `startAt`/`startAfter` cursor must pin every derived property with `==`, and this one pins it anyway.
- The seeder leaves the field out on v6.
- `verify-blog.mjs` drops b3a (a forged owner): there is no copied owner left to forge. b4d queries the derived name.
- **Not verified live:** a proved query on a derived index property. No 5.0 node was available.
- **Battery gap for the cut-over PR:** no case removes a comment after its post was taken down, which makes Drive read the post's `$ownerId` from the removal record. No case checks that `postOwnerAndTime` still lists such a comment either. Add both to b15 in `verify-blog.mjs`.

Set `NEXT_PUBLIC_BLOG_TOPOLOGY=v6` in the cut-over PR, together with the new blog id. Until then the devnet bundle stays on `v5`.

| | Before (beta.7, topology v5) | Blog v6 (5.0.0-beta.1, topology v6) |
| --- | --- | --- |
| sha256 | `464b605e652d6dac031fee9576d9573bf25b5fe6dda530b7f8330da78d915dbe` | `c5a2c9cd422c2508b32868250460fe37b1c1377d4ece5869c3a0395d9f86a9e2` |
| File | 12,771 B | 12,417 B |
| Signed create transition | ~6,489 B | ~6,244 B |

Every other contract file is byte-identical.

### Tooling

- **`scripts/meta-schema/document-meta-v3.json`** is re-vendored from `packages/rs-dpp/schema/meta_schemas/document/v3/document-meta.json` at the tag, and the pin in `contract-probes.mjs` moves to sha256 `eb8d94b78752998dbe76f7fd32c551e170e23fc560b6ece70f302f4ac62b8b52`. The beta.7 file refused conditional `immutable` entries and `outlivesDelete`.
- **One reference-kind rule, matching the node.** `contract-probes.mjs` exports `referenceKindMismatch` (rs-dpp `document_reference_kind`), which maps a mismatch to 40122, 40131, 40143 or 40144. It is used in three places:
  - `auditNodeRules`, run by the offline validator;
  - `register-lib.mjs auditModeration`, the gate both registration scripts run before they broadcast. Before, it refused every non-`deletableDocument` reference at a moderator-deletable type, which would have refused blog v6, and it let the 40144 shape through.
  - `battery-moderation.mjs selfTestModerated`, used by the batteries' `--self-test`.
  - `register-social-v3-draft.mjs` dropped its own copy of the old two-kind check; `auditModeration` runs right after it.
- **The conditional `immutable` shape:**
  - `register-feature-contract.mjs` compares the declared entries with `{ immutable, immutableWhen }` and prints `publishedAt(when …)`. Integer literals come back from the parse as BigInt, so both sides are compared with them as numbers.
  - `battery-lib.mjs selfTest` takes `immutableWhen` beside `immutable`.
  - `verify-blog.mjs` pins `publishedAt` as `immutableWhen`.
  - The #4983 audit (no set-once on a by-id `deletableDocument` reference) now reads conditional entries. The immutable-reference rules count a property listed with a condition as immutable, as rs-dpp's `lists_as_immutable` does.
- **The index audit** skips derived index properties (`"<ref>.<field>"` through a `refersTo`).
- **Probes** (`validate-contract-offline.mjs --probes`) pin both sides:
  - `control: blog as committed` is accepted;
  - the blog in its beta.7 shape (`immutableAllowSetting`) is refused by the wasm-sdk parse;
  - the blog with its beta.7 `deletableDocument` references at `blog` passes both parses and is refused by the audit (node: 40144);
  - `postOwnerAndTime` deriving through a `deletableDocument` reference is refused by the wasm-sdk parse;
  - a `moderatedDocument` reference at a `blogPost` its owner may delete, or whose removals keep no record, is refused by the audit (node: 40143);
  - the #4983 probe uses a conditional entry.
- **A probe fix.** Three storefront probes (#4982, #4983 and the nested deletable reference) gave their new property position 98 or 99 on a type whose only property is at 0. wasm-dpp2 refused them for the position gap, so the probes passed without ever reaching the rule they name. They now use position 1, and each is refused by the rule it names.

## Validation in this PR

The contract checks ran with the scripts from this branch, first against the local 5.0.0-beta.1 builds above and again on the npm 5.0.0-beta.1 pin, with the same results.

- `validate-contract-offline.mjs` on every file in `contracts/`:
  - blog v6, social v10, storefront, pollr, profile, DM, DM v5 and key exchange pass;
  - the legacy files fail exactly as they do on beta.7 at `HEAD`: `mutable` in the vault, auth-vault, key-backup, hashtag, mention and block files; v2's token shape; v9's beta.6 grammar; and `yappr-minimal.json`'s shape.
- `--probes`: 80 of 80 pass. `--constraints` passes.
- `register-feature-contract.mjs --dry-run` passes for blog, storefront, pollr, DM, DM v5 and key exchange. It refuses the blog with `deletableDocument` references before broadcast ("admits only moderatedDocument, not deletableDocument (40144)"). `register-social-v3-draft.mjs --dry-run` passes its audit for social v10.
- These `--self-test` runs pass:
  - `verify-{blog,dm,dm-v5,pollr,storefront,tips,v8,v10}.mjs`;
  - `seed/seed-non-social.mjs --which {storefront,blog,dm,pollr,tips}`;
  - `seed/run-seeder.mjs`;
  - `seed/provision-seed-identities.mjs`.
- `npm run lint`, `npm run test`, `npm run build` and `npm run lint:dead` pass on the 5.0.0-beta.1 pin.
- **Testnet still reads on 5.0.** A 5.0 SDK fetched every testnet contract the staging and `/testing` builds use: social v2 (`9oDC6xdg…`, and `/testing`'s `2qvaZNJJ…`), profile, DM, storefront, blog, pollr, key backup, key exchange, vault and auth vault.
- **Against a 5.0 node** (the new devnet sakura, read-only): the 5.0 SDK connects with `devnetName` `sakura`, reports dapi and drive 5.0.0-beta.1 at protocol 14, and fetches the DashPay and DPNS system contracts. Nothing was broadcast from this PR.

## Decisions (2026-10-01)

- **Bonsia is abandoned.** The devnet moves to **sakura**, a fresh 5.0.0-beta.1 chain, so every contract is published anew there.
- **D5 is taken here:** blog comments derive the post owner (above, topology `v6`).
- **D1, D3 and D4 are taken in social v11** ([SOCIAL_V11.md](SOCIAL_V11.md)), a separate PR: `outlivesDelete` likes (a like drops from 40.2M to 30.4M credits, and like notifications lose the time of each like), a team-approval deletion window on posts and replies (`deleteWithin` plus `deleteSettled`, with a new election), and removal records that keep `hashtag`/`$createdAt`.
- **D2 is not taken:** posts stay author-deletable, with no preallocated like trees.
- D6 no longer applies.
