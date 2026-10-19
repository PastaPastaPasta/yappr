# Social v17, the testnet production cut

Social v17 is social v16 ([SOCIAL_V16.md](SOCIAL_V16.md)) cut for Yappr's first real release on Dash testnet (Platform 5.0.0-rc.3, protocol 14; [TESTNET_RELEASE.md](TESTNET_RELEASE.md)). It is the contract users will write to, so everything in it is frozen once it is registered: indexes, required properties, mutability, deletability, `distinctFrom`, patterns and maxima, references, token rules and the moderation declaration. Every change below comes from the owner's release decisions (D-numbers) or the pre-release audit (R-numbers), as recorded in the release audit's `DECISIONS.md`.

The same cut re-cuts three feature contracts in place: blog v9 and pollr v8 ([NON_SOCIAL_CONTRACTS.md](NON_SOCIAL_CONTRACTS.md#blog)), and storefront v10 ([STOREFRONT_V10.md](STOREFRONT_V10.md)). The App Connect set (`scripts/app-connect-set.mjs`) now registers social v17 and no longer carries the password-era `authVault` (R-M6).

**Status.** Not registered on testnet. A throwaway copy of each new file was registered on sakura by personas and probed live (see [Sakura probe](#sakura-probe)). `.env.devnet` and every production env still name v16; a later work package rehearses the full set on sakura and wires the envs.

| # | Decision | What changes |
| --- | --- | --- |
| 1 | **Tombstones leave the global listings** (R-M1) | `post.timeline` is `[live, $createdAt]` and `post.tagAndTime` `[live, tags, $createdAt]`, both `skipIfAbsent`, so an author's tombstone (which drops `live`) and a moderator's removal leave them. Through v16 every retraction stayed on the global timeline and on every tag page it carried. `timeline` is also `rangeCountable`, and `post.documentsCountable` is gone: the post total is the live posts, the timeline's count at `live == true`. |
| 2 | **Live replies** (R-S1) | `reply.live` (`const: true`, position 12) with the post's rule (`countPresent(deleted, live) == 1`) and freeze (`{property: live, when: {absent: deleted}}`); `reply.ownerAndTime` is `[live, $ownerId, $createdAt]` with `skipIfAbsent`. `repliesOf` and the two notification windows still hold tombstones: they anchor the live replies under them. |
| 3 | **A reply says something** (review) | `reply.notEmpty`: text, ciphertext or media, or it is a tombstone, as `post.notEmpty`. An empty reply was valid and sponsored at 3 YAPP. |
| 4 | **No lone quote owner** (R-M2) | `quoteOwner` is `{"in": [{"countPresent": ["quotedPostId", "quotedReplyId", "quotedPostOwnerId"]}, [0, 2]]}`. With `oneQuote` it admits nothing or one quote id with its owner. A post carrying only `quotedPostOwnerId` used to enter the victim's `quotedPostOwnerRecent` window. |
| 5 | **No self-likes** (D6) | `like.postAuthor` is `distinctFrom: $ownerId` (refused 10419 before broadcast). `likeReply` names no author, so its reference refuses one: `replyId.refersTo.where: {"$ownerId": {"notEqual": "$ownerId"}}` (40127, a paid refusal: the client hides the button). |
| 6 | **https and ipfs only** (D14, R-S4) | `post`/`reply` `mediaUrls` items and `yapprProfile.bannerUri`: `^(https|ipfs)://.+$`. `yapprProfile.website`: `^https://.+$`. `yapprProfile.avatar` (a DiceBear recipe, or an image the client could not fingerprint for DashPay): `^(\{.+\}|(https|ipfs)://.+)$`. |
| 7 | **Byte caps on free text** (R-S3) | `maxBytes` on `report.note` (1,500) and `resolution` (600), `yapprProfile` `location` (150), `pronouns` (60), `avatar` (384), `website` (200), `bannerUri` (512), and `post.embedDocType` (64). Text gets 3 bytes a character, so a full-length CJK value fits; URLs and type names a byte a character, as `mediaUrls` already declares. |
| 8 | **Room for report reasons** | `report.reason` maximum 9 → 31. The client offers 0–9; storefront and blog reports share the list, and a later reason needs no contract change. |
| 9 | **YAPP has no authority** (D3) | `manualMintingRules`, `manualBurningRules`, `freezeRules`, `unfreezeRules` and `destroyFrozenFundsRules`: `authorizedToMakeChange` and `adminActionTakers` both `noOne`. Every other rule already was, `mainControlGroup` is null and a contract update cannot touch a token, so nothing can re-grant them. Supply comes only from the 100-YAPP `oncePerIdentity` claim, and the token costs still burn. |
| 10 | **Several write-once private feeds per identity** (R-M5, PF1–PF9) | `privateFeed` replaces `privateFeedState`; grants and rekeys name their feed; caps are stored per feed and checked on chain. See [Private feeds](#private-feeds). |
| 11 | **One moderator for a day** (D39) | `post` and `reply` `moderatorAbilities.deleteWithin` is 86,400 s (v16: 604,800 s): one moderator removes a post or reply alone for a day after its last change, then it settles and only the seated team removes it, with the leader plus 2 more approvals as before. The signed size and registration fee are unchanged (both values encode at the same width). |
| 12 | **Unchanged by decision** | Sponsorship (D4: post/reply/like/likeReply at 10/3/1/1 YAPP, `gasFeesPaidBy: 2`), settled deletion after the window (D5: the leader plus 2 more approvals), follows (D17), bookmarks (D13), the tag pattern (D7), every other index, rule and fee, and the moderation declaration: the file keeps mainnet-legal election windows (join 604,800 s, vote 259,200 s) and interim `contractOwner`, and the registration renders testnet's (below). |

## The file

| | Social v17 |
| --- | --- |
| File | `contracts/yappr-social-contract-v17.json` |
| sha256 | `ae4d3e7d38855bdfa1cebe5bc76c3ecf8f19cf344622c694f63c124c20d23c49` |
| Signed create | **~18,019 B** by `validate-contract-offline.mjs` on the 5.0.0-rc.3 wasm-sdk, testnet and mainnet renderings alike (v16: ~16,498 B): 1,981 B under the 20,000 B budget, 2,461 B under the 20,480 B cap |
| Document types | 12: `privateFeed` replaces `privateFeedState` |
| Registration fee | 91.00e9 credits by the protocol-14 fee table (`registrationFee` in `scripts/registration-policy.mjs`), the same as v16; **91.76e9 measured on sakura** (5,506¢) |
| Parses | Full validation on the rc.3 wasm-sdk and the node rules on the rc.3 wasm-dpp2, `--network testnet` and `--network mainnet` (`--strict-size`); registered on sakura (beta.6 nodes, whose reference validation is identical) |

## Reading the live-keyed indexes

Drive serves a `skipIfAbsent` index only to a read that pins every skip property with a constraint no missing value meets (`index_admissible_for_skip_if_absent`, rs-drive `query/mod.rs`). So every read of the three re-keyed indexes pins `live == true`, and an unpinned read is refused outright (proved on sakura): the client, the scripts, the e2e fixtures, the seeder and the mobile build must move together with the contract ids.

| Read | `where` | `orderBy` |
| --- | --- | --- |
| Global timeline (Recent, For You, search, new-posts poll) | `live == true`, `$createdAt > t` | `$createdAt desc` (or `live asc, $createdAt desc`) |
| A tag page | `live == true`, `tags contains tag`, `$createdAt > 0` | **`$createdAt desc` only**: `tags` sits between `live` and `$createdAt`, and an `orderBy` must be a contiguous run of the index, so `live asc, $createdAt desc` is refused (proved) |
| An author's posts | unchanged: `live == true`, `$ownerId ==`, `$createdAt > 0` | `live asc, $ownerId asc, $createdAt desc` |
| An author's replies | `live == true`, `$ownerId ==`, `$createdAt > 0` | `live asc, $ownerId asc, $createdAt desc` |
| Live posts in total | count `live == true` (O(1), the timeline is `rangeCountable`) | — |

A whole-type count (no `where`) is refused on v17: the type keeps no count tree. Thread reads (`repliesOf`) and the reply notification windows are unchanged and still return tombstones.

**Why `[live, tags, $createdAt]` and not `[tags, live, $createdAt]`.** Two stripped contracts that differ only in this order were registered on sakura and given the same writes and reads:

| | live-first (chosen) | tags-first |
| --- | --- | --- |
| the client's tag page (`live ==`, `tags contains`, `$createdAt >`, ordered by `$createdAt`) | served, tombstone gone | served, tombstone gone |
| two tags at once (`tags containsAny`, ordered by `tags, $createdAt`) | **served** | **refused** (an `in`-like clause must sit on the last or before-last property) |
| `live asc` in the order | refused | served |
| a post with four new tags | **101.5M (6.1¢)** | 125.9M (7.6¢) |
| a post with one new tag; either with known tags | 52.2M; 27.6M / 76.5M | 52.2M; 27.6M / 76.9M |

Live-first keeps a multi-tag feed possible without a re-cut, is cheaper whenever a post brings new tags (one `live` level instead of one per tag), and matches `post.ownerAndTime [live, $ownerId, $createdAt]`. Its only constraint, `$createdAt` alone in the order, is what the client sends.

## Private feeds

The shapes are exactly §4 of the owner-approved design (`private-feeds-multi-design.md` in the release audit), with the owner's answers PF1–PF9:

- **`privateFeed`** (write-once, undeletable): `feed` (1–65535, per-owner counter, unique `[$ownerId, feed]`, the race guard), `treeCapacity` (64–32768), `maxKeyGeneration` (2–65535), `keyId`, `encryptedSeed`, and the optional `carry` (history link), `audience` (1–255, unused at launch, PF7) and `label` (encrypted name, PF7). The release defaults the client will write are treeCapacity 4096 and maxKeyGeneration 4095 (PF2); both are stored per feed.
- **`privateFeedGrant`** (write-once, deletable: a revocation deletes it and frees the leaf): `feed`, `recipientId` (`distinctFrom $ownerId`, must have a `followRequest` to the owner), `leafIndex` (u16), `keyGeneration` (u16), `encryptedPayload` (≤ 704 B). Indexes `recipient [recipientId, $ownerId, feed]` and `leaf [$ownerId, feed, leafIndex]`, both unique (D32 extended by `feed`).
- **`privateFeedRekey`** (write-once and now **undeletable**, a v16 bug fixed): `feed`, `keyGeneration`, `revokedLeaf`, `packets`, `encryptedCEK`; unique `generation [$ownerId, feed, keyGeneration]`.
- Grants and rekeys bind to the writer's own feed through `ownerRefersTo permanentDocument privateFeed findBy {$ownerId: ".", feed: "feed"}`, and the stored caps are checked there (PF1): `treeCapacity > leafIndex | revokedLeaf`, `maxKeyGeneration >= keyGeneration` (40127).
- `post.feed` (position 18) and `reply.feed` (position 13) name the feed of a private post; `private` requires all four of `encryptedContent`, `keyGeneration`, `nonce` and `feed` or none; `blankTombstone` clears `feed`; `feed` is frozen while live. `keyGeneration` is a u16 everywhere.
- `followRequest` is unchanged: it now persists as standing consent while following (PF8), a client rule.

## Client: topology `v17`

`NEXT_PUBLIC_CONTRACT_TOPOLOGY=v17` (with `NEXT_PUBLIC_YAPPR_CONTRACT_ID` and `NEXT_PUBLIC_YAPPR_BLOCKS_CONTRACT_ID`, as on v15 and v16). The descriptor is v16's; the differences are predicates in `lib/contract-topology.ts`, each read off the committed JSON or the cut order:

- `postListingsCarryLiveMarker()` / `postListingWherePrefix()`: `postTimelineClauses` (lib/services/document-service.ts) and `postsTaggedQuery` (lib/services/post-service.ts) pin `live == true` in `where`; `countAllPosts` counts the timeline at `live == true`.
- `repliesCarryLiveMarker()` / `replyOwnerIndexPrefix()` / `replyOwnerIndexOrderPrefix()`: a reply create writes `live: true`, its tombstone leaves it out (unchanged tombstone path), and `getUserReplies` pins it.
- `yappCanBeFrozen()`: false on v17, so the token authority's freeze/unfreeze/slash tools are hidden in Settings (they would have nothing to sign).
- `privateFeedsAreMultiple()` / `privateFeedClientSupported()`: the private-feed client speaks v17's multi-feed shape only ([Private-feed client](#private-feed-client)), so private feeds are offered on v17 and on no earlier cut.
- `selfLikesAreRefused(kind)`: the like button is disabled on one's own post or reply ("Can't like your own post"), and `likeService.likePost` refuses it before reading or signing (a self reply-like would be a paid 40127).
- `profileExtensionPattern(field)`: the profile planner checks the cut's website, banner and avatar patterns before any write (v17: https only; an image avatar https or ipfs), so a DashPay change cannot land ahead of a refused extension. Storefront v10's item images are checked against its https/ipfs pattern the same way.
- `ownerDistinctProperties('like')` now names `postAuthor`; `reportShape().maxReason` is 31 (the client still offers 0–9).
- `lib/contract-query-conformance.test.ts` drives the client's readers with `v17` (and blog v9, storefront v10, pollr v8) and fails when a query has no index Drive would serve it with.

v16 and v17 work in one build; nothing below v17 changes.

## Tooling

- `scripts/app-connect-set.mjs`: social v17 in v16's slot, `authVault` removed (and listed with the retired files, so it cannot rejoin), sha256 pins re-taken for social, blog, pollr and storefront. `verify-appconnect.mjs --self-test` passes. **Merge order:** the passkey vault (`contracts/yappr-passkey-vault-contract.json`, branch `feat/passkey-vault`) appends its own entry; whichever lands second re-pins nothing of the other's, but must rebase the `APP_CONNECT_ENTRIES` list.
- The registration tooling (WP1) renders every elected member's config at registration: `register-app-connect-contracts.mjs` passes social, blog and storefront through `withInterim` and `withElectionWindows`, and `registrationPolicy` refuses a testnet or mainnet run without `--interim` and `--election-windows`. Testnet registers with `--interim notYetUsable --election-windows 3600,3600` (D1); after registration, read each contract's on-chain config and confirm both.
- `scripts/validate-contract-offline.mjs`, `scripts/contract-probes.mjs` and `scripts/property-constraint-cases.mjs` know the v17, blog v9, storefront v10 and pollr v8 shapes (see [Validation](#validation)).

## Validation

Run with the repo's 5.0.0-rc.3 packages:

- `validate-contract-offline.mjs <file> --strict-size --network testnet` and `--network mainnet`, for social v17, blog v9, storefront v10 and pollr v8: all parse under full validation (wasm-sdk) and the node rules (wasm-dpp2), and the node-rule audit is clean. Signed creates: social 18,019 B, blog 8,852 B, storefront 18,704 B, pollr 3,568 B.
- `--probes` and `--constraints`: see the tooling results recorded in the PR.
- `npx vitest run` (the topology, moderation, query and conformance specs), `npm run lint`, `npm run build`.

## Sakura probe

Throwaway copies of the four files, plus two stripped contracts that differ only in the tag index order, were registered on sakura (Platform 5.0.0-beta.6, PV14) on 2026-10-17 by personas, never the devnet maker; battery bots 0–2 funded them by credit transfer. 153 writes and reads, every one as expected; the full record and the probe script are kept with the release audit (`wp3-probe/`). Fees are balance differences of the signer (1M credits ≈ 0.06¢); a refusal's cost is its penalty. First writes on a fresh contract pay for new index subtrees, so they run higher than on a busy one.

| Contract | Throwaway id | Owner | Registration |
| --- | --- | --- | --- |
| social v17 | `Aw1VaZwo73ZpfCYfiuGTxTWvFnSAxxq4YANnkFre8Too` | corpus:72 | 91.76e9 (5,506¢) |
| blog v9 | `BPY9ctr6CeJhix8y7jN5sv6DDXyVje5kuA7kKYgDzxRX` | corpus:74 | 36.38e9 (2,183¢) |
| storefront v10 | `5ASqUSu2maK1ibbmD3Go6L1MGypsTuvmSKN9LNcNA3XS` | corpus:81 | 60.72e9 (3,643¢) |
| pollr v8 | `7XxAZfo5k2uWEigXdQymzhNPQVmqgJR9wMUveoUfJ3y1` | corpus:79 | 17.14e9 (1,028¢) |
| tags `[live, tags, $createdAt]` | `B6VW372eQC8HKbagiGVMQuosPHt3wYzqAonLBK95oMzo` | corpus:79 | 13.06e9 |
| tags `[tags, live, $createdAt]` | `CEUv2bWKQ4VsRA3XqHj6amJKGcv2pHcvartMwt99uQ31` | corpus:79 | 13.06e9 |

These copies predate D39: their post, reply, blog post and blog comment carry `deleteWithin: 604800`, not the current files' 86,400.

Social v17, as expected in every case:

| Proved | Outcome | Fee |
| --- | --- | --- |
| a live post with one tag / four tags / none (first writes on a fresh contract, the 80M action fee included) | accepted | 283.8M (17.0¢) / 351.2M (21.1¢) / 161.3M (9.7¢) |
| a post without `live` | refused 10422 `live` | 0 |
| an author's tombstone | accepted | refund 47.3M |
| timeline and tag page with `live == true` | the tombstone is gone from both | — |
| timeline, tag page and an author's replies without the pin | refused: no index serves them | — |
| tag page with `live asc` in the order | refused (not a contiguous run of the index) | — |
| live-post count on the timeline | 2, the tombstone not counted; a whole-type count is refused | — |
| a live reply (first / second) | accepted | 129.6M (7.8¢) / 73.9M (4.4¢) |
| a reply without `live`; an empty reply | refused 10422 `live`; 10422 `notEmpty` | 0 |
| a reply tombstone | gone from the author's replies, kept in the thread (`repliesOf`) | refund 11.6M |
| a moderator's removal, then restore, of a live reply | leaves the author's replies, then comes back | 16.5M / 67.9M |
| a post carrying only `quotedPostOwnerId`; a quote without its owner | refused 10422 `quoteOwner` | 0 |
| a quote with its owner | accepted | 250.8M |
| a like of one's own post | refused 10419 (`postAuthor` must differ) before broadcast | 0 |
| a like by someone else (untagged / four tags) | accepted, counted once (`byPost`, and under each tag) | 14.0M / 33.0M |
| a like of one's own reply | refused 40127 (`notEqual $ownerId`), a paid refusal | 0.9M |
| a reply like by someone else | accepted | 9.5M |
| `http://` media, website or avatar | refused 10101 (pattern) | 0 |
| `https://` and `ipfs://` media; a profile with an https website, a recipe avatar and an ipfs banner | accepted | 163.4M / 165.0M; 34.6M |
| the starter YAPP claim | accepted | 88.5M |
| a post paid in YAPP with the owner paying the gas (D4) | accepted: the writer paid 0 credits, the owner 162.8M (9.8¢), and the 10 YAPP burned (balance 100 → 90, total supply 90) | — |
| the owner minting, burning, freezing, unfreezing | refused 40701 (not authorized) | 0.8M each |
| the owner destroying frozen funds | refused 40703 (nothing can ever be frozen) | 0.8M |
| opening feed 1 (4096/4095), feed 2 with `carry`, feed 3 with `audience` and `label` | accepted | 29.5M / 25.0M / 23.6M |
| feed 1 again | refused 40105 | 0.8M |
| a follow request; a grant (first / later) | accepted | 53.3M; 75.9M / 52.9M |
| a second grant to the same follower in a feed | refused 40105 | 0.8M |
| a grant at leaf 4096, or at generation 4096, of a 4096/4095 feed | refused 40127 (the stored caps) | 0.9M |
| a grant at leaf 4095, generation 4095 | accepted | — |
| a grant without a follow request; into a feed that does not exist | refused 40120 | 0.9M |
| a rekey; a rekey revoking leaf 4096 | accepted 64.5M; refused 40127 | 0.9M |
| deleting a rekey or a feed | refused 10404 | 0 |
| a private post naming its feed / a private reply | accepted | 171.2M / 112.0M |
| a private post without `feed` | refused 10422 `private` | 0 |
| the private post's tombstone (clears `feed`) | accepted | refund 40.0M |
| "feeds I can read", "my newest grant from O", "O's feeds newest first" | each one indexed read | — |
| a report with reason 12; reason 32 | accepted 61.1M (incl. the 50M action fee); refused 10101 | 0 |
| the interim moderator resolving it | accepted | 4.6M |

Blog v9, storefront v10 and pollr v8 are recorded in [NON_SOCIAL_CONTRACTS.md](NON_SOCIAL_CONTRACTS.md) and [STOREFRONT_V10.md](STOREFRONT_V10.md).

## Registering it

Testnet registers the whole set fresh from the production maker (D2) with the WP1 publisher: `--plan`, `--dry-run`, `--signed-dry-run`, then `--live --production --journal`, always with `--interim notYetUsable --election-windows 3600,3600` (D1). The interim and windows are frozen into social, blog and storefront by that run, not by these files. The charters are filed the block after registration ([TESTNET_RELEASE.md](TESTNET_RELEASE.md)).

The offline plan for the production maker at its next nonce (`NETWORK=testnet … --plan --maker hbGEcFcX… --start-nonce 57 --interim notYetUsable --election-windows 3600,3600`) renders all three elected members with `notYetUsable` and 3,600/3,600 s, plans APP_ID `D8benQGn…` and GROUP_ID `4MjVAxDY…` (as before the cut: both depend on the maker and nonce only), social v17 at nonce 58 (`4nYYMMs9…`), and estimates the seven creates at 264.19e9 credits (≈15,851¢; social 92.90e9, storefront 61.97e9, blog 36.99e9, pollr 17.46e9) before the passkey vault joins.

## Private-feed client

The client for the shapes above (WP4a; design §5–§11 and PF1–PF9 in the release audit):

- **Crypto v2** (`lib/private-feed/crypto.ts`, labels `yappr/pf2/…`, every integer big-endian u16 but `keyId` u32): per-feed seed, CEK chain from the feed's **stored** `maxKeyGeneration`, heap-indexed LKH tree of the **stored** `treeCapacity` (R-M30), history key `H` and `carry`, grant payload v2 (`feed`, generation, leaf, path keys, CEK, `H`), and post/reply AAD bound to feed owner, feed, generation, nonce, author and kind. Fixed byte vectors and LKH revocation tests in `crypto.test.ts` (R-S11).
- **Keys** (`private-feed-key-store.ts`) per account and feed under `yappr:pf:` (`o:` the owner's seeds, `f:` a member's grant keys, `h:` a closed feed's final CEK and `H` from a carry walk); signing out clears that account's only.
- **Reads** (`private-feed-reads.ts`) through the indexes above, all served (the conformance spec has no private-feed allowlist any more); "feeds I can read" is the `recipient` index (D32), which also drives the approval and removal notifications (R-S14; a removal is the newest grant's leaf rekeyed, checked when the grant changes and at most every 10 minutes).
- **Owner** (`private-feed-service.ts`): feed 1 at 4096/4095 (PF2); every write syncs against the current feed and its newest generation first, rebuilding local keys when they disagree with the chain in either direction; a revocation not yet confirmed changes nothing locally.
- **Revocation keeps its grant.** Follow requests persist (PF8), so a deleted grant would leave the removed follower's request looking new on the owner's other devices. The grant stays as the record that the request was answered; a rekey of its leaf at a later generation is what marks it revoked, and only a request made after it asks again (the re-approval replaces the grant on the same leaf). A move skips revoked grants and the PF6 clean-up deletes the moved followers' old grants only; each removed follower's grant costs its ~1.9¢ refund until it is replaced.
- **Renewal and the move** (`private-feed-move.ts`, PF3–PF6b, PF9): "Moving your N followers costs about $X" (65M credits a grant, 35M the feed), "Bring your older private posts along?" (yes by default; a carry when the old seed opens), then every follower in force who still stands by their request is re-granted, follower *i* on leaf *i*. Private posting and approvals wait until it finishes (a removal goes through and drops that follower from the move); the job resumes after a reload (sign-in) or from Settings, and a move no device finished is found on the chain. Without the old secret (the owner's encryption key changed, PF5) the new feed has no link and the old grants stay.
- **Followers**: Leave deletes the request (no more carrying); statuses `approved`, `approved-no-keys`, `renewing`, `pending`, `revoked`, `none`.
- **Reading** (`private-feed-reader.ts`): one path for posts, replies, quotes and previews: local keys of that feed, else a grant of exactly that feed, else a walk back through the carries from the newest feed this viewer opens. A reply goes into the root owner's **current** feed.
- **Report box v2** (`lib/report-box.ts`): payload `feedOwnerId ‖ u16 feed ‖ u16 generation ‖ CEK`; moderators read that feed up to that generation and no other feed (D12).

## What WP4 still has to do

- **Byte-aware counters** for the new `maxBytes` (profile location, pronouns and avatar; report note and resolution; blog name, description, title, subtitle and comments): the contract refuses an over-long value after signing. The mobile app's like button and profile editor need the same self-like and https gates as the web.
- **Scripts, e2e, seeder and mobile** on the release shapes, listed in the release audit's `battery-adaptation-v17.md`: the live batteries' timeline and private-feed cases and a self-like (`verify-v10`), the YAPP funding helpers that owner-mint (`battery-lib`, `seed/provision-seed-identities`, `seed/feature-seed-lib`: v17 lets no one mint), `prove-merged-counts` (c5, lv-7), `verify-blog` (live, drafts), `verify-storefront` (plaintext note), `surface-cleanup` (blog live pin, the pollr owner read), and the blog, storefront and pollr seeders. The mobile engine shares `lib/`'s builders, so it needs a rebuild only.
- **Store and blog report UI**: the plumbing is in place (`moderatedContract(key).reportTargets()`, `reportsResolved()`, `deletableTypes()` gated to storefront v10 and blog v9).
