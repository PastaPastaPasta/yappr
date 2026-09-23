# DM v5: unlinkable 1:1 and group messaging

Status: **design, not implemented.** 2026-09-22. Supersedes the 1:1-only DM
contract (`contracts/yappr-dm-contract.json`, topology v3/v4) for new
conversations. This doc merges two earlier drafts: the metadata-privacy
research and `DM_V5_GROUPS.md` (branch `design/dm-v5-groups`). Where they
disagreed, §12 records which side won and why.

## 1. Goals and constraints

1. **A passive chain observer cannot tell who talks to whom.** Anyone may see
   *that* an identity writes DM documents, how many, when, and roughly how big.
   What they must not see is which other identities, or which group, those
   documents are for.
2. Group conversations, with 1:1 as a special case rather than a separate
   system.
3. All key agreement uses the identity's **ENCRYPTION** key (purpose 1,
   ECDSA secp256k1). v3/v4 use the HIGH AUTHENTICATION key, which is the wrong
   key for the job.
4. Survive encryption-key rotation without losing history.
5. **Store as little as possible.** Each stored byte costs 27,000 credits, but
   the fixed cost of a document and each of its index entries dominates.
   Measured costs: a follow is about 46M credits, a like about 59M, a post about
   188M, and 100 payload bytes about 2.7M. Minimise, in this order: **documents
   per operation, index entries per document, bytes per document.** Messages
   stay at one document with one index.
6. **Stateless recovery.** Any session on any device can rebuild every
   conversation from the login-derived encryption key
   (`deriveYapprEncryptionKeyFromLogin`) plus chain data. This is accepted, and
   it means there is no forward secrecy against compromise of your own key. This
   is a deliberate trade: Yappr does not try to replace Signal (§11).
7. Static export, no backend, one document per state transition.

The design rests on one rule. **No field on chain is shared between the
documents of two different participants, and no field can be derived from
public identity ids.** Everything that locates a conversation's documents is a
pseudorandom value that only its members can compute.

## 2. What v4 leaks today

Each of these links is enough on its own to reveal a pair.

| # | v4 leak | v5 fix |
| --- | --- | --- |
| 1 | `conversationInvite` stores `$ownerId = A` next to `recipientId = B` in plaintext, with an index on recipient. It is a public edge list. | Invites carry no recipient field. They are sealed, padded, and filed under a coarse bucket (§5.1). |
| 2 | `conversationId = sha256(A:B)[0:10]`. Anyone can hash every pair of users and reverse every conversation. | There is no conversation id on chain. Group and 1:1 ids are secrets. |
| 3 | A's and B's messages share one `conversationId`, so the index groups the pair. | Every message has a one-time tag, and tags never repeat across documents (§6). |
| 4 | `readReceipt` publishes `(B, conversationId, time B read it)`. | Read state is synced through an encrypted self-state doc only the user can read (§5.6). |
| 5 | Static ECDH on the auth key. | ENCRYPTION key, plus a rotation bridge (§4.6). |

v4 history is **permanently** linkable. Deleting its documents does not remove
them from block history. Migration must say this plainly (§10).

## 3. Threat model

**Protected against:**
- **A passive chain observer linking participants.** They cannot tell who
  messages whom, which documents belong to the same conversation, or who is in
  a group.
- **Non-members, and Platform itself, reading content,** group names or rosters.
- **Removed members reading messages sent after their removal,** once a bounded
  grace window has passed (§6.6).
- **New members reading messages sent before they joined.**
- **One member impersonating another.** Platform signs `$ownerId`, and readers
  accept a stream's documents only from that stream's sender (§6.1).

**Still visible to a passive observer (accepted):**
- Per identity: the number of DM documents, when they were written, and their
  size class.
- Per group owner: how many group roster docs they own and each one's
  `$revision` (how many membership changes and renames it has seen), and the
  group's size *class* (§5.5). The owner is the only identity linked to a group,
  and only as "owns some group".
- That an identity rotated its encryption key (the bridge doc).
- That an owner created a group of roughly N, from the burst of invites (§5.5).
  At `k = 0` the burst says nothing about who.
- The statistical leaks in §8, chiefly **timing correlation**.

**Out of scope:**
- Compromise of your own encryption key.
- Members leaking content or membership. An insider can always publish the
  roster, so nothing here tries to hide members from each other.
- The DAPI node you query (§8).
- Hiding the *sender* (§11, Phase 3).
- Deniability.

## 4. Keys

### 4.1 Notation

- **`HKDF(ikm, salt, info)`** is HKDF-SHA256 with a 32-byte output unless noted.
  Every `info` starts with a fixed ASCII label, then a NUL byte, then
  fixed-width fields. `S16(b)` and `S16(r)` are big-endian u16. Labels are never
  prefixes of each other, so no two derivations share an input.
- **`b` and `r` are u16 everywhere** (limit 65,535 each).
- **Identity ids** are 32 bytes. `id_lo` and `id_hi` are a pair sorted by byte
  order.
- Every AES-256-GCM encryption uses a **fresh random 12-byte IV**. No IV is
  ever derived, because two devices can deterministically produce the same key
  (§4.3, §6.1).

### 4.2 Identity keys and trial selection

Each participant needs an active ENCRYPTION key of type ECDSA_SECP256K1 (a full
33-byte point). It is found with `findEncryptionKey`
(`lib/crypto/encryption-key-lookup.ts`), and the private key comes from the
existing encryption-key store, so the same key also serves private feeds.
Hash160 key types are not supported, and v4's `senderPubKey` workaround goes
away. A counterpart without an encryption key cannot be messaged. The UI says
so and links to the add-key flow. Contract-bound keys stay off, for the reason
given in `NON_SOCIAL_CONTRACTS.md`.

**No document carries a key id.** Wherever a reader must pick keys, it tries:
- the counterpart's ENCRYPTION keys, *including disabled ones*, which stay on
  the identity;
