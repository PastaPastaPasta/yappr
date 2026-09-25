# Social v8, blog v3, storefront v3 — the 4.2.0-beta.3 cuts

> **Historical record.** Superseded social cuts, their generators
> (`build-vN-contract.py`) and their batteries (`verify-v4/v5/v7.mjs`) were
> removed from the tree; the files this page names are in git history. The
> live social contracts are v2 (testnet) and v9 (moutai), see
> [`contracts/README.md`](../contracts/README.md).

Platform 4.2.0-beta.3 (protocol version 14, 33 commits over beta.2) ships a
contract grammar none of Yappr's live contracts can gain by `dataContractUpdate`:
contract moderation, moderator deletion, deletable references, action fees, optional
token costs with owner-paid gas, and a once-per-identity token grant. These are
fresh registrations, built from the beta.2 cuts by deterministic scripts, and
deployed to the moutai devnet by the deploy PR (`beta3/devnet-deploy`), which owns
the ids in `.env.devnet`.

The SDK/ids half of the upgrade — the beta.3 package pin, nonce-committed document
ids (#4859), the manual create path — is PR A (`beta3/sdk-and-ids`). This document
covers PR B: the contracts, their batteries, the client plumbing and — once PR A
merged — the [write path](#the-write-path) that carries v8's action fee
agreements and its choice between YAPP and credits.

## The grammar, and where it is verified

| Feature | Platform PR | Contract keyword | Read/write surface (evo-sdk beta.3) | Battery case |
| --- | --- | --- | --- | --- |
| Contract moderation | #4830 #4849 #4857 #4864 | `config.moderation {banlist, suspensions, moderators}` (config `$formatVersion` **"2"**) | `contracts.banUser/unbanUser/suspendUser/unsuspendUser`, `moderationStatus`, `moderationEntries` | v8 m1 m2; blog b13; storefront s14 |
| Moderator delete | #4857 | `canBeDeletedByModerators: true` per doctype (optional `…For` window, not used) | `contracts.moderatorDeleteDocument`, `documentRemovals` | v8 m3; blog b14–b16; storefront s15–s16 |
| Deletable references | #4860 | `refersTo.type: deletableDocument` | joins report `missingIds` / `missingOuterIds` | v8 m3 (40120 on a dead ref, clear-only replace) |
| Action fees + pots | #4851 #4856 #4858 | `actionFees {pricing, create: {moderators}}` | `$actionFeeAgreement` on the transition; `contracts.feePots`, `claimFees` | v8 a1–a4 |
| Optional token cost + owner gas | #4826 #4828 | `tokenCost.create.optional: true`, `gasFeesPaidBy: 2` | `$tokenPaymentInfo.gasFeesPaidBy` | v8 t1 t2 |
| Once-per-identity grant | #4827 | `distributionRules.oncePerIdentityDistribution {amount}` (rules `$formatVersion` **"1"**) | `tokens.claim({distributionType: 'oncePerIdentity'})` | v8 g1 |
| Nonce-committed ids | #4859 | — | `sdk.documents.create` returns the real id; a manual batch derives it | v8 a3 |

Consensus codes the client and the batteries key on: 41107 banned, 41108 suspended,
41110 appointed moderator does not exist (at registration), 41111 pot already claimed
this epoch, 41112 nothing to claim, 41115 type not moderator-deletable, 41116
moderation window elapsed; 40120 referenced entity not found (a dead deletable ref),
40122 permanentDocument at a deletable type (registration), 40131 deletableDocument at
a non-deletable type (registration); 40132/40133/40134 action fee agreement not set /
mismatched / multiplier not tolerated; 40115 required token payment missing, 40129
gas payer not offered, 40130 inconsistent gas payer in a batch, 40222 sponsor short of
credits, 40700 insufficient token balance; 40722 grant already claimed; 10902
`moderators` fee part on an unmoderated contract.

## Social v8 (`contracts/yappr-social-contract-v8.json`)

Generated from v7 by `scripts/build-v8-contract.py` (`--self-test` asserts the
committed JSON is a fresh build and pins every decision below). The read surface is
v7's: every index, terminal, ranked axis and `timeRange` window is unchanged, so the
whole client read path and `docs/V6_WINDOWED_RANKINGS.md` carry over.

### Exact diff against v7

1. `config.$formatVersion` `"1"` → `"2"`; `config.moderation = { banlist: true,
   suspensions: true, moderators: { $type: "contractOwner" } }`. Which lists a contract
   keeps is fixed at creation; both are on. The committed JSON names the owner as the
   only moderator; the registration scripts take `--moderators <id,id>` to appoint
   identities at publish time (each must exist on chain — 41110 otherwise — so the
   publisher fetches them before signing).
2. `post` and `reply`: `canBeDeletedByModerators: true`, no window. Owners still
   `canBeDeleted: false` (their delete is the tombstone replace); moderators delete
   outright, leaving a removal record.
3. Every reference at `post`/`reply` — `like.postId`, `likeReply.replyId`,
   `beat.postId`, `repost.postId`, `bookmark.postId`, `post.quotedPostId`,
   `post.quotedReplyId`, `reply.rootPostId`, `reply.replyToReplyId` — is
   `type: deletableDocument`; `propertyAgreement`s unchanged. `preallocated` is
   removed from `like.byPost`, `like.byHashtagPost`, `like.byAuthorPost` and
   `likeReply.byReply` (preallocation needs `permanentDocument`). A `terminal` on an
   indexOnly type accepts a deletableDocument reference (meta-schema, and the offline
   parse of the cut).
4. `tokenCost.create` on `post` (10), `reply` (3), `like` (1), `likeReply` (1),
   `repost` (1): `optional: true`, `gasFeesPaidBy: 2` (PreferContractOwner).
5. `tokens.0.distributionRules.$formatVersion` `"0"` → `"1"`;
   `oncePerIdentityDistribution = { "$formatVersion": "0", "amount": 100 }`.
   Registering a token with this rule carries a **+0.1 DASH surcharge**.
6. `post.actionFees = { pricing: "feeMultiplier", create: { moderators: 80000000 } }`
   (~$0.05 at $60/DASH; 1 DASH = 1e11 credits), `reply.actionFees.create.moderators =
   16000000` (~$0.01). No `owner` part anywhere (a sponsored action never pays it and
   the pot is for the moderation team), nothing on any other type or action.
7. Descriptions of `post`/`reply` mention the moderator removal.

Everything else — immutable lists, `$ownerId` agreements, indexes, TTLs, the token's
supply and rules — is byte-identical to v7.

### Semantics the client relies on

- **A moderator-removed post is ABSENT.** A fetch returns nothing; a composite by-id
  join lists the id in that sub-result's `missingIds` (chained: `missingOuterIds`),
  matched **by id, never by position**; the like entries at it stay; a write naming
  it is 40120. The only trace is the removal record (`documentRemovals`: owner,
  moderator, reason, block time), which nothing ever deletes, and the id can never be
  created again.
- **A replace re-validates every deletable reference**, touched or not. A tombstone
  of a post quoting a removed post must CLEAR `quotedPostId` (the one change the
  `immutable` check lets through for a dead deletable ref); one that keeps it is
  40120. `lib/services/tombstone-helpers.ts` does this on a 40120 retry
  ([write path §3](#3-tombstoning-a-quote-of-a-removed-post)).
- **Free usage.** The owner pays gas ONLY when the user pays in tokens: a create WITH
  `$tokenPaymentInfo` charges YAPP and the owner pays its gas when their balance
  covers gas + fees (else it falls back to the signer); a create WITHOUT payment info
  charges credits as an unpriced action and is never sponsored. Payment info present
  with insufficient YAPP is 40700, never a credits fallback — the client chooses
  before signing (`lib/payment-preference.ts`).
- **Action fees are agreed, not discovered.** A `post`/`reply` create must carry
  `$actionFeeAgreement` naming the exact declared amounts and, for `feeMultiplier`
  pricing, the multiplier the signer knew plus a tolerance. Whoever pays the gas pays
  the fee (the owner when sponsoring); the owner never pays the `owner` part, which is
  one more reason it is omitted.
- **No preallocation.** Ranked like pages carry no zero-count groups any more, so the
  homepage stops over-asking (`likeCountsArePreallocated()` is false from v8).

### Client plumbing in this PR

- `lib/constants.ts`: `CONTRACT_TOPOLOGIES` appends `'v8'`; `NEXT_PUBLIC_CONTRACT_TOPOLOGY=v8`.
- `lib/contract-topology.ts`: `V8_DESCRIPTOR` (v7's read surface) and grammar helpers
  read off the committed JSON, pinned in `lib/contract-topology.test.ts`:
  `contractIsModerated`, `referencesMayDangle`, `likeCountsArePreallocated`,
  `moderatorDeletableTypes`, `tokenCostFor(docType)` → `{amount, optional,
  gasFeesPaidBy}`, `declaredActionFee(docType, action)` → `{owner, moderators,
  pricing}`, `starterGrantAmount()`.
- `lib/services/moderation-service.ts`: wraps `contracts.*` moderation, removals, pots
  and claims; `isModerator` reads the team off the contract config;
  `isBarredFromContractError` (41107/41108).
- UI: `components/settings/contract-moderation-settings.tsx` (ban/suspend-until/
  unsuspend with reason, both lists, removal records, moderators pot + claim; shown to
  the moderation team beside the token authority's YAPP freeze/slash), a
  "Remove post/reply (moderator)" post-menu item with `moderator-remove-modal`, a
  `RemovedPostStub` (feed card, quote embed, thread root, post page) resolving the
  reason lazily, and `barred-writer-notice` on refused compose/like/repost.
- Read path: `composite-feed-page` marks `quotedPostRemoved` from the join's
  `missingIds`; `use-quoted-post` short-circuits on it; `use-post-detail` returns
  `removedChainIds`; ranked hydration stops warning about absent ranked ids on v8.
- Starter grant: `tokenService.claimStarterGrant` (40722 → `ALREADY_CLAIMED`) and
  `StarterGrantModal`, prompting a zero-balance identity once (settled in scoped
  storage on a claim or a 40722).
- Chooser: a `payWith: 'yapp' | 'credits'` setting (default `yapp`) and
  `lib/payment-preference.ts` → `PaymentPlan {payWith, yapp, gasFeesPaidBy,
  gasMayBeSponsored, actionFee, fallbackReason}`, shown by
  `components/compose/payment-hint.tsx` and turned into the transition's options
  by `lib/transition-agreements.ts` (see [the write path](#the-write-path)).

## Blog v3 (`contracts/yappr-blog-contract.json`, in place)

Same `config` block (moderation, both lists, owner moderates). `blog`, `blogPost` and
`blogComment` carry `canBeDeletedByModerators: true`; `blogPost.blogId`,
`blogComment.blogPostId` and `blogFollow.blogId` are `deletableDocument` references.
`documentsKeepHistory` is REMOVED from `blog` and `blogPost` — Drive refuses moderator
deletes on a history-keeping type — so the edit-history feature is gone
(`components/blog/blog-post-history.tsx` deleted; an edited post just says "edited").
`canBeDeleted: false` stays where it was. Gate: `NEXT_PUBLIC_BLOG_TOPOLOGY=v3`
(`blogIsV2()` is true on v2 and v3).

## Storefront v3 (`contracts/yappr-storefront-contract.json`, in place)

Same `config` block. `storeReview` and `itemReview` carry `canBeDeletedByModerators:
true`; nothing references a review, so there is no cascade and no read change. Gate:
`NEXT_PUBLIC_STOREFRONT_TOPOLOGY=v3` (`storefrontIsV2()` is true on v2 and v3).

DM v4, pollr v4, profile, key backup, key exchange, vault and auth vault are unchanged
(republished as-is after the wipe).

## Validation

```
python3 scripts/build-v8-contract.py --self-test
node scripts/validate-contract-offline.mjs contracts/yappr-social-contract-v8.json
node scripts/validate-contract-offline.mjs contracts/yappr-blog-contract.json
node scripts/validate-contract-offline.mjs contracts/yappr-storefront-contract.json
node scripts/register-social-v3-draft.mjs --dry-run [--moderators <id,id>]
node scripts/register-feature-contract.mjs --file yappr-blog-contract.json --dry-run
node scripts/verify-v8.mjs --self-test
node scripts/verify-blog.mjs --self-test
node scripts/verify-storefront.mjs --self-test
node scripts/seed/run-seeder.mjs --self-test
```

The offline validator (beta.3 wasm) accepts all three cuts under FULL validation,
reports the parsed `moderation`, and refuses a `permanentDocument` reference at a
moderator-deletable type. Probed negatives: `preallocated` on a deletable-referenced
index is refused ("its path is not determined by a reference"); `actionFees.moderators`
/ `canBeDeletedByModerators` without `config.moderation` is refused. A
`$formatVersion: "1"` config silently DROPS `moderation` on parse, which is why the
cuts carry `"2"` and the registration audit reads the moderation back off the parsed
contract.

Live (deploy PR, never against a devnet being wiped):

```
NETWORK=devnet node scripts/register-social-v3-draft.mjs --maker --moderators <ids> --fund <botA,botB>
NETWORK=devnet node scripts/verify-v8.mjs --contract <id> [--moderator maker|bot:<n>] [--poor 2]
NETWORK=devnet node scripts/verify-blog.mjs --contract <id> --moderator <ownerPersona>
NETWORK=devnet node scripts/verify-storefront.mjs --contract <id> --moderator <ownerPersona>
```

`verify-v8` builds `post`/`reply` creates as manual batches (the only way to carry an
agreement today — `sdk.documents.create` has no option for one), derives the
nonce-committed v1 id with the SHIPPED helper and compares it to the id the proof
result names (case a3) — the live proof of the derivation the client needs.
Every other id is read from the create result.

## The write path

Implemented on this branch once PR A (`beta3/sdk-and-ids`) landed. Every number
below is READ off `contracts/yappr-social-contract-v8.json` at runtime — by
`declaredActionFee`/`tokenCostFor` in the client and `actionFeeFor` in the
scripts — so nothing here is transcribed: a wrong amount is a paid 40133, and a
battery asserting against a transcription would prove nothing.

### 1. The action fee agreement

`createDocument` builds `$actionFeeAgreement` whenever the configured topology
prices the (documentType, 'create') pair — v8: `post` 80M, `reply` 16M credits
to the moderators pot, `feeMultiplier` pricing, no owner part:

```ts
new DocumentActionFeeAgreement({ owner: 0n, moderators: 80_000_000n,
  feeMultiplier: { knownPermille, increaseTolerancePercent: 20 } })
```

built by the pure `actionFeeAgreementOptions` in `lib/transition-agreements.ts`
and passed as `actionFeeAgreement` in the `DocumentCreateTransition` options.
`knownPermille` is `(await sdk.epoch.current()).feeMultiplierPermille`, read
once per session and cached; a failed epoch read agrees at `1000n` rather than
sending no agreement (40132 is certain without one, 40134 unlikely at 1.0x with
a 20% tolerance). A 40134 clears the cache, so the next write re-reads it.
`fixed` pricing would name no multiplier at all — naming one is the same 40133 —
and the agreement is part of the signed bytes, so the cached-ST replay path
replays it verbatim.

Replace and delete consult the same descriptor and **throw before signing** if
an action they cannot carry an agreement for is ever priced: the facade's
`DocumentReplaceOptions`/`DocumentDeleteOptions` have no agreement field, so a
priced tombstone would be a paid 40132 rather than a caught bug. v8 prices
nothing but `create`, and `lib/contract-topology.test.ts` pins that across every
doctype so a future cut cannot silently under-wire this.

### 2. Token or credits, chosen before signing

`resolveTokenPayment` no longer auto-attaches: it asks
`planPaymentForViewer(documentType, balance)` and turns the plan into a bag with
`tokenPaymentOptions`.

| Plan | What the create carries |
| --- | --- |
| `payWith: 'yapp'`, balance ≥ cost (v8) | `TokenPaymentInfo { tokenContractPosition: 0, maximumTokenCost, gasFeesPaidBy: 2 }` |
| `payWith: 'credits'`, or balance < cost, or the balance read failed (v8) | **no `tokenPaymentInfo` at all** — that is what makes an `optional` cost charge credits |
| Any priced type before v8 | `TokenPaymentInfo { tokenContractPosition: 0, maximumTokenCost }` — required, no gas offer |
| Blog comment / storefront review (any cut) | `TokenPaymentInfo { paymentTokenContractId: <social>, … }` — cross-contract and required; neither contract declares `optional` |

`2` is PreferContractOwner, the offer the type makes, and it is read from the
doctype's own `tokenCost.gasFeesPaidBy` — not inferred from whether the type
charges an action fee, which is an independent property. `1` (ContractOwner,
insisting) is never requested — the type does not offer it and insisting is
40129 — and a batch is one transition here, so 40130 cannot fire.

The balance is read only when the answer can change the plan: paying YAPP on an
optional cost. A user set to `credits`, and any required cost, costs no balance
round-trip at all — which matters because on v8 `like` and `repost` are priced
too, and they are the latency-sensitive writes. A read that FAILS plans credits,
so an unknown balance can never become a 40700; a read that succeeds but is
STALE still can (Platform reads lag writes, two tabs plan against one balance,
and the cached-ST replay re-sends a payment verbatim). That surfaces as
insufficient-YAPP, and where the contract prices optionally the message says the
user can switch to credits instead of only offering to sell them more.

### 3. Tombstoning a quote of a removed post

A replace re-validates every `deletableDocument` reference, touched or not, so a
tombstone that keeps a `quotedPostId` a moderator has since removed is 40120,
while clearing it is the one change to an `immutable` property consensus allows
(`document_replace_transition_action/state_v1`: `cleared_a_dead_reference`).
`tombstoneDocument` therefore retries on 40120 with **exactly the property the
rejection names** dropped — Drive's message carries it (`… not found for path
quotedPostId`), and `clearableReferencesFor` says which properties the contract
lets go: the OPTIONAL `deletableDocument` references, `post.quotedPostId`,
`post.quotedReplyId` and `reply.replyToReplyId`.

Dropping every clearable reference instead would be wrong, because the immutable
check judges each removed property on its own: clearing one whose target is
still alive is a 40128. A post may carry both quote fields (nothing forbids it),
and a reply under a removed root has a required `rootPostId` — not clearable at
all — beside a possibly live `replyToReplyId`. So a rejection naming a property
the contract freezes for good, or one whose path cannot be read, is reported
rather than guessed at; two dead references are cleared one rejection at a time.
`quotedPostOwnerId` is not a reference and stays. v7 and earlier retry nothing:
there, nothing a post points at can disappear.

### 4. Error surfaces

`isBarredFromContractError` (41107/41108, the SIGNER barred) now lives in
`lib/error-utils.ts` — `moderation-service.ts` had a second copy — and
`isModerationBarredError` builds on it, so the UI never claims 41114 (where the
OTHER party is barred) as the viewer's own standing; `reportBarredWrite`
resolves the ban or suspension reason through `moderationService.getStanding`.
Two codes were split out of their families because they are not what the family
says: **40222** is a short gas sponsor (the user can act on it — pay in
credits), not the client asking for a payer the type refuses, and **40134** is a
moved fee multiplier, not an app out of date with the fee rules. Both stay
permanent for the transition as built, so `retryPostCreation` refuses the whole
40129/40132–40134/40222/41107/41108 set — pinned by `lib/retry-utils.test.ts`.

### 5. Seeders and batteries

`sdk.documents.create` **cannot** carry an agreement: `DocumentCreateOptions` is
`document` / `identityKey` / `signer` / `tokenPaymentInfo` / `settings`, and
`PutSettings` is transport and nonce staleness only. (The underlying
`DocumentCreateTransitionOptions` does take one — it is the facade that has no
field for it.) So on a v8 contract every post/reply create is a hand-built batch
— `createWithAgreement` in `seed-lib.mjs` (nonce → derived v1 id → transition
with agreement and payment → sign → broadcast and wait → refresh the facade's
now-stale nonce cache, which takes an `Identifier` and throws synchronously),
returning `{ id }` so callers' `createdId` acceptance logic is unchanged.
Unpriced creates keep the facade path.

`--topology v8` shares v7's document shapes byte for byte; what differs is what
a create carries. `--credits-fraction` (default 0.25 on v8) puts that share of
actors on the credits path and the rest on YAPP with the gas offered to the
contract owner; the currency is a pure function of the persona index, so a
resume never moves an author between funding models, and the YAPP estimate
excludes the credits actors. `verify-v8.mjs` builds its agreements, its YAPP
payment and its id derivation with those same helpers, so a live run proves the
shape the app sends. pollr's caption post lives on the social contract and gets
the same treatment.

### Validating the write path

```
npx tsc --noEmit && npm run lint && npm run lint:dead && npx vitest run
npm run build:devnet
node scripts/verify-v8.mjs --self-test
node scripts/seed/run-seeder.mjs --self-test
NETWORK=devnet node scripts/seed/seed-non-social.mjs --which pollr --self-test
```

### What the first live run on moutai must prove

In this order, against a freshly registered v8 contract — the first three decide
whether the client is sending the right bytes at all:

1. **A post from the browser lands.** It proves the agreement, the derived id
   and the nonce all agree with what Drive recomputes. `verify-v8` a3 proves the
   same shape from Node and additionally compares the locally derived id with
   the one the proof result names.
2. **The moderators pot grew by `80_000_000 × multiplier ‰`** for that post and
   16M for a reply (a3 c/e). A pot that did not move means the fee was not
   charged and the agreement was ignored — the numbers are wrong somewhere.
3. **A post with the payment chooser on `credits` charges credits and no YAPP**,
   and one on `yapp` charges 10 YAPP while the CONTRACT OWNER's credit balance
   moves (t1 b/d/e). Sponsorship is the one behaviour no offline test can reach.
4. **A create with payment info and too little YAPP is refused 40700** (t2), not
   silently charged credits — the client must have chosen before signing.
5. **A tombstone of a quote whose target was moderator-removed** is refused with
   the reference kept and lands with it cleared (m3 e/f) — the live form of the
   retry in §3.
6. **A banned identity's write is refused 41107 and its delete still lands**
   (m1), and the compose surface shows the recorded reason rather than an offer
   to buy YAPP.

A seeded run afterwards should show both currencies in use: the credits actors'
posts carry no token payment (their YAPP balance never moves) while the rest
spend YAPP and leave the owner paying their gas.

## Follow-ups outside the write path

- Feature-contract moderation UI (blog v3, storefront v3) — the service is social-only.
- `moderationEntries`/`documentRemovals` are paged at 100; the settings panel shows
  the first page.
- `canBeDeletedByModeratorsFor` (a takedown window) was deliberately NOT declared;
  it would require `$updatedAt` in `required` and is fixed at type creation.
