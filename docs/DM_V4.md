# DM contract v4

Registered on moutai 2026-09-17 as `BSLkjKCbqCs4S7nUAYz9io658Pv3fEcUXWwTudfhZbef`
(a throwaway battery registration owned by a seed persona; the deployment maker
can re-publish the same JSON when the next full re-provision happens). Built by
`scripts/build-dm-v4-contract.py` from the deployed v3 file, published by
`scripts/register-feature-contract.mjs`, verified live by
`scripts/verify-dm-v4.mjs` (25 checks, all passing). Protocol 14, Platform
4.2.0-beta.1 or later.

## What changed and why

**DMs must stay cheap.** That constraint, not a lack of ideas, is what makes
this the smallest re-cut in the set: two additive flags, no new doctypes, no
ranked or timeRange indexes, no indexOnly rewrite, no token costs, and
`readReceipt` untouched. A message write costs what it cost on v3 plus the one
extra count-tree branch the `countable` flag maintains.

| Doctype | v4 change | Serves |
| --- | --- | --- |
| `conversationInvite` | `recipientId` refersTo `{type: identity}` | a ghost recipient is refused at write time (40120) instead of becoming a permanently undeliverable inbox row |
| `directMessage` | `conversation [conversationId, $createdAt]` gains `countable` + `rangeCountable` | per-conversation totals and "unread since my read receipt" as O(1) counts |
| `readReceipt` | none | — |

v3 paid for the unread badge with bandwidth: the conversation list downloaded a
100-message page **per conversation** and counted in JS, decrypting nothing but
transferring every ciphertext. v4 fetches one message per conversation (the
preview) and asks the count tree for the rest.

The client selects the topology with `NEXT_PUBLIC_DM_TOPOLOGY=v4`
(`DM_TOPOLOGY` in `lib/constants.ts`). Unlike the storefront switch this one
changes **reads only** — v4 writes are byte-identical to v3 writes — so a
mismatched switch degrades unread accuracy or performance, it does not get
anything rejected by consensus. `v3` remains the default and its code path is
untouched.

## Query shapes that serve, verified live

```js
// Total messages in a conversation.
sdk.documents.count({ dataContractId, documentTypeName: 'directMessage',
  where: [['conversationId', '==', C]] })

// Unread: everything after the viewer's read receipt ($updatedAt). One call.
sdk.documents.count({ dataContractId, documentTypeName: 'directMessage',
  where: [['conversationId', '==', C], ['$createdAt', '>', lastReadAt]] })

// Totals for the whole list in one call — NO range clause (see below).
sdk.documents.count({ dataContractId, documentTypeName: 'directMessage',
  where: [['conversationId', 'in', [C1, C2]]], groupBy: ['conversationId'] })
```

`conversationId` is a plain 10-byte array, not an identifier, so query operands
are **base64** (`bytesToBase64QueryOperand`), and grouped-count result keys are
the **hex** of those bytes.

Page budgets after the client migration (cold load, DAPI requests, N
conversations):

| Surface | v3 | v4 |
| --- | --- | --- |
| `/messages` conversation list | 2 invites + N × 100-message pages + ⌈N/100⌉ receipts | 2 invites + N × 1-message previews + ⌈N/100⌉ receipts + ≤ N counts (6 at a time) |
| bytes moved for the list | every ciphertext in the newest 100 messages of every conversation | one ciphertext per conversation |
| global unread badge | did not exist (unaffordable) | the same shape, on the existing 30 s notification poll |

## Unread is not exactly v3's unread

The `conversation` index carries no `$ownerId`, so a count cannot exclude the
viewer's **own** messages the way v3's JS filter (`m.$ownerId !== userId`) did.
Two things keep the number honest:

- a conversation whose newest message is the viewer's own reports **0** unread —
  they are the last speaker, so there is nothing newer for them to read — and
  the count query is skipped entirely;
