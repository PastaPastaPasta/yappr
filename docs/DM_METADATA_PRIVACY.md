# DM metadata privacy — research and proposed redesign

Status: research, 2026-09-22. Nothing here is implemented.

Goal: a **passive observer of Platform state** must not be able to tell that
identities A and B are messaging each other. We accept that an observer sees
*that* an identity writes DMs, how many, when, and roughly how large. We want to
break the **sender ↔ recipient link**.

---

## 1. What the current contract leaks

`contracts/yappr-dm-contract.json` (v4) and `lib/message-encryption.ts`. Every
Platform document is public and carries `$ownerId` and `$createdAt`, so the
question is only which fields tie two owners together. Today there are three
independent links. Each is enough on its own.

| # | Leak | Why it links A and B |
| --- | --- | --- |
| 1 | `conversationInvite` | `$ownerId = A`, `recipientId = B` in plaintext, with an `inbox` index on `recipientId`. It is literally a public edge list. |
| 2 | `conversationId = SHA-256(sort(A,B))[:10]` | It is deterministic from public identity ids. An observer computes it for every pair (10k users means about 5·10⁷ hashes, which takes seconds) and reverses every conversation. |
| 3 | Shared `conversationId` across owners | Even with a random id, A's `directMessage`s and B's `directMessage`s and `readReceipt`s all carry **the same value**. Two owners writing to one bucket is the link. |
| 4 | `readReceipt` | `$ownerId = B` + `conversationId`, and its `$updatedAt` publishes when B read. |

Two non-metadata issues matter more here than they would in Signal, because the
ciphertext is **public and permanent**:

- **No forward secrecy.** The AES key is `HKDF(ECDH(IK_A, IK_B))`, which is static
  for the life of both identity keys. If either key leaks, all history decrypts,
  and anyone can download that history.
- **History is already public.** Deleting v4 invites removes them from current
  state, but the state transitions stay in the chain's block history. Existing
  links cannot be taken back. Any migration should say this to users plainly.

---

## 2. Prior art worth copying

| System | Idea | What we take |
| --- | --- | --- |
| **Signal: sealed sender** | The server learns the recipient but not the sender. The sender certificate travels inside the ciphertext. | We invert it. On Platform the **sender is unavoidably visible** (`$ownerId` signs and pays), so we hide the **recipient** instead. |
| **Signal: X3DH / PQXDH** | Published prekey bundle (identity key + signed prekey (+ one-time prekeys, + ML-KEM)), so the first message can be sent asynchronously. | Prekey bundle doctype; the first contact is sealed to it. |
| **Signal: Double Ratchet / SPQR** | Per-message keys, forward secrecy, post-compromise security, PQ ratchet. | Phase 2. It matters *more* here because ciphertext is harvestable forever. |
| **SimpleX** | No user ids on the wire. Each contact pair gets two unidirectional queues with random ids. | Per-direction channels addressed by secret tags. |
| **BIP-352 silent payments / BIP-47** | The recipient publishes one static code. The sender derives a unique unlinkable output, and the recipient scans. BIP-47's public "notification tx" is the known leak that silent payments removed. | This is exactly our first-contact problem. Don't publish a notification edge: scan. |
| **Monero view tags / fuzzy message detection** | A short hint lets the recipient skip most trial decryptions, trading off anonymity-set size. | Bucketed contact requests (§3.2). |
| **Zcash / Orchard memos** | Shielded notes carry an encrypted memo. Sender, recipient, and amount are all hidden. | Phase 3 option. Platform has an Orchard pool (see §5). |

---

## 3. Proposed design (DM v5)

The design makes one structural change: **no field is ever written by both
parties, and no field is derivable from public ids.** Every message is addressed
by a one-time pseudorandom tag that only the two participants can compute.

### 3.1 Doctypes

```
dmPrekeys        owner = user     (public: "this user accepts DMs")
  signedPrekey   33B  secp256k1, rotated ~weekly
  prekeySig      65B  signature by an identity key over (signedPrekey, prekeyId)
  prekeyId       u32
  [pqPrekey      1184B ML-KEM-768 encapsulation key, phase 2]
  index: unique [$ownerId]

dmContactRequest owner = sender   (first contact only, once per pair)
  bucket         u16  = H("yappr-dm-bucket" ‖ recipientId) mod 2^k
  ephemeralKey   33B
  sealed         padded ciphertext (see below)
  index: [bucket, $createdAt]
  index: [$ownerId, $createdAt]   (sender's own devices recover outgoing contacts)

dmEnvelope       owner = sender   (every message after the first)
  tag            16B  one-time, pseudorandom
  body           ciphertext padded to a size class
  index: unique [tag]
```

