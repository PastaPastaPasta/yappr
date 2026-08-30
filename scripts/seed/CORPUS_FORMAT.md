# Seed corpus format

The devnet content-seeding pipeline is driven by two files, produced by a
corpus generator and consumed by `provision-seed-identities.mjs` (personas) and
`run-seeder.mjs` (personas + corpus). Both are parsed and fully validated by
`seed-lib.mjs` (`loadPersonas`, `parseCorpus`) before anything touches the
network — a generator bug fails fast at parse time, never as an on-chain
consensus error mid-run.

## `personas.<name>.json`

A JSON array of persona objects:

```json
[
  {
    "idx": 0,
    "handle": "quantumdasher7",
    "displayName": "Quantum Dasher",
    "bio": "Chasing blocks and good coffee.",
    "location": "Lisbon",
    "website": "https://example.com",
    "avatarSeed": "quantumdasher7-a3f1",
    "style": "enthusiastic, short sentences, occasional emoji",
    "interests": ["dash", "photography", "synthwave"],
    "activity": 0.8
  }
]
```

| field | required | constraints |
|---|---|---|
| `idx` | yes | unique non-negative integer; corpus ops reference personas by this |
| `handle` | yes | the DPNS label: charset `[a-z0-9-]`, 3–19 chars, no leading/trailing hyphen, **must contain at least one digit 2–9** (a label with a 2–9 digit can never match DPNS's contested-name pattern, so registration never enters a masternode vote) |
| `displayName` | yes | 1–50 chars (unified profile contract `displayName.maxLength`) |
| `bio` | no | ≤ 160 chars |
| `location` | no | ≤ 50 chars |
| `website` | no | ≤ 200 chars, must match `^https?://.+$` |
| `avatarSeed` | yes | any short string; the provisioner stores the profile `avatar` field as `{"seed":<avatarSeed>,"style":<dicebear style>}` with the style derived deterministically from the seed |
| `style` | generator-only | free-text writing-style hints for the corpus generator; not written on chain |
| `interests` | generator-only | topic hints for the generator; not written on chain |
| `activity` | generator-only | relative activity weight (e.g. 0–1) for the generator; not written on chain |

Profile field limits are validated against the checked-in
`contracts/yappr-profile-contract.json` (the unified profile contract the app
reads), not hardcoded.

## `corpus.<name>.jsonl`

One JSON object per line, executed in line order (per author strictly
sequentially; across authors, only ref availability orders execution). Every
`ref` is a corpus-local symbolic name; **all refs must be defined on an earlier
line than any use**. This makes the dependency graph acyclic by construction —
the executor cannot deadlock.

### Op types

```json
{"type":"post","ref":"p001","author":0,"content":"gm #dash","hashtag":"dash"}
{"type":"post","ref":"p002","author":1,"content":"look","hashtag":"","mediaUrl":"ipfs://bafy…","sensitive":true}
{"type":"quote","ref":"p003","author":2,"content":"this → {{link:p001}}","quotedRef":"p001","hashtag":""}
{"type":"reply","ref":"r001","author":1,"rootRef":"p001","parentRef":"p001","content":"same"}
{"type":"reply","ref":"r002","author":0,"rootRef":"p001","parentRef":"r001","content":"nested"}
{"type":"like","author":2,"targetRef":"p001"}
{"type":"likeReply","author":0,"targetRef":"r001"}
{"type":"repost","author":2,"targetRef":"p002"}
{"type":"follow","author":0,"target":1}
{"type":"bookmark","author":1,"targetRef":"p003"}
```

| type | fields | maps to (v4 social contract) |
|---|---|---|
| `post` | `ref`, `author`, `content`, `hashtag`, `mediaUrl?`, `sensitive?` | `post` — `author` = owner id bytes (poster-attested), `language` always `"en"` |
| `quote` | `ref`, `author`, `content`, `quotedRef`, `hashtag`, `mediaUrl?` | `post` with `quotedPostId` + `quotedPostOwnerId` resolved from the ref map |
| `reply` | `ref`, `author`, `rootRef`, `parentRef`, `content`, `mediaUrl?` | `reply` — `rootPostId` from `rootRef`; `parentOwnerId` = owner of `parentRef`; `replyToReplyId` set iff `parentRef` is a reply |
| `like` | `author`, `targetRef` (post) | indexOnly `like` `{postId, hashtag, postAuthor}` — `hashtag`/`postAuthor` **copied from the target post's recorded values** (propertyAgreement: a mismatch is consensus error 40127) |
| `likeReply` | `author`, `targetRef` (reply) | indexOnly `likeReply` `{replyId, replyAuthor}` |
| `repost` | `author`, `targetRef` (post) | `repost` `{postId, postOwnerId}` |
| `follow` | `author`, `target` (persona idx) | `follow` `{followingId}` |
| `bookmark` | `author`, `targetRef` (post) | `bookmark` `{postId}` |

### Field rules

- `author` / `follow.target`: a persona `idx`. Self-follow is invalid.
- `hashtag`: required on `post`/`quote`; must match `^$|^[a-z0-9_]{1,63}$`.
  `''` is the untagged sentinel (the contract requires the field).
- `content`: `language` is always `"en"`. May contain `{{link:REF}}`
  placeholders, where `REF` must be an **earlier post/quote ref**; the executor
  replaces each with `https://yap.pr/devnet/post/?id=<realPostId>`. The
  validator budgets 44 chars for the id (worst-case base58 of 32 bytes) and
  rejects any line whose expanded content could exceed 500 chars.
- `mediaUrl`: optional, ≤ 512 chars, must match `^(https?|ipfs)://.+$`.
- `sensitive`: optional boolean (posts only).
- Duplicate interactions (`like`/`likeReply`/`repost`/`bookmark`/`follow` with
  the same author + target appearing twice) are rejected at parse time — on
  chain they would only burn a state transition into consensus error 40105.

### Ref map

The executor materializes each `ref` into `{kind, id, ownerId, hashtag}`
(base58 document id, base58 owner identity id, the post's hashtag) and
checkpoints the map in `.seed-progress.local.json`, so likes created on a
resumed run still carry the exact propertyAgreement values of the original
post.

### Token costs (why the generator's op mix matters)

Creates are token-priced on the v4 contract: post/quote **10 YAPP**, reply
**3**, like/likeReply/repost **1**, follow/bookmark/profile **free**.
`run-seeder.mjs` prints the total and per-author worst case before executing;
`provision-seed-identities.mjs --yapp <n>` funds each identity.