- otherwise the count can exceed the true unread by the number of messages the
  viewer sent since their last read **receipt**, which the app writes when it
  opens a conversation, i.e. immediately before any message they send from it.

Adding an `$ownerId` axis would mean a second index branch on every message
write. That is the cost DMs are not allowed to pay. Note that v3 has its own
version of this: with read receipts disabled in settings no receipt exists, so
`lastReadAt` is 0 and both topologies count the whole conversation.

## Global unread badge

`directMessageService.getUnreadTotal(userId)` sums the per-conversation unread
and feeds `dmUnreadCount` in the notification store, which the Messages entry in
`components/layout/sidebar.tsx` and `components/layout/mobile-bottom-nav.tsx`
render. It rides the **existing** 30 s notification poll in the sidebar — there
is deliberately no second timer — and never decrypts or resolves participant
identities, because prompting for a private key from a background poll would be
wrong. On `v3` it returns 0 before issuing any request, so the badge stays
hidden rather than costing a message page per conversation per poll.

## Registration gotchas found on the way

1. **`IN` + a range in one grouped count returns an EMPTY map, not an error.**
   `count(conversationId in [C1, C2], $createdAt > t) groupBy conversationId`
   is served on the no-proof path only; on the proved path it answers with no
   groups at all (battery case `d6b`). A silent zero is worse than a rejection,
   so the client never uses this shape — per-conversation range counts with
   `mapLimit(…, 6)` instead. The IN-only grouped count (no range) **is** proved
   and correct.
2. **A contract-bound ENCRYPTION key cannot be pre-registered.** See below.
3. Spell `countable` and `rangeCountable` out literally rather than relying on
   meta-schema sugar — same reason as `docs/STOREFRONT_V2.md` gotcha 1.
4. The battery is re-runnable only because conversation ids are salted per run.
   `conversationInvite.senderAndRecipient` is unique on `[$ownerId, recipientId]`
   with no `conversationId`, so a pair gets exactly **one** invite ever; the
   invite cases are idempotent instead of re-creating it.

## Contract-bound encryption keys: re-tested, still unusable

`lib/services/identity-update-builder.ts` carries a note saying contract-bound
encryption keys are "disabled due to SDK/tooling bugs". Battery case `d7`
re-tested that on beta.1: it registers an ENCRYPTION key with
`contractBounds: SingleContract(<dm v4>)` on a seed persona through an identity
update signed with that identity's MASTER key.

**It does not work — but the note misattributes the cause.** Drive answers:

```
storage: contract: key bounds expected but not present error:
expected encryption key bounds for encryption
```

That is a **consensus rule, not an SDK bug**: a `SingleContract`-bounded
ENCRYPTION key is only accepted against a contract that itself declares
`requiresIdentityEncryptionBoundedKey`. Which makes it a chicken-and-egg — the
contract cannot require bounded keys until every identity already holds one, and
no identity can register one until the contract requires it. A deployment would
have to cut the contract and migrate every user's keys in the same step.

This is exactly why v4 leaves `requiresIdentityEncryptionBoundedKey` and
`requiresIdentityDecryptionBoundedKey` **unset**: turning either on would break
DMs for every existing identity on the day of the cut. The probe is reported by
the battery and never fails it, since nothing in v4 depends on the outcome.

## Not in v4

- Token costs on `conversationInvite` or `directMessage` (cheap by directive).
- Ranked indexes, `timeRange`/`ttl`, an ephemeral `presence`/`typing` doctype,
  or an indexOnly rewrite — all listed in
  `docs/NON_SOCIAL_OPPORTUNITIES.md` §3.6, all deferred for the same reason.
- `refersTo: identityPublicKey` on the invite: `senderPubKey` is the *sender's*
  raw key bytes and the invite names no key id, so there is no
  `keyIdProperty` to bind. It would need a schema change, not a flag.
- A `countable` flag on `conversationInvite.inbox` (a "new conversations since
  t" badge); not needed by any current surface.
- Excluding the viewer's own messages from the unread count — see above.