- against its own current key and every key recovered through its bridge chain
  (§4.6);

and keeps the combination whose AEAD or `kc` check passes. These sets are tiny,
and a trial costs only an ECDH.

`selfRoot` is derived from the login-derived encryption key:
`selfRoot = HKDF(encPriv, salt="yappr/dm/v5", info="self\0")`. Two subkeys come
from it: `hintKey = HKDF(selfRoot, info="self-hint\0")` and
`stateKey = HKDF(selfRoot, info="self-state\0")`. Both follow the user through
rotations, via the bridge.

The static identity keys **replace a prekey document.** An earlier draft
published a Signal-style signed prekey per user. That would add a document per
user and buy first-message forward secrecy that stateless recovery (goal 6)
throws away anyway.

### 4.3 1:1 keys: no key documents

```
Z    = ECDH_x(encPriv_A, encPub_B)                 // = ECDH_x(encPriv_B, encPub_A)
gid  = HKDF(Z, "yappr/dm/v5", "direct-id\0"  || id_lo || id_hi)[0:10]
K    = HKDF(Z, "yappr/dm/v5", "direct-key\0" || gid)
```

Both parties derive `gid` and `K` on their own, so no key is wrapped or stored.
Starting a chat twice lands in the same thread. `gid` never appears on chain; it
only seeds derivations. A 1:1 chat never turns into a group. Adding a third
person creates a new group, as in Signal.

**After a key rotation, the thread moves on its own, with no writes.** The pair
is always keyed by the two parties' *current* keys:
- When A rotates, A's next send uses the new `Z`, and so a new `gid` and new
  streams.
- B notices A's new key whenever B refreshes A's identity. That happens on
  conversation open, on the poll every few minutes, and whenever an expected
  stream goes quiet for longer than usual.
- B then polls both the old thread and the new thread until the old one has
  been idle for a while.

The UI shows every thread with the same counterpart as one timeline. Old threads
stay readable through the bridge. Because the new `Z` comes from the new key, a
rotation after a compromise **heals** future 1:1 messages. It costs zero writes
beyond the bridge.

### 4.4 Group key schedule

The group **owner** (its creator) holds the root secret implicitly:

```
gid      = 10 random bytes                              // secret, shared only in sealed invites
S        = HKDF(encPriv_owner@creation, salt=gid, "group-secret\0")
K[b,0]   = HKDF(S, "base\0" || S16(b))                // base epoch b
K[b,r]   = HKDF(K[b,r-1], "ratchet\0" || S16(b) || S16(r))
kc(K)    = HKDF(K, "kc\0")[0:8]                        // key check (public in keyrings; reveals nothing about K)
```

- **Nothing about `S` is stored.** The owner re-derives it on any device.
- **`S` is bound to the key the owner held at creation.** After rotating, the
  owner walks their bridge chain, decrypts their own invites through the self
  hint (§5.1), and keeps the old key whose derived `K` matches an invite's
  grant.
- **A base step (`b+1`) happens only on removal.** Removed members do not have
  `S`, so they cannot derive the new base.
- **A ratchet step (`r+1`) happens on an add.** Existing members can derive it
  themselves, so they need no document. The new member receives `K[b,r+1]` and
  cannot step backwards to earlier messages.
- **Keys are deterministic per `(gid, b, r)`.** Two owner devices adding at
  the same time produce the same key, which removes one class of fork between
  the owner's devices.

**Consequences of rotating keys in a group:**
- **An owner rotation does not heal the owner's groups.** All future base keys
  still derive from the creation key. After a compromise, the only fix is to
  recreate the group.
- **An owner who rotates without a bridge loses `S`,** and can never remove
  anyone again. The client refuses a bridgeless rotation while the user owns
  groups, unless they confirm ending those groups.
- **A member who rotates without a bridge** needs a re-invite from each group
  owner. A member who rotates with a bridge needs nothing: the owner's next
  keyring wraps to their new key, found by trial selection.

### 4.5 Sealing to a member (static-static)

Keyring slots use static-static ECDH with no ephemeral key. That saves 33 bytes
per slot compared with ECIES.

```
Z    = ECDH_x(encPriv_owner, encPub_member)
pad  = HKDF(Z, "yappr/dm/v5", "slot\0" || gid || ownerId || memberId || S16(b) || S16(0), 32)
wrap = K[b,0] XOR pad                                   // keyring for base b
```

**Why this is sound:**
- The context `(pair, group, base)` fixes the key being wrapped: it is always
  `K[b,0]`. So no pad ever masks two different values, even when two owner
  devices race.
- Integrity comes from Platform's signature on `$ownerId`. Readers accept
  keyrings only from the group owner, and `kc` confirms the right key was found.
- One member can compute another's pad only if they hold `Z` for that other
  member. They do not.

### 4.6 Rotating your encryption key: one bridge document

When a user replaces their encryption key while still holding the old one, the
client writes one document:

```
encryptionKeyBridge.payload = ECIES(encPub_new, encPriv_old, aad="yappr/dm/bridge/v5" || ownerId)
```

That is 81 bytes, and costs O(1) per rotation however many conversations exist.
Anyone holding the new key can walk the bridge chain back to every old private
key. Old 1:1 threads, group secrets, keyring slots, and self hints all stay
readable. The bridge reveals only "this identity rotated". The same bridge fixes
private feeds' rotation problem (§11.4 of that spec), although wiring private
feeds to it is out of scope here.

**Rotating without writing a bridge** is also a deliberate option. It is a
coarse, user-controlled form of forward secrecy: history under the old key
becomes unreadable *to you*. Counterparts still hold their own keys and can
still read it.

A **lost** key cannot be bridged. A group owner restores a member by writing a
new invite. A 1:1 thread under a lost key is unreadable to the user who lost it.

## 5. Documents