`conversationInvite`, `readReceipt`, and the shared `conversationId` go away
entirely.

### 3.2 First contact (sealed, bucketed)

1. A fetches B's `dmPrekeys`. This is a read, so nothing goes on chain.
2. A generates ephemeral `E` and runs X3DH without one-time prekeys (Signal's
   "last resort" mode): `DH(IK_A, SPK_B) ‖ DH(E, IK_B) ‖ DH(E, SPK_B)` → `RK`.
3. `sealed = AEAD(key from DH(E, SPK_B)…, { senderId = A, prekeyId, first message,
   padding })`. Inside it, B checks `senderId == $ownerId`, and
   `DH(IK_A, SPK_B)` authenticates A.
4. A writes `dmContactRequest` with `bucket(B)`.
5. B periodically queries `bucket == bucket(B), $createdAt > lastScan` and
   trial-decrypts each result (about one ECDH per request).

**What the observer learns:** "A contacted *someone* in bucket `b`". The
anonymity set is about (DM users) / 2^k. `k` is the main tuning knob:

| k | Buckets | Anonymity set at 10k DM users | B's scan load at 1k requests/day network-wide |
| --- | --- | --- | --- |
| 0 | 1 | everyone | 1000 ECDH/day |
| 4 | 16 | ~625 | ~63/day |
| 8 | 256 | ~39 | ~4/day |

Recommendation: make `k` a client constant (not in the contract) so it can grow
with the network. Start at **k = 0 or 4**. Trial decryption is cheap, and contact
requests are rare compared to messages. The bucket is only ever used for the
first message of a pair, so a small anonymity set here does not compound.

Why not a public "notification" document, as BIP-47 does? Because that
reintroduces leak #1. Why not one-time prekeys? Consuming one requires somebody
to mark or delete it, and that write links the pair. Replay is instead handled by
B remembering which request ids it has already processed.

### 3.3 Ongoing messages (per-message tags)

From `RK`, each direction gets its own key:

```
K_AB = HKDF(RK, "a→b"),  K_BA = HKDF(RK, "b→a")
tag_i     = HMAC(K_dir, "tag" ‖ i)[:16]
msgKey_i  = HMAC(K_dir, "key" ‖ i)
```

- The sender writes `dmEnvelope{tag_i, body}`. Tags are never reused, so an
  observer cannot group even A's own messages by recipient. They see "A sent N
  DMs".
- B's replies use `K_BA`, a disjoint tag space. Nothing B writes shares a byte
  with anything A wrote.
- **Receiving and unread counts:** one query per ≤100 expected tags, for example
  `tag in [next 3 tags of each of 33 contacts]`. This replaces the rangeCountable
  count queries and the read receipts. Unread becomes exact up to the window,
  then "3+".
- **Multi-device and stateless recovery:** every value above is recomputable
  from the identity key plus chain data. A new device (a) rescans its bucket for
  incoming requests, (b) reads its own `dmContactRequest`s via
  `[$ownerId, $createdAt]` (the ephemeral key is derived deterministically from
  IK + a counter, so the sender can re-derive `RK`), and (c) probes tag windows
  forward until a miss. No state blob is needed, and a state blob would itself
  be a timing leak (see §4).
- **Concurrent sends from two devices:** the `unique [tag]` index makes the
  second write of the same `i` fail at consensus. The client retries with
  `i + 1`, which gives exactly-once delivery per index for free.

### 3.4 Read receipts and typing

