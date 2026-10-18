# Social v16, the Platform 5.0.0-beta.6 cut

Social v16 is social v15 ([SOCIAL_V15.md](archive/SOCIAL_V15.md)) with up to four tags per post. Through v15 a post is indexed under one tag (`post.hashtag`), and every other tag in its text is plain text. Platform 5.0.0-beta.6 adds what a tag list needs:

- a `refersTo` `where` entry may compare two typed arrays, as lists (dashpay/platform#5388);
- an indexOnly type may index the elements of a typed array (#5390);
- a `preallocated` or `summableOffCountIndex` index may be keyed through such a `where` (#5394).

So `post.hashtag` becomes the typed array `post.tags`, and a like repeats the list and is counted under every tag of its post.

This document was written with the PRs that add the contract, the client topology `v16` and the tooling. **v16 is live on sakura since its 2026-10-13 beta.6 genesis, and `/devnet` runs it** (see [Registering it](#registering-it)). v16 needs Platform 5.0.0-beta.6, nodes and SDK alike; the repo's packages are at 5.0.0-beta.6.

| # | Decision | What changes |
| --- | --- | --- |
| 1 | **Up to four tags** | `post.tags` replaces `post.hashtag`: `{ "type": "array", "minItems": 1, "maxItems": 4, "uniqueItems": true, "items": { "type": "string", "pattern": "^[a-z0-9_]{1,61}$", "maxLength": 61 }, "position": 12 }`. Like `hashtag`, it is optional, frozen by name (`immutable`), kept by a moderator's removal record (`deleteKeepsFields`) and kept by an author's tombstone (`blankTombstone` does not count it). |
| 2 | **A like repeats the list** | `like.tags` (the same array, position 1) replaces `like.hashtag`, and `like.postId.refersTo.where` is `{ "tags": "tags", "$ownerId": "postAuthor" }`. The like carries exactly the post's list: the same tags in the same order, or 40127. An untagged post leaves `tags` out, and so do its likes (`[]` is refused by `minItems`). The unlike (an `indexOnlyDelete`) carries the list exactly as the create did. A reordered, shortened or changed list fails the row commitment (40101). |
| 3 | **Counted under every tag** | The three tag indexes keep their names and key `tags`, entering a document once per tag: post `tagAndTime [tags, $createdAt]`, like `byHashtagPost [tags, postId]` and like `byTrendHashtagPost [$createdAt, tags, postId]` (24h window, 6h step, kept a week, `outlivesDelete`). `byHashtagPost` stays the `preallocated` `summableOffCountIndex` counter of `byPost`, ranked at `[tags, postId]`. A post tagged `[a, b]` creates two counters at zero, and each like of it adds one to both. |
| 4 | **No `skipIfAbsent` on the tag indexes** | Platform refuses `skipIfAbsent` whose only skip property is the typed array (10231), and a list without elements never enters an index over it anyway. |
| 5 | **Four at most; the client refuses a fifth** | The contract takes at most four tags (`maxItems: 4`). The web client refuses a post whose public text names more than four distinct tags (hashtags plus cashtags) rather than index four and leave the rest as plain text: "A post can have at most 4 tags. Remove N tags." (`tagLimitProblem` in `lib/compose/limits.ts`). The composer, `postService.createPost` and the mobile engine's `validateDraft` all apply it. v9 to v15 are unchanged: they index the first tag only and leave the rest as plain text. |
| 6 | **Everything else is v15's** | Document types, every other property and index, the rules (same names), `deleteConstraints`, action fees, moderation, the non-transferable YAPP and the blocks contract. |

## The file

| | Social v16 |
| --- | --- |
| File | `contracts/yappr-social-contract-v16.json` |
| sha256 | `63dcfa91da1e6fba0c9759101cca4c3d515c34f3ba0ac9594261f03cf2d428fa` |
| Signed create | **~16,498 B** by `validate-contract-offline.mjs`'s estimate on the 5.0.0-beta.6 wasm-sdk (v15: ~16,457 B by the same estimate): 41 B more, 3,502 B under the 20,000 B budget. Mainnet's rendering (interim `notYetUsable`) is the same size. As an App Connect member, ~16,497 B with the membership and a 65 B signature. |
| Document types | 12, as v15 |
| Parses | Under full validation on the 5.0.0-beta.6 wasm-sdk, and under the node rules on the 5.0.0-beta.6 wasm-dpp2 (rs-dpp built with its `validation` feature), devnet and mainnet renderings alike. See [Validation](#validation). |

## The diff against v15

| | v15 | v16 |
| --- | --- | --- |
| `post.hashtag` / `post.tags` | `hashtag`: one optional string, `^[a-z0-9_]{1,61}$` | **`tags`**: an optional list of 1 to 4 distinct strings of that pattern |
| `like.hashtag` / `like.tags` | `hashtag`, bound by `where { "hashtag": "hashtag" }` | **`tags`**, bound by `where { "tags": "tags" }` (a list equality) |
| `post.immutable`, `post.moderatorAbilities.deleteKeepsFields` | name `hashtag` | name **`tags`** |
| `post.tagAndTime` | `[hashtag, $createdAt]`, `skipIfAbsent` | `[tags, $createdAt]`, one entry per tag, no `skipIfAbsent` |
| `like.byHashtagPost` | `[hashtag, postId]` counter of `byPost`, `skipIfAbsent` | `[tags, postId]` counter of `byPost`, one counter per tag and post, no `skipIfAbsent` |
| `like.byTrendHashtagPost` | `[$createdAt, hashtag, postId]` 24h window, `skipIfAbsent` | `[$createdAt, tags, postId]`, one entry per tag, no `skipIfAbsent` |

## Reading tags

Tag reads change shape on v16, because an index over a typed array is read with the element operators, not `==`:

- `==` on the array is refused. A read pins one tag with `['tags', 'contains', tag]`, which the node keys as an equality on one element. `containsAny` exists too, but a ranked read refuses it.
- **A tag page** (`tagAndTime`): `where: [['tags', 'contains', tag], ['$createdAt', '>', 0]]`, `orderBy: [['$createdAt', 'desc']]`. An array can be ordered by only under `containsAny`, so the order names `$createdAt` alone (v15 ordered by `hashtag` first).
- **A tag's top posts**: `ranked({ groupBy: 'postId', where: [['tags', 'contains', tag]] })` on `byHashtagPost`, or with the 24h window on `byTrendHashtagPost`.
- **Trending tags**: `ranked({ groupBy: 'tags' })` with no `where`. A like of a post tagged `[a, b]` counts once under `a` and once under `b`.
- **Counts**: `[['tags', 'contains', tag]]` counts every like under a tag, and `[['tags', 'contains', tag], ['postId', '==', id]]` counts one post's likes under it.
- A proved read rebuilds each entry with the one tag it sits under: a like under `dash` reads back `tags: ['dash']`, whatever else its post carries. The post's full list is read from the post.

## Client: topology `v16`

Set `NEXT_PUBLIC_CONTRACT_TOPOLOGY=v16` together with `NEXT_PUBLIC_YAPPR_CONTRACT_ID` and `NEXT_PUBLIC_YAPPR_BLOCKS_CONTRACT_ID`, as on v15. The descriptor is v15's, with the like's tag field and the tombstone's kept list switched to `tags`. On every inline cut, a post's tags are a list in memory (`Post.tags`: `[]` untagged, `undefined` unknown):

- `inlineTags()` (lib/contract-topology.ts) is `{ field: 'tags', max: 4, isArray: true }` on v16 and `{ field: 'hashtag', max: 1, isArray: false }` on v9 to v15. `tagFieldsFor` and `inlinePostTags` (on `storedTags` in lib/post-helpers.ts) translate between the list and the chain spelling at the boundary.
- A post's tags come from `indexedTags(content, max, 61)` (lib/post-helpers.ts): the hashtags in content order, then the cashtags, distinct, at most `max`, none inside a link (as the post renders it, a URL's `#fragment` or `?q=$BTC` is part of the link). `tagLimitProblem` refuses a v16 post that names more than four.
- A like and its unlike repeat the post's stored list unchanged.
- The tag pages read `postsTaggedQuery` (post-service). The per-tag rankings pin `tagPin` and trending groups by `tagGroupBy` (ranked-likes).

v15 and v16 work in one build.

## Tooling

The scripts read the cut off the contract file, never off its name, so one script serves v10 to v16.

- **`scripts/social-shapes.mjs`**: the cut flag `tagArray`, and the tag builders every script uses:
  - `tags(list)` gives the write fields: `{}`, `{ hashtag }` for one tag up to v15, or `{ tags }` on v16. It throws past the cut's limit.
  - `storedTags(data)` reads a stored document's tags back from either spelling.
  - `contentTags(content)` applies the client's rule: the first tag up to v15; on v16 every tag, and it throws when the content names more than four. The module also exports `indexedTags`.
  - Read builders: `tagPin`, `taggedPosts`, `tagRanking` and `tagLikesWhere`.
  - The self-test covers v16: four-tag posts and likes judged by rs-dpp's rules and serializer, and the checker refusing a repeated, empty, fifth or malformed tag.
- **`scripts/validate-contract-offline.mjs`**:
  - The per-write fee table prices `hashtag` up to v15, and a one-tag and a four-tag post and like on v16 (each row skips the cuts without its field).
  - A row the installed estimator cannot price prints "not priced" instead of stopping the run. The 5.0.0-beta.6 estimator prices every v16 row (the beta.5 one could not price a string list).
- **`scripts/contract-probes.mjs`** (`--probes`):
  - Meta-schema: the vendored document meta-schema is now 5.0.0-beta.6's (`contains`/`containsAll` `where` conditions), pinned by sha256 `742f9913…`.
  - `auditNodeRules` models the beta.6 rules:
    - a `where` pairs a typed array only with a typed array of the same element kind (40126);
    - the `contains`/`containsAll` conditions (40126);
    - on an indexOnly type, an index on a typed array needs `uniqueItems`, and another index that keeps one entry per document must keep it apart; it is preallocated or a counter only through a list equality in a `where`, and no counter counts it (10231).
  - The `where` cases compare lists element by element.
  - v16 probes: controls (devnet and mainnet renderings), and a read-back of the tag shape, indexes, binding, freeze and removal record. These are refused:
    - `skipIfAbsent` on `tagAndTime` or on `byHashtagPost` alone (10231);
    - five tags under the 24h window (10205);
    - `like.tags` without `uniqueItems` (10231);
    - a like index that `byPost` does not keep apart (10231);
    - a `where` pairing the list with a scalar (40126);
    - a removal record that does not keep the tags (preallocation).
  - `where` cases: the exact list agrees, and both lists left out agree. Refused (40127): a reordered list, a subset, a superset, a tagged like of an untagged post, and an untagged like of a tagged post.
- **`scripts/property-constraint-cases.mjs`** (`--constraints`): v16 declares v15's rules. The hashtag cases become one-tag lists. New cases: four tags with text, four tags alone (`notEmpty`), and a tombstone keeping four tags.
- **App Connect** ([APP_CONNECT_CONTRACTS.md](APP_CONNECT_CONTRACTS.md)):
  - `scripts/app-connect-set.mjs` registers v16 as the `social` member (sha256 `63dcfa91…`, `NEXT_PUBLIC_YAPPR_CONTRACT_ID`): sakura's beta.6 genesis starts a new set, so v15 is not carried along.
  - The publisher needs Drive 5.0.0-beta.6.
  - The `verify-appconnect.mjs --self-test` also checks that no two members share an env variable.
- **Batteries and measurements**: `verify-v10.mjs` (with `verify-lib.mjs`), `prove-merged-counts.mjs` and `measure-social-fees.mjs` write and read tags through the shapes above, so they run on v16 and on every earlier cut. Each file's header lists its v16 cases.
  - `verify-v10.mjs`:
    - the like refuses its post's two tags reordered, one of them alone or a third beside them (o1h to o1k);
    - a tombstone refuses the list reordered or shortened, and the removal record keeps both tags (x1td2, x1td3, x1tp2);
    - a like of a two-tag post counts once under each tag, all time, in the 24h window and in trending tags, and its unlike refuses the list reordered or shortened (t2p to t2x);
    - the self-test pins the v16 schema.
  - `prove-merged-counts.mjs` adds the `tg-*` phase: per-tag counters from the post's creation, counts at the tag and post level, rankings, trending tags and the unlike.
  - `measure-social-fees.mjs` adds a four-tag post, like and unlike.
  - `verify-tips.mjs` pins v16's YAPP as locked, like v15's.
  - `verify-social-query-bundles.mjs` takes a v10 to v16 contract (no bundle reads tags).
- **Seeder** (`scripts/seed/`):
  - `SEEDED_TOPOLOGIES` includes v16, and a v16 post writes its `tags` list. A like copies the target's list from the checkpoint journal, whose post ref records now carry the `tags` that were written. Records journaled before v16 replay as before.
  - The corpus format ([CORPUS_FORMAT.md](../scripts/seed/CORPUS_FORMAT.md)) has an optional `tags` per post or quote: exactly the tags the content names, in the client's order. Without it a v16 post is indexed under `[hashtag]`. One-tag cuts ignore `tags` and keep writing `hashtag`.
  - `parseCorpus` refuses a post or quote whose content names more than four distinct tags, on every cut, since a corpus is cut-independent.
  - The generator never emits such a post. It writes `tags` only where the content's tags differ from the one-tag reading. A separate random stream appends a second tag to 15% of tagged posts, so every other line of a corpus is unchanged.
  - The checked-in `corpus.pilot.jsonl` still parses.
- **e2e**:
  - `e2e/write/topology.spec.ts` reads `inlineTags()`. On v16 it posts with two tags, expects the post on both tag pages and its like under both tags, and checks the composer's refusal of a fifth tag.
  - `e2e/fixtures/dm.ts` counts v16 as a DashPay-profile cut.

## Validation

Run with the repo's 5.0.0-beta.6 packages:

- `validate-contract-offline.mjs contracts/yappr-social-contract-v16.json --strict-size`, with `--network devnet` (the default) and `--network mainnet`: v16 parses under full validation (wasm-sdk) and under the node rules (wasm-dpp2: meta-schema and index shapes), the node-rule audit and the beta.6 meta-schema are clean, and the create is ~16,498 B signed.
- `--cost`: every v16 row prices. A first like of a post with four tags costs about 2.2 times a first like of a post with one tag (276.9M against 126.6M credits), because the like is entered under each tag; a post with four tags about 1.9 times a post with one (381.9M against 198.4M).
- `--probes`: all 241 probes and `where` cases behave as recorded, the v16 ones included. Two v16 probes are refused one layer earlier than the book suggested: a like `tags` without `uniqueItems`, and a like array index nothing else keeps apart, are refused by the wasm-sdk's own parse, so the SDK never signs them.
- `--constraints`: every case of every file passes, v16's included.
- v15 still validates cleanly (`--strict-size`, devnet and mainnet).
- Offline self-tests pass:
  - `social-shapes.mjs` on v10 to v16;
  - `verify-v10.mjs` with `--contract-file` set to v10, v13, v14, v15 and v16;
  - `seed/run-seeder.mjs`, with the configured topology and with `NEXT_PUBLIC_CONTRACT_TOPOLOGY=v16`;
  - `seed/generate-corpus.mjs` and `seed-non-social.mjs --which pollr`;
  - `verify-appconnect.mjs` and `verify-tips.mjs`.
- `prove-merged-counts.mjs --dry-run` and `measure-social-fees.mjs --dry-run` pass on v15 and v16.

What only a live network can confirm: the `tg-*` checks of `prove-merged-counts.mjs` (a fresh per-tag counter listed at 0, counts and rankings under both tags, the window keeping an unliked entry), and the exact refusals `cn-e2` and `cn-b4` expect on v16.

## Registering it

Sakura was wiped for 5.0.0-beta.6 on 2026-10-13, so v16 is registered as the `social` member of a fresh App Connect set (`scripts/app-connect-set.mjs`: v16 in v15's slot, no v15) at maker nonce 25, `4qctQYg3…`, and `.env.devnet` runs topology `v16`. The ids and registration costs are in [SAKURA_BETA6_DEPLOY.md](SAKURA_BETA6_DEPLOY.md); so are the reseed, the batteries (`verify-v10`'s v16 cases, `prove-merged-counts` with the `tg-*` phase and `cn-e2`/`cn-b4`) and the live fees, which come in well below the estimator's: a one-tag post 122.7M credits (7.4¢), a four-tag post 232.9M (14.0¢), a first like 22.2M (1.3¢) with one tag and 36.2M (2.2¢) with four. On a chain whose group is already registered, v16 would instead be appended to the set and added by resuming the publisher's journal ([Adding a member to the registered set](APP_CONNECT_CONTRACTS.md#adding-a-member-to-the-registered-set)).