New contract, `yappr-dm-contract-v5.json`.

| Doctype | Owner | Fields | Indexes | Mutability |
| --- | --- | --- | --- | --- |
| `dmInvite` | inviter | `bucket` u16 (heap-encoded, §5.1), `epk` b33, `sealed` b156 (fixed), `selfHint` b32 | `[bucket, $createdAt]`; `[$ownerId, $createdAt]` | immutable, **not deletable** |
| `dmMessage` | sender | `tag` b16, `body` bytes 156–5120, optional `body2`/`body3` bytes ≤ 5120 (§5.3) | **unique** `[tag, $ownerId]` | immutable, **not deletable** |
| `dmRoster` | group owner | `handle` b10, `blob` bytes 156–4124 | **unique** `[$ownerId, handle]` | mutable, not deletable |
| `dmKeyring` | group owner | `handle` b10, `slots` bytes 264–5120 | **unique** `[$ownerId, handle]` | immutable, not deletable |
| `encryptionKeyBridge` | key owner | `payload` b81 | `[$ownerId, $createdAt]` | immutable, not deletable |
| `dmSelfState` | user | `slot` u8, `blob` bytes 156–4124 | **unique** `[$ownerId, slot]` | mutable |

- **No doctype has a `recipientId`, `groupId` or `conversationId` field.**
- **Messages, keyrings and rosters get no `refersTo` or `propertyAgreement`,**
  because each adds a read to the write.
- **Spoofing is prevented with owner-scoped unique indexes and secret
  handles.** A stranger cannot compute a handle. A removed member who knows
  `gid` can write only under their own `$ownerId`, where no reader looks.
- **Nothing is deletable except by replacing `dmSelfState`.** A burst of
  deletes would cluster exactly the documents that tags keep apart, and
  deletion does not remove anything from block history anyway. "Delete
  conversation" is a local action.

### 5.1 `dmInvite`: sealed, fixed-size, bucketed first contact

The invite borrows Orchard's note encryption (§12.1): a fresh ephemeral key
per invite, so a recipient recognises its invites with its own private key
alone, without fetching anyone's identity.

The invite is sealed to the recipient's existing secp256k1 ENCRYPTION key
(§4.2), so there is no extra key and no extra document. Trial decryption in
JavaScript is fast enough, because fetching, not decryption, is the bottleneck
(§5.1.1).

```
bucket   = (1 << k) | HKDF(recipientId, "yappr/dm/v5", "bucket\0")[0:2] >> (16 − k)   // heap-encoded, k = 0 → 1
nonce    = 12 random bytes
e        = HKDF(hintKey, "yappr/dm/v5", "invite-eph\0" || nonce) mod n     // re-derivable by the sender on any device
epk      = e·G                                                             // 33 B, stored
ik       = HKDF(ECDH_x(e, encPub_R), "yappr/dm/v5", "invite\0" || epk)     // recipient: ECDH_x(encPriv_R, epk)
sealed   = nonce | AES-256-GCM(ik, iv=nonce, pad128(grant), aad="yappr/dm/invite/v5" || $ownerId || epk)
selfHint = recipientId XOR HKDF(hintKey, "yappr/dm/v5", "invite-self\0" || nonce)[0:32]
```

`ik` is unique per `epk`, so using the nonce as the GCM IV is safe. The sender
is `$ownerId`, which Platform signs. Binding it in the AAD means a copy of the
invite under another identity fails to decrypt, so the plaintext needs no
sender field. `Z_SR` below is the static ECDH between sender and recipient
(§4.3).

**Every invite is exactly the same size.** The plaintext is always padded to
128 bytes, so `sealed` is always 156 bytes and a whole invite document is
about 300 bytes. After the 2-byte length prefix, 126 bytes are left for the
grant.

**Grant contents:**
- **1:1:** `0x01 | optional first message`. The recipient derives `gid` and
  `K` from `Z_SR`. A first message short enough to fit (up to 125 bytes,
  e.g. "hey, saw your post about…") rides in the invite as **index 0 of the
  inviter's stream** (§6.1), saving a document. A longer one is sent as a
  normal `dmMessage` at `i = 0`. Either way the invite looks the same.
- **Group:** `0x02 | gid(10) | S16(b) | S16(r) | K[b,r](32)`, 47 bytes. The
  recipient reads the name and roster from `dmRoster` (§5.5).

An observer cannot tell a 1:1 invite from a group invite, or whether a first
message is attached.

**Discovery.** The recipient polls
`bucket in [mine at k_m, mine at k_{m−1}], $createdAt > lastScan`. For each
invite:
1. One ECDH with its own encryption key and `epk`, then one AES-GCM trial.
   The recipient tries its current key and any bridged keys (§4.6). A GCM failure
   means the invite is for someone else. There is no identity fetch and no
   per-inviter cache, and the trial reads only data already downloaded.
2. On success, fetch the sender's identity to compute `Z_SR` for a 1:1 grant
   (trying keys as in §4.2). A forged 1:1 invite yields a key nobody else
   holds, so it simply leads to an empty thread. The UI fetches the sender's
   profile at this point anyway to show the request, so the fetch reveals
   nothing extra to the node.

Scanning is limited by fetching, not decryption (§5.1.1).

**Sender recovery.** On a new device, the sender reads their own invites via
`[$ownerId, $createdAt]`, unmasks `selfHint` to get the recipient, re-derives
`e` from `hintKey` and the nonce, and confirms by decrypting.

**Duplicate 1:1 invites.** Before inviting B, A checks its own bucket scan for
an invite from B, and writes nothing if one exists. If both invite at the same
moment, the result is two harmless invites.

**Why this reverses the "hidden membership is too slow" objection in
`DM_V5_GROUPS.md` §9.** A recipient scans only its own bucket, not the whole
network, and each trial is one ECDH on data already downloaded. Invites are
small, fixed-size and rare next to messages. The observer learns only "A
invited someone in bucket x", and at `k = 0` not even the bucket.

