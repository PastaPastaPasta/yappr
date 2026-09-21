# Social v9 — proved tips

`contracts/yappr-social-contract-v9.json`, built from v8 by
`scripts/build-v9-contract.py`. Every v8 doctype, index, agreement, token rule
and fee is carried over byte for byte; v9 adds two doctypes, `tip` and
`tipReply`, and nothing else. The v8 read and write paths are unchanged.

## The problem it deletes

A tip was a YAPP token transfer whose `publicNote` encoded
`yappr:tip:v1:post:<id>` (`lib/tip-note.ts`). Consensus never reads
`publicNote`, so nothing bound a transfer to a post, and the system
token-history contract has no aggregate trees — which left the app:

- scanning the **author's newest 100 incoming transfers** and parsing notes out
  of them to find one post's tips (a scan, per post, of someone else's
  payments);
- printing a four-line disclaimer under every tipped post explaining which
  parts of what it had just shown were facts;
- summing every incoming transfer on a profile and labelling it "YAPP received
  over the last 100" — neither a tip figure nor a total.

## The grammar, and where it is verified

| Feature | Platform PR | Contract keyword | Battery case |
|---|---|---|---|
| Cross-contract document reference | [#4390](https://github.com/dashpay/platform/pull/4390) | `refersTo.contractId` (32-byte array) | p2, p8 |
| Agreement on a referenced value | #4390 | `propertyAgreement {amount: "amount", recipientId: "toIdentityId"}` | p4, p5, p10c |
| Writer gate | [#4816](https://github.com/dashpay/platform/pull/4816) | `propertyAgreement {"$ownerId": "$ownerId"}` | p7, p9a |
| Deletable reference | [#4860](https://github.com/dashpay/platform/pull/4860) | `refersTo.type: deletableDocument` at post/reply | p6 |
| Unique index | — | `unique: true` on `[transferId]` | p3 |
| Count trees | — | `countable` on `[postId]` / `[recipientId]` | p2c, p2d, p10b |

Consensus codes the client and the battery key on: **40127** a bound value
disagrees with the referenced document (including the writer gate, where the
referring side is `$ownerId`), **40120** the cited transfer does not exist,
**40105** a second tip cites a transfer another tip already cites, **40700**
insufficient YAPP for the tip document's own cost.

## The exact diff against v8

Two doctypes added, nothing else touched. Both are one shape with the tipped
document swapped (`tip` names a `postId`, `tipReply` a `replyId`):

```
required: $createdAt, transferId, amount, recipientId, <postId|replyId>
documentsMutable: false, canBeDeleted: false      — a receipt is never rewritten
                                                    or removed; the words a tip
                                                    carries live in a reply,
                                                    which moderators can already
                                                    take down

transferId       identifier → refersTo {
                   type: permanentDocument,
                   contractId: <token-history, as 32 bytes>,
                   documentType: "transfer",
                   propertyAgreement: {
                     "$ownerId":    "$ownerId",      only the sender may write it
                     amount:        "amount",        the number is a copy, not a claim
                     recipientId:   "toIdentityId",  who was actually paid
                   } }
amount           integer, minimum 0, maximum 9007199254740991
recipientId      identifier
postId/replyId   identifier → refersTo {
                   type: deletableDocument,
                   documentType: "post" | "reply",
                   propertyAgreement: { recipientId: "$ownerId" } }
messageReplyId   identifier, OPTIONAL → refersTo {
                   type: deletableDocument,
                   documentType: "reply",
                   propertyAgreement: { "$ownerId": "$ownerId" } }

indices: byTransfer   [transferId] unique
         tippedAndTime [<tipped>, $createdAt]
         byTipped      [<tipped>] countable
         byRecipient   [recipientId] countable
         ownerAndTime  [$ownerId, $createdAt]

tokenCost.create: 1 YAPP, optional, gasFeesPaidBy PreferContractOwner
actionFees:       none
```

### Semantics the client relies on

- **Chaining the two agreements proves the payment reached the post's author.**
  `transfer.toIdentityId == tip.recipientId == post.$ownerId`, transitively, so
  a real payment cannot be displayed under an unrelated post.
- **Nothing on the read path touches token history.** `amount` is on the tip
  document and consensus put it there, so a post's tips are one indexed query.
- **`messageReplyId` is gated to the tipper's own reply**, and to that only:
  consensus does not check that the reply and the tip concern the same thread,
  so a reader builds badges from tips it loaded *for this thread*.
- **There is deliberately no thread field on `tipReply`.** A tip would have to
  assert which thread it belonged to and nothing could check the assertion; a
  thread reads its tips by asking about the reply ids it is already showing.
- **`amount` carries a `maximum` that changes nothing today.** It still infers
  U64 (which is what lets the agreement register), and a declared bound below
  `i64::MAX` is what the proposed upstream relaxation would look for — see
  below. It is 2^53-1 rather than `i64::MAX` because every tool on the
  registration path parses this JSON with JavaScript, where `i64::MAX` becomes
  a float and the wasm validator refuses it.

### What is still not proved

Self-tipping from a second identity. The money genuinely moves; it is just the
tipper's own. That is the entire remaining caveat, and the UI does not carry it
as text — the strip shows who each tip came from, which is the check.

### No proved amount total

`summable` on `amount` is not expressible: the agreement forces `amount` to
U64, and `summable` rejects U64 (grovedb's aggregator is `i64`). So the count
trees give a proved COUNT — "tipped N times", lifetime, O(log n) — and a
post's amount total is summed from its own tips, which the count tree says is
all of them. `docs/PLATFORM_SUMMABLE_AGREEMENT_GAP.md` is the upstream request;
if it lands, a later cut adds `summable: "amount"` to `byTipped`/`byRecipient`
and the profile gains a proved lifetime total.

## Client plumbing

- `lib/constants.ts`: `CONTRACT_TOPOLOGIES` appends `'v9'`; `DOCUMENT_TYPES`
  gains `TIP`/`TIP_REPLY`.
- `lib/contract-topology.ts`: `V9_DESCRIPTOR` (v8's interaction surface),
  `provedTipsAvailable()`, `tipSurfaceFor(kind)`, and `grammarSchemas()` so the
  token-cost and action-fee helpers read v9's JSON on a v9 deployment.
- `lib/services/proved-tip-service.ts`: the whole read path — a document's
  tips, a thread's reply tips (cached per reply, asked in batches of 20), and
  the two count-tree reads.
- `lib/services/tip-service.ts`: `recordTip` writes the tip document;
  `sendYappTipLocal` now returns the transfer document's id, read back off the
  sender's own index, which is both the citation and the evidence the transfer
  landed. A 40105 on the unique index reads as "already attached".
- `lib/tip-transfer-id.ts`: the transfer document id derivation
  (`sha256d(tokenId ‖ senderId ‖ "history_transfer" ‖ be64(nonce))`), pinned by
  tests and asserted live by the battery.
- UI: `components/post/post-tips.tsx` (the strip, no disclaimer),
  `components/post/post-card.tsx` (`TipBadge`), `hooks/use-thread-tips.ts`,
  `components/profile/tips-received.tsx` (the proved count), and
  `components/post/tip-modal.tsx`, whose DASH credit tab is gone — an
  `IdentityCreditTransfer` writes no document, so nothing can cite it and
  nothing could ever be shown.
- Deleted: `components/profile/yapp-flow.tsx`, `tipHistoryService.getTipsForPost`
  / `getTipsReceived` / `totalTipped` / `TIP_PAGE_LIMIT`. What remains of
  `tip-history-service.ts` is the sender's own transfer lookup.

## Validation

Offline, all of it in CI's reach:

```bash
python3 scripts/build-v9-contract.py --self-test    # rebuild is byte-identical; bindings; kinds
node scripts/validate-contract-offline.mjs contracts/yappr-social-contract-v9.json
node scripts/verify-v9.mjs --self-test              # id derivation + fees off the contract
npm run lint && npm run test && npm run build && npx knip
```

The build script's self-test checks the one thing the offline validator cannot:
that `tip.amount` infers the **same** property type as `transfer.amount`. The
validator cannot fetch a foreign contract, so a width mismatch would pass
offline and fail on chain, having been paid for — the same trap as #4809.

Live, on a beta.3 devnet:

```bash
NETWORK=devnet node scripts/register-social-v3-draft.mjs \
  --contract-file yappr-social-contract-v9.json --maker --moderators <ids> --fund <botA,botB>
NETWORK=devnet node scripts/verify-v9.mjs --contract <newId>
NETWORK=devnet node scripts/snapshot-contracts.mjs
# .env.devnet: NEXT_PUBLIC_YAPPR_CONTRACT_ID=<newId>, NEXT_PUBLIC_CONTRACT_TOPOLOGY=v9
npm run build:devnet
```

## What the first live run must prove

1. The contract registers at all — the cross-contract `refersTo` into a SYSTEM
   contract is the part with no precedent in this repo.
2. A tip citing a real transfer on the payee's own post is accepted (p2).
3. Every forgery is refused with the expected code: inflated amount, substituted
   payee, foreign post, bystander writer, ghost transfer, duplicate citation
   (p3–p8).
4. The derived transfer id equals the one Platform wrote (p1c).
5. The count trees answer, and the profile's lifetime count is one read per
   doctype (p2c, p2d).
6. A tip with words lands as a real reply that can be liked and replied to,
   wearing the badge (p9b).
