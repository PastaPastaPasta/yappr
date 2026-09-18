# Key exchange contract v3

Registered on moutai 2026-09-17 as `DoW8GtvXbh9ozn53FsonVpNs3aeG6Bh2ruy8cNDjVwig`
(a throwaway battery registration owned by seed persona 260). Built by
`scripts/build-key-exchange-v3-contract.py` from `contracts/key-exchange-v2.json`,
published by `scripts/register-feature-contract.mjs`, verified live by
`scripts/verify-key-exchange-v3.mjs` (14 checks, all passing). Protocol 14,
Platform 4.2.0-beta.1 or later.

**Not enabled anywhere.** The `loginKeyResponse` document is written by the
mobile wallet, not by Yappr, so switching the app alone would leave every QR
login unanswered. See [Wallet compatibility](#wallet-compatibility).

## What changed and why

A `loginKeyResponse` is a one-shot artifact: the wallet writes it seconds after
the user scans a `dash-key:` QR, Yappr reads it once, decrypts the login key,
and never looks at it again. On v2 it is a stored document with two unique
indexes, and it lives forever.

v3 makes the doctype **`indexOnly`**: there is no primary-storage row, no
`$id`, no `$revision`, and no per-index reference — the index entries ARE the
rows. It also adds a **TTL'd `timeRange` index**, whose bytes bill as
processing at the ephemeral rate (270 credits/byte, 1% of the storage rate) and
which drains itself.

| | v2 | v3 |
| --- | --- | --- |
| storage | stored row + 2 unique index trees | index entries only |
| mutability | `documentsMutable` default (never used) | `false` (forced by indexOnly) |
| `contractId` | plain identifier | `refersTo: {type: contract}` — a ghost application id is refused 40120 |
| uniqueness | `unique` on `[contractId, appEphemeralPubKeyHash]`, owner-free | structural, per `(wallet identity, handshake, application)` |
| expiry | none | the `byDay` aggregate expires; the response itself does not — see below |
| delete | by `$id` | by replaying the value tuple (`$createdAt` included) |

The document's **properties are unchanged** (byte layouts, sizes, positions);
only `contractId` gains a `refersTo` declaration and `$createdAt` joins
`required`. `$createdAt` costs the writer nothing: consensus assigns it from
block time, and every create the battery makes carries no timestamp at all.

## What actually expires, and what does not

This is the finding that shaped the whole contract, so it is stated plainly:

> **An indexOnly document cannot self-delete.** A TTL drains only the entries
> under the TTL'd index. Every indexOnly type must keep at least one
> `$createdAt`-free index — the executed-transition proof index — and the
> payload has to live in a non-bucketed index anyway, because **document reads
> can never be served from a bucketed index**.

Two independent refusals enforce that second half, both confirmed live (battery
`k5a`):

- an `IN_TIME_RANGE` document query on an indexOnly type is rejected outright —
  *"the bucketed entries carry bucket-start time granularity, so documents
  cannot be synthesized from them; use the count aggregate surfaces over the
  bucketed index, or query the raw entries through a non-bucketed index"*;
- a raw where-clause is never routed to a bucketed index
  (`index_admissible_for_resolved_time_range`).

So the TTL buys the *aggregate*, not the row. After the TTL horizon the
residue of one handshake is:

| Index | TTL'd | Residue after 2 days |
| --- | --- | --- |
| `byContractAndEphemeralKey` | no | `contractId(32) / hash(20) / walletEphemeralPubKey(33) / encryptedPayload(60) / [0] / $ownerId(32) → commitment` |
| `byHandshakeMeta` | no | `hash(20) / keyIndex(4) / $createdAt(8) / [0] / $ownerId(32) → commitment` |
| `oneResponsePerHandshake` | no | `$ownerId(32) / hash(20) / [0] / contractId(32) → commitment` |
| `byDay` | **yes** | nothing — the daily bucket is flat-dropped |

The only thing that removes the three permanent entries is a **delete**, and
v3 makes that possible from the client: battery `k6` deletes a response using
nothing but the values the app's own two reads returned, and `k6c` re-uses the
handshake slot afterwards. The app does not do this yet (see
[Not in v3](#not-in-v3)).

Net against v2 this is still a clear win — v2 pays for a serialized document
row *plus* two index trees *plus* two uniqueness markers — but "self-expiring
handshakes" is not what an indexOnly + TTL contract can deliver, and the
contract does not pretend otherwise.

## Indexes and the routing they were shaped by

The binding constraint is drive's `MAX_INDEX_DIFFERENCE = 2`: a query whose
bound fields leave more than two index properties unused is refused with
*"query is too far from index"*. `getResponse` binds exactly two fields, so its
index may carry at most two below them, plus the terminal. Every index below is
arranged so each read matches **exactly one** of them — a candidate covering a
read with a smaller difference would win the router and hand back a synthesized
document missing the payload.

| Index | Properties → terminal | Matched by |
| --- | --- | --- |
| `byContractAndEphemeralKey` | `[contractId, appEphemeralPubKeyHash, walletEphemeralPubKey, encryptedPayload] → $ownerId` | the poll: `where contractId == <base58> and appEphemeralPubKeyHash == <base64>` (difference 2). Also the **proof index** |
| `byHandshakeMeta` | `[appEphemeralPubKeyHash, keyIndex, $createdAt] → $ownerId` | the consume read: `where appEphemeralPubKeyHash == <base64>` (difference 2). Omits `contractId` so the poll can never match it |
| `oneResponsePerHandshake` | `[$ownerId, appEphemeralPubKeyHash] → contractId` | nothing — `$ownerId` first and `contractId` as terminal make it invisible to both reads. It exists purely for its structural uniqueness |
| `byDay` | `[$createdAt, contractId, appEphemeralPubKeyHash] → $ownerId`, `countable` + `rangeCountable`, `timeRange {range: 86400, step: 86400, ttl: 172800}` | counts only |

`byContractAndEphemeralKey` is also the proof index because drive takes the
first name-ordered index that involves no `$createdAt` and is not
`skipIfAbsent`, and it sorts before the other candidate,
`oneResponsePerHandshake`.

The two reads are **independent lookups with different orderings**, not a join:
the poll returns the lowest `walletEphemeralPubKey` under the handshake, the
consume read the lowest `keyIndex`. They agree because a handshake normally has
exactly one responder — and where it does not, the service drops the metadata
rather than merging it (it compares `$ownerId`, which is `byHandshakeMeta`'s
terminal).

`byDay` keeps `appEphemeralPubKeyHash` even though the count does not pin it:
without that level the entry key would be `(bucket, contractId, $ownerId)` and a
wallet's *second* login of the day to the same application would collide with
its own earlier entry (40105). `rangeCountable` is what lets the count leave
that last level free.

The TTL is **2 days**, not the one-week ceiling: today and yesterday stay
queryable, which is all an operator needs from a login counter, and a shorter
horizon leaves less standing residue if writes stop (an index that stops
receiving writes keeps its expired backlog indefinitely — drainage is
write-amortized).

### Verified query shapes

```jsonc
// the poll — v2's shape, unchanged
{"documentTypeName": "loginKeyResponse",
 "where": [["contractId", "==", "<base58>"], ["appEphemeralPubKeyHash", "==", "<base64>"]],
 "limit": 1}

// the consume read — keyIndex + $createdAt
{"documentTypeName": "loginKeyResponse",
 "where": [["appEphemeralPubKeyHash", "==", "<base64>"]], "limit": 1}

// today's handshake responses for one application (TTL'd, ephemeral)
{"documentTypeName": "loginKeyResponse",
 "where": [["contractId", "==", "<appContractId>"]],
 "timeRange": [{"field": "$createdAt", "selector": "newest",
                "grid": {"range": 86400, "step": 86400}}]}   // documents.count
```

## Uniqueness: a documented regression

v2's `[contractId, appEphemeralPubKeyHash]` unique index carried no `$ownerId`,
so the **first wallet** to answer a QR owned that handshake globally. indexOnly
cannot express that: every index must embed `$ownerId` (as a property or the
terminal) so that a delete can only ever remove the signer's own entries.

v3 therefore enforces *one response per (application, handshake, wallet
identity)* — battery `k3b`: a second response from the same wallet is rejected
40105 even when every payload byte differs. A **different** wallet can still
write its own response to the same handshake (`k3c`), where v2 would have
refused it.

The practical exposure is unchanged in kind: a squatter who scrapes the QR can
produce a decryptable payload either way (they do the ECDH with their own
ephemeral key), and the user sees a wrong identity. What changes is the race —
on v2 the squatter had to be first and the honest wallet's write then *failed
visibly* (40105); on v3 both writes succeed, a squatter's entry can sort ahead
of the real one under the app's `limit: 1` read, and nothing is refused. The
mitigation is the same as it always was: the `appEphemeralPubKeyHash` is fresh
per login and the QR is short-lived.

## Wallet compatibility

An indexOnly create is an **ordinary document create transition** — there is no
new transition kind, and v3's properties are v2's properties. A wallet that
builds the document from the contract it fetches will write a valid v3 response
with no code change.

What can break is validation: a wallet pinned to an older DPP will refuse the
PV14 contract when it parses `indexOnly`, `terminal`, `timeRange` or `refersTo`
out of the meta-schema. (`$createdAt` joining `required` is not a second hazard
— the writer emits no timestamp on either version; consensus assigns it.) That is why `.env.devnet` carries the v3 id and
topology as **commented lines** — flip them only once dashwallet-ios is known to
accept a meta-schema v3 contract.

One extra consensus check the wallet will meet: `contractId` now refersTo a
contract, so a response naming an unregistered application id is rejected 40120
(`k2a`).

## Client

`NEXT_PUBLIC_KEY_EXCHANGE_TOPOLOGY=v3` (`KEY_EXCHANGE_TOPOLOGY` /
`keyExchangeIsV3()` in `lib/constants.ts`); default `v2`.

`lib/services/key-exchange-service.ts` is the only consumer. The polling query
is identical on both topologies, so the login screen still costs one round trip
per poll while the wallet has not answered. On v3, once a response is found, a
second read fills in `keyIndex` and `$createdAt`; on v2 the single document
already carries them. That second read can never fail the login: it is issued
after the payload is already in hand, and a rejected read (or one answering for
a different `$ownerId`) simply leaves `keyIndex` unset — the value is only ever
logged. `$revision` does not exist on v3 — an indexOnly document has no stored
row to revise — and `$id` is a deterministic content-scoped synthesis, not a
stored identifier.

## Not in v3

- **Consume-and-delete in the app.** Proven possible (`k6`) and it is the only
  thing that clears the permanent residue, but the app never deletes today and
  wiring it in is a separate change: the delete costs the *deleter*, and it has
  to be ordered after the login key has been safely stored.
- **Cross-wallet handshake exclusivity.** Not expressible — see above. Nor is
  *detecting* it: reading the poll with `limit: 2` would let the app log (or
  refuse) a handshake with more than one responder, at the cost of no longer
  issuing v2's exact query.
- **Flipping `.env.devnet`.** Deliberate; the bundled contract snapshot was not
  refreshed for the same reason.
