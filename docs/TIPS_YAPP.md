# Tips on YAPP

Tips used to be a DASH credit transfer followed by a `reply` whose text said
`tip:<credits>`. Nothing on chain connected the two: the number in the reply was
free text, the transfer left no readable document, and the badge Yappr rendered
was a claim the app repeated on the tipper's behalf. That is exactly the thing
this project exists not to do, so it is gone — the regex, the announcement reply
and the "unverified" badge with it.

A tip is now a **YAPP token transfer**, and the badge is read back off chain.

## What is proved

YAPP's token config sets `keepsTransferHistory`, so Platform writes a `transfer`
document into the **system token-history contract**
(`43gujrzZgXqcKBiScLa4T8XTDnRhenR9BLx8GWVHjPxF`, the same id on every chain) for
every YAPP transfer. That document is created by consensus as part of applying
the transfer — it cannot be written without one, and the doctype is
`documentsMutable: false`, `canBeDeleted: false`, so it cannot be edited or
removed afterwards.

From it, these are facts, not claims:

| Field | Meaning |
|---|---|
| `$ownerId` | the sender — the identity whose key signed the transition |
| `toIdentityId` | the recipient |
| `amount` | the exact number of YAPP that moved |
| `tokenId` | which token moved (checked against YAPP's derived id) |
| `$createdAt` | when it landed |
| `publicNote` | a string the sender signed **along with** the amount and recipient |

So "X sent N YAPP to Y at time T, and said this about it" is provable by anyone
against the chain, with no trust in Yappr.

## What is NOT proved

- **Nothing binds a transfer to a post.** Consensus never looks at `publicNote`;
  it does not resolve the post id inside it, and there is no `refersTo` from a
  token transition to a document. The link from a transfer to a post is the
  *sender's own assertion*, signed by the sender. The UI says so in as many
  words: the amount and the sender are proved, the attribution is the sender's
  note.
- **Self-tipping is possible.** An author can transfer YAPP from a second
  identity they control to themselves and name their own post. The tips strip
  shows who each tip came from precisely so this is visible rather than hidden
  inside a total.
- **Totals are bounded, not global.** The token-history contract is a system
  contract: no `documentsCountable`, no sum or average trees. There is no proved
  lifetime total to query. Every figure Yappr shows is the sum over one bounded
  page (the newest 100 transfers on an index) and is labelled that way. A very
  heavily tipped author can have older tips fall off that page.
- **A tip note is attacker-controlled text on someone else's post.** For the
  minimum tip (1 YAPP) anyone can staple up to 280 characters under any post's
  detail page, permanently — the doctype is immutable and undeletable, and the
  author has no way to take it down. `components/post/post-tips.tsx` withholds
  notes from identities the viewer blocks (amounts still count, because the
  transfer did happen and hiding it would make the total wrong), but that is a
  viewer-side filter, not moderation. Raising `MIN_YAPP_TIP` is the lever if
  this is ever abused.
- **A profile's "YAPP received" is not a tip total.** The `to` index carries
  every incoming YAPP transfer, tip-noted or not, and only noted ones are
  attributable to a post. `components/profile/yapp-flow.tsx` is therefore
  labelled "YAPP received / sent" rather than "tips" — calling that sum "tips"
  would be the same unearned claim this change exists to delete.
- **A deployment whose social contract has no YAPP token has no YAPP tips.**
  The `/testing` build's social contract (`2qvaZNJJ…`) was registered before
  the token existed, so there the YAPP tab reads a balance of 0 and refuses to
  send; nothing can move. Staging, production and the moutai devnet all carry
  the token with `keepsTransferHistory` (checked on chain 2026-09-18, and the
  `transfer` doctype on the history contract is identical on testnet and
  devnet: same four indexes, `publicNote` max 2048).
- **The credit (DASH) tip path is not provable at all** and never was. It is
  kept as a plain "send someone DASH" option, it announces nothing, and the UI
  tells the user it cannot be shown on the post.
- **Legacy `tip:<credits>` replies still exist on chain.** The old announcement
  wrote real `reply` documents, which are permanent. With the parser gone they
  render as their literal text in old threads. That is ugly but honest, and
  re-adding a formatter would mean re-adding the parser for a number nothing
  backs.

## Encoding

`lib/tip-note.ts`. The whole `publicNote` (max 2048 chars on the doctype):

```
yappr:tip:v1:post:<base58 postId>
yappr:tip:v1:reply:<base58 replyId>[\n<message up to 280 chars>]
```

`v1` is a version segment so a later encoding can be added without old clients
mis-reading it. A note that does not start with exactly `yappr:tip:v1:`, names
an unknown kind, or names something that is not a 32-byte base58 identifier is
not one of ours and is ignored — an ordinary "thanks!" transfer note never
becomes a tip on a post.

A profile tip (no post involved) carries the bare message, or no note at all.

## Query shapes

Both proved live on devnet by `scripts/verify-tips.mjs`. Every index on
`transfer` is prefixed by `tokenId`, and `orderBy` must name the index fields in
order, including the equality-constrained ones.

Tips received (the `to` index):

```json
{
  "dataContractId": "43gujrzZgXqcKBiScLa4T8XTDnRhenR9BLx8GWVHjPxF",
  "documentTypeName": "transfer",
  "where": [["tokenId", "==", "<YAPP token id>"], ["toIdentityId", "==", "<identity>"]],
  "orderBy": [["tokenId", "asc"], ["toIdentityId", "asc"], ["$createdAt", "desc"]],
  "limit": 100
}
```

Tips sent (the `from` index) is the same with `["$ownerId", "==", "<identity>"]`
and `["$ownerId", "asc"]`.

**Tips on one post** are not a query: there is no index on `publicNote`. The
author's newest 100 incoming transfers are read off the `to` index and filtered
client-side by parsing each note (`tipHistoryService.getTipsForPost`). That is
why it runs on the post **detail** page only and never per feed card — one DAPI
request per post is affordable where the user asked for that post, and not
affordable across a feed.

`amount` comes back as a bigint from `toObject()` and stays a bigint through
`ProvedTip`; `toIdentityId` and `tokenId` are raw byte arrays.

## Signing

Every state transition batch carrying a **token** transition requires a
**CRITICAL** authentication key. Yappr does not hold one for wallet-login users,
whose stored key is HIGH — so the tip flow has two paths, mirroring the
buy-YAPP flow exactly:

1. **Local** (`tipService.sendYappTipLocal` → `tokenService.transfer` →
   `sdk.tokens.transfer`) when `tokenService.canSignTokenTransitions` says this
   browser holds a CRITICAL key, or when the user pastes one (used to sign,
   never stored). That probe runs when the user presses Continue on the YAPP
   tab, not on modal open, so the DASH and crypto tabs cost no identity fetch.
2. **Wallet** (`buildUnsignedYappTipTransition` in
   `lib/services/token-transfer-builder.ts`) otherwise: an UNSIGNED
   `TokenTransferTransition` wrapped in a `BatchTransition`, serialized and
   encoded into a `dash-st:` URI shown as a QR for a remote wallet (e.g. Dash
   Evo Tool) to sign and broadcast. Success is detected by polling the `from`
   index for **this tip's own transfer document** (right recipient, right
   amount, created after the QR went up) rather than by watching the YAPP
   balance fall — a balance drop would also fire if the user posted from
   another tab. The wait is silent and falls back to a "check again" prompt,
   never a countdown.