These become encrypted control messages inside the channel (a `dmEnvelope` on
the reader's outgoing tag stream). They should be off by default and
batch-delayed, because a receipt written seconds after A's message is a timing
correlation (§4).

---

## 4. Residual leaks (the honest part)

This design removes every *structural* link. What remains is statistical, and at
Yappr's current scale **timing is the dominant attack**:

- **Timing correlation.** If A writes at t, B writes at t+20s, and A writes at
  t+45s, repeated over a conversation, an observer can link the pair with
  simple co-occurrence statistics once few users are active at once. The
  anonymity set is *concurrently active DM users*, not all users.
  Mitigations, roughly in order of cost: send on coarse ticks (for example
  batch outgoing messages to 30–60 s boundaries); randomized send delay;
  delayed or disabled read receipts; optional cover traffic (dummy envelopes
  to random tags, which cost credits). None of these fully defeats a global
  observer, and Signal does not claim to either.
- **Size.** Pad `body` to size classes (for example 256 / 1024 / 4096 B). Fees
  scale with bytes, so padding makes short messages cost more. That is the price
  of the feature.
- **Sender activity.** `$ownerId`, `$createdAt`, and identity/contract nonces
  reveal how much each user sends. This is accepted per the goal.
- **Query privacy against evonodes.** Chain observers never see reads, but the
  DAPI node answering B's `tag in [...]` query sees B's IP next to B's expected
  tags, and can later match A's writes. This is outside the "passive chain
  observer" goal but is a realistic adversary. Mitigations: rotate nodes;
  optional "download the whole `dmEnvelope` window and match locally" mode
  (bandwidth scales with global DM volume, which is fine now and not at scale);
  Tor. Decoy tags don't work, because the node can see which tags later got
  hits.
- **Funding graph.** Irrelevant while the sender is visible anyway. It becomes
  the key problem in Phase 3.
- **Contract nonce.** A counter is visible per identity and per contract, so DM
  volume is visible. Accepted.
- **Blocking.** An on-chain `block` of a DM contact would itself reveal the
  relationship. Ignoring a contact must stay client-side.

---

## 5. Roadmap

**Phase 1: recipient unlinkability (this doc, §3).** New `dm v5` contract plus
the client. The existing crypto primitives in `lib/crypto/` (ECDH, HKDF,
AES-GCM) cover it. Needs new pure modules with Vitest specs: tag derivation,
X3DH, sealing, padding.

**Phase 2: forward secrecy and PQ.** This is more urgent than for Signal
because ciphertext is permanently public ("harvest now, decrypt later").
Double Ratchet with header encryption, PQXDH (the ML-KEM-768 ciphertext is
about 1.1 KB and fits under the 5000 B cap), and eventually a PQ ratchet in the
style of SPQR. The hard part is **multi-device**. Ratchet state is not
recomputable from the identity key (that is the whole point), so it needs
per-device sessions (Signal's Sesame model: each device publishes its own
prekeys, and senders fan out per device). That multiplies writes per message.
This is a product decision, not a crypto one.

**Phase 3: sender anonymity (optional).** Signing is by `$ownerId`, and the
contract-owner-paid gas added in beta.3 (#4826) still has the user sign, so the
only way to hide the sender is a **burner identity** per contact (or per epoch)
whose funding cannot be traced back. The pieces exist in the installed SDK:
`sdk.addresses.createIdentity` / `topUpIdentity` fund an identity from platform
addresses, and Platform has an Orchard shielded pool. The chain would be
shield → unshield to a fresh address → create burner. Today `sdk.shielded` is
**read-only**. Its facade says building shielded transitions needs the Orchard
prover and is deferred, so this is blocked on SDK work. The further option is
using Orchard note memos *as* the message transport (Zcash-style). That hides
everything but requires every client to trial-decrypt every note, which is the
same scaling wall Zcash light clients hit.

**Groups (later).** The tag design extends naturally to Signal-style *sender
keys*: each member has a group sender chain, writes each message once under its
next tag, and members poll each member's next tag. Membership changes rekey the
group.

---

## 6. Cost vs v4

| | v4 | v5 |
| --- | --- | --- |
| Pair setup | 1 invite per direction | 1 contact request (once per pair) |
| Per message | 1 `directMessage` | 1 `dmEnvelope` (padded, so slightly more bytes) |
| Reading | `readReceipt` replace per read | none (optional encrypted receipt) |
| Unread badge | 1 count per conversation | 1 `in` query per ~33 contacts |
| Indexes per message write | `[conversationId, $createdAt]` rangeCountable | `unique [tag]` |

That is net cheaper or equal on writes, apart from padding, which keeps the
"DMs must stay cheap" constraint from `NON_SOCIAL_CONTRACTS.md`.

## 7. Open decisions

1. Bucket width `k`: anonymity versus scan cost. Proposed: start at 0–4.
2. Size classes for padding, which trade cost against the size leak.
3. Read receipts: drop them, or keep them as opt-in encrypted control messages.
4. Whether Phase 2's per-device fanout is acceptable, or whether we accept
   "forward secrecy only per device" and simpler recovery.
5. Migration: v4 history cannot be made private. Should v5 start with a fresh
   inbox and a one-time notice, or should the client keep reading v4 for a
   transition period?