#### 5.1.1 Measured scan throughput (2026-09-22)

The benchmark code is `scripts/bench-dm-scan*`. Crypto was measured in
Chromium 152 (Electron) on a 14-core Mac, over 2,000–4,000 invites. Fetching was
measured with 100-document pages of `post` against the moutai devnet, over an
equality-plus-`$createdAt` index, the same shape as the invite bucket query.

| Step | Per invite | Throughput |
| --- | --- | --- |
| Trial, one thread (`@noble/secp256k1` 3.1 ECDH + WebCrypto HKDF and AES-GCM) | 578 µs | ~1,700/s |
| Trial, 2 Web Workers | 301 µs | ~3,300/s |
| Trial, 4 Web Workers | 151 µs | ~6,600/s |
| Trial, 8 Web Workers | 93 µs | ~10,800/s |
| Node 22, one thread | 1,888 µs | ~530/s |
| Fetch, 1 query at a time | — | ~540/s (about 185 ms a page) |
| Fetch, 16 parallel queries over disjoint `$createdAt` windows | — | ~2,700/s |

Decryption scales almost linearly with workers, so 4 workers already outrun the
network by more than 2×. Fetching is the bottleneck, and parallel windows help
about 5×. Native X25519 would make a trial about 17× faster (34 µs), but it would
need a second published key per user. It was rejected because decryption is not
the bottleneck. Shielded
wallets use the same trick (16 queries in flight). The first query on a cold
connection took about 1 s.

#### Choosing `k`

**What `k` costs in privacy.** The observer already ranks A's likely DM partners
from A's public activity: replies, mentions, likes, quotes, mutual follows.
Every invite's bucket leaks exactly `k` bits about the recipient on top of that
ranking. The damage depends on how predictable the sender already is, not on
network size. For someone who publicly talks with the same four people, `k = 2`
roughly names the recipient. **`k = 0` leaks nothing,** and that is the target.

**What forces `k` up.** At `k = 0` every recipient downloads and trial-decrypts
every invite on the network. Steady-state polling is cheap at any volume a
bucket would allow. The binding cost is a **cold start**: a new device, or a
user returning after a long absence, has to catch up on everything since its
last scan. With the throughput in §5.1.1 (about 2,700 invites/s fetched, about
6,600/s decrypted on 4 workers), a budget of about 10 s for a 30-day catch-up gives
`B ≈ 900 invites/day`, or 27,000 a month. `k = 0` holds until the network sends
about that many invites a day. Invites are per new conversation or group add,
not per message, and Yappr sends tens a day today. `dmSelfState` records the
last scan position, so only a device that has never scanned, or a user away for
longer than the window, pays the full cost.

**Schedule.** `k` is computed by every client from chain data, identically, so
no one coordinates and no app or user picks its own `k`. A per-app or opt-in
`k` would fingerprint the sender's app or privacy setting.

```
V_m   = invites/day in calendar month m−1 (UTC, by $createdAt)
k_m   = clamp(ceil(log2(V_m / B)), k_{m−1} − 1, k_{m−1} + 1)   // one step per month at most
k_m   = min(k_m, K_CEIL)                                       // K_CEIL = 2
step down only if V_m < B · 2^(k−1) / 2                        // hysteresis
```

- **Counting costs nothing extra.** Each recipient already downloads its own
  bucket, so it estimates `V_m` as (invites in its own bucket last month) ×
  `2^k`. At `k = 0` that is the exact network count. At `k > 0` a bucket holds
  about `B` invites a day, roughly 180,000 a month, so each client's estimate is
  within about 1% of everyone else's. Clients can only disagree when `V_m` sits
  within about 1% of a step threshold, and hysteresis makes that rare.
- **No new index or flag.** A `rangeCountable` index would give every client
  the identical proved count, but it adds cost to every invite create for
  something the scan already provides.
- **Transitions and disagreement.** Senders use the `k` they computed for the
  month they write in. Recipients query last month's level, this month's
  level, and, when their estimate is within 5% of a threshold, the neighbouring
  level. All of this is one `bucket in [...]` query, so invites sent around a
  boundary, with clock skew, or by a client that estimated differently are
  still found.
- **Ceiling.** Past `K_CEIL` the leak per invite outweighs the benefit, so the
  client stays at the ceiling and raises `B` instead (faster scanning,
  a bigger bandwidth budget). If that runs out, bucketing is the wrong tool and
  discovery needs PIR or fuzzy message detection.
- **Flooding.** Pushing `V` over `B` means paying for thousands of invites a
  day for a month before `k` moves once. A flood that large already raises scan
  cost, so raising `k` is the right response, and `K_CEIL` bounds it.
- **Encoding.** `(1 << k) | prefix` gives every `(k, prefix)` a distinct value,
  so an invite's level is never ambiguous. The contract needs no `k` limits: an
  invite at a level nobody scans hurts only its sender.

### 5.2 Handles

```
rosterHandle      = HKDF(gid, "yappr/dm/v5", "roster\0")[0:10]
keyringHandle(b)  = HKDF(gid, "yappr/dm/v5", "keyring\0" || S16(b))[0:10]
```

- **Handles are always paired with the owner's `$ownerId`** in a unique index,
  so only the owner can occupy one.
- **Members find them easily,** in one query per owner:
  `$ownerId == O, handle in [...]`.
- **An observer cannot link handles to each other or to members by value.**
  Linking by timing is prevented by jitter (§5.5).

### 5.3 `dmMessage.body` and padding

```
body = iv(12) | AES-256-GCM(mk_i, iv, pad(type | payload), aad) // ciphertext || tag(16)
```

- **Size classes.** Padded plaintext is a power of two from **128 to 8192
  bytes**, plus a top class of **14,336 bytes** (14 KiB). The ciphertext is 28
  bytes longer.