The unsigned transition embeds the sender's next identity-contract nonce, so it
expires naturally the moment the user posts or likes in another tab — build it
right before showing the QR and rebuild on retry.

### Never retry a tip blindly

DAPI's `wait_for_state_transition_result` routinely 504s on transitions that
landed (see CLAUDE.md). A tip is money, so "the SDK threw" must never become a
"Try Again" button. Both paths resolve it by asking the chain instead:

- The local path funnels confirmation-shaped failures — timeouts, 504s, and
  the "already in mempool / already in chain / nonce already present" replies
  that mean the broadcast went through — into `tipService.confirmYappTip`,
  which polls `getTipsSent(..., {fresh: true})` for the matching row, floored
  at the moment of the send (minus a 60 s skew margin) so an identical earlier
  tip cannot pass for it. Found → success. Not found → a distinct
  `UNCONFIRMED` result and a screen whose only actions are **Close** and
  **Check again**.
- The wallet path's expired QR re-checks for the tip **with no time floor**
  before it will build a second signing request — if the chain's clock ran
  behind the browser's, the tip is real but sits before the `since` margin.

`matchesSentTip` (in `tip-history-service.ts`) is the single predicate both use:
recipient, exact amount, tipped post and message must all agree. The automatic
confirmations also carry a time floor; the two **Check again** buttons
deliberately do not, which is the one place an identical earlier tip (same
author, amount, post and message) would be reported as this one. That trade
was made so a chain clock more than a minute behind the browser's cannot hide a
real tip and prompt a second send — the costlier failure.

> **Wallet support caveat.** The `dash-st:` channel and the URI builder are the
> same ones buy-YAPP and key registration already use, and `verify-tips.mjs`
> case t5 proves the bytes decode back to the right transfer. Whether a given
> wallet build renders a *token transfer* request (as opposed to a direct
> purchase or an identity update) has not been verified end to end here. If a
> wallet cannot yet display it, the local-signing path is unaffected.

## Verifying

```
NETWORK=devnet node scripts/verify-tips.mjs [--tipper 240] [--creator 241] [--amount 5]
```

28 checks: `transfer.publicNote`'s `maxLength` read off the **deployed** schema
agrees with the app's 2048 cap and accepts a full 280-character message;
balances move by exactly the tipped amount; the `transfer` row is on the `to`
index with the exact amount, sender, recipient, token and verbatim note (the
max-length note included); the client-side attribution filter finds the noted
tips and rejects an untagged control transfer sent alongside them; the same row
is on the `from` index; and the unsigned wallet transition decodes back
(`StateTransition.fromBytes` → `BatchTransition.fromStateTransition`) to one
unsigned token transfer carrying the right recipient, amount and note.

## Code

| Path | Role |
|---|---|
| `lib/tip-note.ts` | note encoding/parsing (pure; `lib/tip-note.test.ts`) |
| `lib/services/tip-history-service.ts` | reads the history contract, 60s TTL cache |
| `lib/services/token-transfer-builder.ts` | unsigned transition for wallet signing |
| `lib/services/tip-service.ts` | `sendYappTipLocal`, confirmation, validation, legacy credit path |
| `lib/services/token-service.ts` | `transfer`, `canSignTokenTransitions` |
| `components/post/tip-modal.tsx` | YAPP / DASH / other-crypto tabs |
| `components/post/post-tips.tsx` | proved tips strip (post detail only) |
| `components/profile/yapp-flow.tsx` | "YAPP received / sent" on a profile |
| `scripts/verify-tips.mjs` | live devnet battery |