- **Why three fields.** Platform caps any one field at 5,120 bytes and a whole
  state transition at 20,480 bytes, on every protocol version through v14.
  A ciphertext larger than 5,120 bytes is cut at 5,120-byte boundaries into
  `body`, `body2` and `body3`. The 14 KiB class is the largest that fits in one
  transition with room for the signature and document overhead. It is still one
  document with one index, so it costs about 27,400 credits per extra byte and
  nothing more.
- **Longer text** is split across several messages. A burst of top-class
  messages shows that something long was sent.
- **Other blobs.** Rosters and self-state use the same classes up to 4096
  (their single field). Invites use only the 128 class (§5.1).
- **Padding format:** `u16 length | plaintext | zeros`.

`DM_V5_GROUPS.md` rejected padding as paid storage. Its own cost data says
otherwise. Padding a short message to 128 bytes adds at most about 3.4M credits,
against a document whose fixed cost is in the 46–59M class. That is under 10%.
Size is a real correlation signal next to timing, so padding is always on.
Doubling classes waste at most half a message and about a quarter on average.

### 5.4 `dmKeyring.slots` (removal)

`kc(K[b,0])(8) | wrap_1 | … | wrap_n`: one 32-byte slot per remaining non-owner
member (§4.5), in shuffled order.

- **Padding.** The slot count pads with random slots to the next power of two
  from **8 to 128**, matching the message classes. An observer learns the group
  size to within 2×, and only when someone is removed. Coarser classes would
  hide more, but at 32 B a slot, padding 65 members to 128 instead of 64+
  costs about 55M credits per removal.
- **Unwrapping.** A member does one ECDH, derives its pad once, XORs each slot,
  and keeps the one whose `kc` matches.
- **Size limit.** The largest class is 8 + 128 × 32 = 4104 bytes, which fits the
  5120-byte field. The group limit is **100 members including the owner**
  (decided), well under the 129 the field allows.

### 5.5 `dmRoster`: the group's current state

```
rk    = HKDF(K[b,r], "roster\0")
blob  = iv(12) | AES-256-GCM(rk, iv, pad({b, r, name, avatarRef, members: [id(32), joinedAt S16(b) S16(r)]…}), aad=rosterHandle)
```

The owner creates the roster when the group is created, and **replaces** it on
every membership change and every rename. It does three jobs:
- **Epoch pointer.** It is the authoritative current `(b, r)`.
- **Roster.** Members need it to know whose streams to poll. The UI derives
  "X added Y" lines from the difference between versions.
- **Name and avatar.**

**Leak controls:**
- **No plaintext epoch.** A reader already knows the newest base from keyrings.
  It tries `rk` for `r`, `r+1`, … up to 16 steps ahead.
- **Padded blob.** It pads to the size classes, so the member count is hidden to
  within 2×. At 36 bytes per member, 100 members is about 3.6 KB, which fits
  the 4096-byte class.
- **Timing jitter.** Every roster replace that follows an invite or a keyring is
  delayed by a random 1–30 minutes, carried in the owner's local queue and
  retried on the next open. Without jitter, "invite, then roster replace" ties
  the new member's bucket to this group. This is a background write, not a
  user-visible delay: the new member reads the roster late, not their messages.
  Invites for a brand-new group go out immediately, so a burst of invites
  reveals "A created a group of about N" (§3).
- **Still visible:** `$revision`, which counts changes and renames (§3).

**The pointer never regresses.**
- The owner never writes a roster under a base older than the newest keyring.
- Readers use the maximum of `roster.b` and the newest keyring's base.
- A reader whose ratchet is ahead of the roster (the new member's invite landed
  but the roster has not) polls both `r` and `r+1` streams (§6.5).

### 5.6 `dmSelfState`: private cross-device sync

```
blob = iv(12) | AES-256-GCM(HKDF(stateKey, "slot\0" || u8(slot)), iv, pad(state))
```

The blob holds read positions, stream heads, contacts, and a **client-side**
block list, split across up to 8 slot docs of about 5 KB each. That is room for
about 1,000 conversations.

**Writes are debounced (at least 5 minutes) and never happen immediately on
read**, because a state update seconds after someone's message is a timing
signal. It ships in Phase 1: without it, read state and blocks would differ
between a user's devices.

## 6. Messages

### 6.1 Streams and tags

Every sender has their own stream in every epoch:

```
K         = the 1:1 key (§4.3) or K[b,r] (§4.4)
SK        = HKDF(K, "stream\0" || senderId)
tag_i     = HKDF(SK, "tag\0" || u32(i))[0:16]
mk_i      = HKDF(SK, "msg\0" || u32(i))
aad       = "yappr/dm/msg/v5" || tag_i || senderId
```

**Properties:**
- **Tags never repeat,** so an observer cannot group one sender's messages by
  conversation. They see "A wrote N DM documents".
- **Readers accept a document for `tag_i` only if `$ownerId` equals the
  stream's sender.**
- **The unique index is `[tag, $ownerId]`, not `[tag]`.** So a member who
  writes a document with another member's next tag blocks nothing: that write
  is simply ignored.
  - Two of the *same* sender's devices racing for one `i` still collide. The
    loser retries at `i + 1`.
  - A squatted tag does publicly show that two identities share a tag. That only
    lets an insider expose a membership the insider could publish anyway (§3).
  - A sender's own retry after a collision is a rejected transition in a block,
    next to the accepted one. Both carry the same owner, so it reveals nothing
    new.
- **Each epoch's streams start again at `i = 0`,** so a new member knows where
  to start without any hint.

**Why each sender has their own stream, rather than one shared counter per
conversation.** A shared counter would let readers poll a few tags per
conversation regardless of group size. But concurrent senders would then collide
by design. Rejected transitions are recorded in blocks (not in state), so the
loser's attempt at the winner's tag would publicly link them. Per-sender streams
never collide across participants.

**Plaintext types:**
- `0x01` text.
- `0x02` leave.
- `0x03` read receipt: opt-in and delayed (§8).
- `0x04` roster nudge: sent by the new member after joining, so members pick up
  the new ratchet early.
- `0x10` and up: reserved for replies, reactions and edits.

### 6.2 Sending

1. **Groups only:** read the roster and check for a keyring at `b+1`. This is one
   query per owner, and a read costs nothing.
2. **Write.** Messages go out immediately; send batching was considered and
   rejected for its latency (§8). Write `dmMessage{tag_i, body}` at the current `(b, r)`, using the
   next free `i`. Before advancing past `i`, read back `tag_i`. A 504 timeout
   does not prove the write failed or succeeded (CLAUDE.md, "DAPI Gateway
   Timeouts"). If the tag is missing, rebroadcast the same transition.

### 6.3 Receiving, unread counts and recovery

- **Polling.** Each conversation contributes the next **3 tags** of every
  member stream: the counterpart's and your own for 1:1 (your own catches your
  other devices), and all members for groups. Groups also contribute their roster
  and keyring handles.
  - Tags batch into `tag in [...]` queries of up to 100.
  - Handles go into one query per owner.
  - Twenty 1:1 chats cost 2 queries.
  - A 100-member group costs 3. To reduce this, the client can poll members idle
    for more than a day on every *other* poll.
  - Polling rides the existing 30 s notification poll, and runs every few
    seconds while a conversation is open.
- **Gaps.** A tag found out of order is held until the window fills. A tag
  missing for 3 consecutive windows is treated as a gap, meaning the sender's
  write was lost after a timeout.
- **Unread counts** are exact: new tags found past the read position. Once a
  window fills, the display becomes "N+" until the conversation opens. This
  replaces v4's count queries and its read receipts.
- **Recovery on a new device:**
  1. Scan your bucket for incoming invites.
  2. Read your own invites through `selfHint`.
  3. For each conversation, probe its streams forward in 100-tag batches, with
     exponential probe points to find the end.
  4. If `dmSelfState` is enabled, it caches stream heads, so step 3 is mostly
     skipped.

### 6.4 Reading

1. Decrypt with `mk_i`. On failure, drop the message as unreadable. It is
   either spam or something sent before you joined.
2. Apply the stale-base rule (§6.6).

### 6.5 Epochs in groups

**Add:**
1. The owner writes the new member's invite at `(b, r+1)`.
2. After jitter, the owner replaces the roster under `K[b,r+1]`.
3. From then on, everyone sends on the `r+1` streams.

Until members see the new roster, they keep sending on `r`. So every reader
polls **both `r` and `r+1` streams** from when it first learns of `r+1` until
every member has been seen on `r+1`, or 24 hours have passed. The new member is
the exception: it can only read `r+1`. It sends a `0x04` nudge on joining, and
any member who sees a message on `r+1` switches at once. **Messages sent on `r`
after the add are unreadable to the new member.** That is a delivery lag of at
most one poll after the nudge, and the UI surfaces it.

**Remove:**
1. The owner writes keyring `b+1`.
2. After jitter, the owner replaces the roster under `K[b+1,0]`.
3. Members poll `keyringHandle(b+1)` and unwrap their slot.

**Leave:**
1. The member sends a `0x02` leave message.
2. The owner's client runs Remove after a **random delay of 1–24 hours**, or
   batched with the next membership change.

An immediate automatic removal would tie the leaver's write to the owner's
keyring. Until removal, the leaver can technically still read, and the UI shows
them as "left".

### 6.6 Stale-base rule

A removed member still holds the keys for base `b` and can still compute its
stream tags. A message on base `b` is rejected if keyring `b+1` exists and
`msg.$createdAt > keyring[b+1].$createdAt + GRACE`.

- `$createdAt` is not chosen by the sender: Drive sets it to the block time of
  the block that includes the transition. So `GRACE` only has to cover a
  sender who checked for a new keyring (§6.2 step 1) just before it landed,
  plus inclusion delay. **2 minutes** is enough for a few blocks, and the
  client can widen it if blocks slow down.
- Honest late messages are rare, because of §6.2 step 1.

## 7. Operations and costs

| Operation | v4 | v5 writes | Notes |
| --- | --- | --- | --- |
| Start a 1:1 | 2 invites | **1** invite, which can carry the first message | So often 1 write for invite and first message together |
| Send | 1 message | **1** message | +16 B tag, plus padding (§5.3) |
| Create a group of N | n/a | N−1 invites + 1 roster | The owner has no slot: `S` is derived |
| Add a member | n/a | 1 invite + 1 roster replace | Nothing for existing members (ratchet) |
| Remove a member | n/a | 1 keyring + 1 roster replace | Invites are never deleted |
| Leave | n/a | 1 message, then the owner's Remove | |
| Rename | n/a | 1 roster replace | |
| Rotate encryption key | n/a | **1** bridge, total | 1:1 threads move on their own (§4.3) |
| Restore a member who lost their key | n/a | 1 invite | |
| Mark read | 1 receipt replace | 0 immediately; a debounced self-state replace at most every 5 min | |

On the read side, the bucket scan costs one ECDH trial per invite, and
polling costs one `in` query per ~33 member streams (3 tags each).

## 8. Remaining leaks, and what to do about them

The design removes every *structural* link. What remains is statistical. At
Yappr's scale, **timing is the dominant attack**. The anonymity set is the set
of DM users active *at the same time*, not all users. The first item is the one
that matters most.

- **Timing correlation.** If A writes, then B writes 20 seconds later, over and
  over, the pair shows up in simple co-occurrence statistics. Mitigations, from
  cheapest:
  1. **Jittered owner writes.** Roster and removal writes are delayed (§5.5,
     §6.5). They are background writes, so users do not wait on them.
  2. **Receipts** are delayed or off, and `dmSelfState` is debounced.
  3. **Optional cover traffic:** dummy documents on random tags. These cost real
     credits, so they are opt-in.

  **Send batching** (holding outgoing messages for a random 15–60 s tick) was
  rejected. It is the strongest cheap defence against back-and-forth
  correlation, but it makes every chat feel laggy. Live conversations are
  therefore linkable by a patient observer when few users are active at once.

  None of these defeats a global observer, and Signal does not claim to either.
  The UI should not over-promise.
- **Message and invite size** is limited to size classes (§5.3).
- **Group metadata.** Only the owner is linked to a group. An observer sees the
  roster's `$revision`, its size class, and keyring size classes (§3).
- **Removed members.** They know `gid` and the owner, so they can watch the
  owner's roster and keyring docs change. They learn *when* membership changes,
  never *who* changed.
- **The DAPI node you query** sees your IP next to the tags you expect. It can
  later match those tags to writes and link you to the counterpart. This is
  outside the "passive chain observer" goal, but it is realistic. Mitigations:
  - rotate nodes per query batch;
  - a "download everything" mode, as shielded wallets do (§12.1). The client
    fetches every `dmMessage` and matches tags locally, so the node learns
    nothing about which conversations you are in. It needs no extra index:
    walking the existing unique `[tag, $ownerId]` index in order,
    `tag > last, limit 100`, returns every message. It cannot fetch only
    *new* messages, though, because tags are random, so each pass is a full
    walk. That is fine for a few thousand messages (about 1 s at the rates in
    §5.1.1), but not at scale. So this mode suits small networks or occasional
    audits, not the default poll;
  - Tor.

  Decoy tags do not help, because the node can see which tags later get hits.
- **Blocking** must stay client-side (in `dmSelfState`). An on-chain `block` of
  a DM contact would publish the relationship.
- **Your own sender activity** (counts and times from `$ownerId`, `$createdAt`
  and nonces) stays visible, per goal 1.

## 9. Multi-device and failure handling (owner)

The owner's client **syncs before every membership write**: it reads the roster,
the keyrings, and its own invites.

After every write, it checks this invariant: **every roster member has either
an invite at the current base, or a slot in the latest keyring.** It also checks
that the roster's `(b, r)` is not behind the newest keyring.

- **Two devices add at once.** They produce the same deterministic key, so both
  invites are valid. The last roster replace wins. Each device re-reads,
  merges, and replaces again if a member is missing.
- **Two devices remove at once.** The unique `[$ownerId, keyringHandle(b+1)]`
  refuses one. That device re-syncs and, if its removal is still pending, writes
  `b+2`.
- **One device adds while another removes.** If the new member is missing from
  the keyring, the invariant fails. The fix is one more keyring covering the
  full roster. An add-device roster written under an older base is overwritten,
  because of the pointer rule (§5.5).
- **The invite lands but the roster replace fails.** It is retried on the next
  open. Meanwhile readers use the dual-poll rule in §6.5.
- **The keyring lands but the roster replace fails.** It is retried on the next
  open. Members find the keyring by handle anyway.

The owner cannot hand the group over in v1. If the owner leaves, the group ends.
Adding admins needs a second writer of keyrings, which is left for later.

## 10. Migration

- **v3/v4 threads stay readable** through the existing
  `direct-message-service` read path. They merge into the same timeline as the
  v5 thread with that counterpart. New sends always go to v5.
- **Users get a one-time notice.** Earlier conversations are publicly linkable
  and will stay that way. New ones are not.
- **Rollout** uses the topology flag `NEXT_PUBLIC_DM_TOPOLOGY=v5`, with contract
  ids and flag changed in one commit, as for the earlier re-cuts.

## 11. Roadmap

1. **Phase 1: this document.** Unlinkable 1:1 chats and groups, stateless
   recovery, no forward secrecy.
2. **Phase 2: post-quantum first contact (optional).** A per-user ML-KEM-768
   key, mixed into the 1:1 key agreement so that recorded ciphertext survives a
   future quantum break of secp256k1. It keeps stateless recovery.

   Per-device ratchets ("sealed chat", Signal's model) were **rejected**. They
   give forward secrecy, but a new browser or device would start with an empty
   history. That is not acceptable for a web app that users log into from many
   browsers. The coarse form of forward secrecy remains: rotate your encryption
   key without a bridge (§4.6).
3. **Phase 3: hiding the sender.** On Platform, signing is always done by
   `$ownerId`. Hiding the sender needs a throwaway identity per contact or per
   epoch, funded untraceably. Platform already has the transitions:
   `IdentityCreateFromShieldedPool` (fixed amounts of 0.1, 0.3, 0.5 or 1 DASH,
   so the amount does not link) and `IdentityTopUpFromShieldedPool`
   (platform#4711). The blocker is the browser: proving a shielded transition
   needs the Halo 2 prover, which exists only in Rust behind the Swift and
   Kotlin FFI. The WASM SDK left it out on purpose (platform#3235: over 10 MB of
   bundle, about 30 s per proof). Phase 3 waits for a browser prover or a
   companion wallet that funds the throwaway identity.
4. **Later: tip with a message.** DIP-33 (dips#188) reserves a shielded memo kind
   for pointing at "a larger encrypted context document". A shielded tip whose
   memo carries a DM seed would let someone pay and open a private thread in one
   step, with no document linking the two. Same browser-prover blocker.

## 12. Where the two drafts disagreed

| Topic | Privacy draft | `DM_V5_GROUPS.md` | Merged |
| --- | --- | --- | --- |
| Membership and the social graph | Hidden | Public `recipientId` / `groupId` (cheapest) | **Hidden.** It is goal 1. The bucketed scan answers the scaling objection (§5.1). |
| Key material | Signed prekey doc + X3DH | ENCRYPTION key, no key docs | **ENCRYPTION key.** A prekey doc adds a document per user and buys forward secrecy that goal 6 gives up anyway. |
| Groups | Sender keys | Owner-derived `S`, ratchet on add, keyring on remove | **Groups draft,** with keyrings and rosters moved under secret handles. |
| Read receipts | Encrypted in-stream | Public `dmReadReceipt` | **Local / self-state, with opt-in in-stream receipts.** |
| Padding | Size classes | None (storage cost) | **Size classes.** Under 10% of a document's cost (§5.3). |
| Unread counts | `tag in` window | rangeCountable count | **Tag window.** There is no shared id to count by. |
| Invite deletion | n/a | Deleted on removal (refund) | **Never deleted.** A delete would point at the removed member's bucket. |
| Key rotation | Not covered | One bridge doc | **Bridge,** plus 1:1 threads that move on their own. |

### 12.1 What was borrowed from Platform's shielded pool

Researched 2026-09-22 against `dashpay/platform` v4.2-dev and DIP-33
(`dashpay/dips#188`, the closest thing to an "OrchardPay"; no design by that
name exists).

| Orchard / shielded wallets | DM v5 |
| --- | --- |
| Each note has a fresh ephemeral key; a wallet recognises its notes with its own viewing key only | **Adopted** for invites (§5.1). The recipient needs no identity fetch per inviter. |
| Every encrypted note is exactly 216 bytes | **Adopted.** Invites are one fixed size; messages use size classes. |
| Wallets download *all* notes in index ranges (8,192 per query) and trial-decrypt locally, so the node learns nothing | **Adopted** for invites at `k = 0`. Offered as an optional mode for messages (§8), pending the index cost. Document queries return only 100 per page, so this is about 80× less efficient per request than note sync. |
| Spends are detected from data already downloaded, not by querying nullifiers (which would leak ownership) | **Adopted in spirit.** Duplicate-invite checks and the `k` estimate reuse the bucket download. |
| One viewing key covers unlimited diversified addresses (DIP-33 per-contact addresses) | Already present: one encryption key covers every per-conversation tag stream. |
| Shielded notes with memos as the transport | **Rejected.** The memo is 36 bytes (32 usable), each transfer costs about 0.0016 DASH and about 30 s of proving, the sender needs shielded funds, and there is no browser prover. |
| View tags, detection keys, fuzzy message detection | Not present in Platform's code, so there was nothing to borrow. |

DIP-33's deferred appendix also warns that notification documents can be linked
by timing to the payments they announce. That is the same timing leak §8
accepts for messages.

**Also rejected:**

| Alternative | Why rejected |
| --- | --- |
| One-time prekeys | Using one up needs a write that links the pair. |
| BIP-47-style public notification doc | Reintroduces leak #1. Bucketed scanning replaces it. |
| A keyring doc per member per epoch | N documents per removal instead of one. |
| The LKH tree from private feeds | Makes every invite about 250 bytes bigger to save about 2.5 KB per removal. Adds far outnumber removals. |
| Signal sender keys / MLS (TreeKEM) | O(N²) wraps, or strictly ordered commits plus published key packages per member. |
| Rekey on add | N−1 slots per add instead of zero. |
| Unique `[tag]` index | Lets a member squat another member's tag and block their sends. |
| A shared tag stream per conversation | Concurrent senders collide, and rejected transitions are visible in blocks, so a collision links them (§6.1). |

## 13. Verification plan

1. **Pure `lib/dm/` modules with Vitest specs.** Cover:
   - the key schedule and label separation, handles, tag and stream derivation;
   - invite sealing and recognition, and `selfHint`;
   - slot wrap and `kc` trial, and trial key selection across bridged keys;
   - padding, body and roster encoding;
   - the pointer rule, the dual-poll rule, the stale-base rule;
   - fixed test vectors.
2. **A linkability audit script.** Given a dump of every v5 document the battery
   wrote, it runs the known attacks:
   - hashing pairs;
   - joining on shared field values;
   - joining handles across owners;
   - clustering documents by size;
   - naive timing joins with jitter turned off, and then with it on.

   It must recover **no** pair or group edge from the structural attacks. The
   timing results are reported, not gated.
3. **`scripts/verify-dm-v5.mjs` on devnet**, which must **measure real credits**
   for every row of §7 before client work starts. That covers:
   - message size classes including the multi-field 8 KiB and 14 KiB ones,
     invites, keyrings
     at 8/16/32/64/128 slots, roster replaces, bridges;
   - spoofed keyrings and rosters under a stranger's `$ownerId`;
   - squatted tags under `[tag, $ownerId]`;
   - unique-index races.
4. **Scan throughput on real hardware,** re-running
   `scripts/bench-dm-scan-core.mjs` on a mid-range phone and against
   testnet/mainnet nodes, to confirm `B` (§5.1.1).
5. **Service and UI,** then deployed e2e on /devnet.

## 14. Decisions

Decided 2026-09-22:

| # | Question | Decision |
| --- | --- | --- |
| 1 | Bucket width `k` | Start at `k = 0`, and scale automatically with invite volume (§5.1). The estimate comes from each recipient's own bucket scan, so it adds no index and no cost. |
| 2 | Padding size classes | Powers of two, 128 to 8192 bytes, plus 14 KiB, using up to three 5,120-byte fields (Platform's per-field cap). Invites are always 128. Keyring slots pad to powers of two, 8 to 128. |
| 3 | Send batching | **No.** Messages send immediately; timing correlation is an accepted leak (§8). |
| 4 | Group size limit | **100** including the owner. |
| 5 | Cross-device read sync | **Yes,** `dmSelfState` ships in Phase 1 (§5.6). |
| 6 | Per-device ratchets ("sealed chat") | **No.** History must follow the user to any browser (§11). |
