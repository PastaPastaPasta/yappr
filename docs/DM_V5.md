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
   it means there is no forward secrecy against compromise of your own key (§11
   covers the later path).
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
| 4 | `readReceipt` publishes `(B, conversationId, time B read it)`. | Read state is local, optionally synced through an encrypted self-state doc (§5.6). |
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
throws away anyway. It comes back in Phase 2.

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
| `dmInvite` | inviter | `bucket` u16, `sealed` bytes 156–5000, `selfHint` b32 | `[bucket, $createdAt]`; `[$ownerId, $createdAt]` | immutable, **not deletable** |
| `dmMessage` | sender | `tag` b16, `body` bytes 156–5000 | **unique** `[tag, $ownerId]` | immutable, **not deletable** |
| `dmRoster` | group owner | `handle` b10, `blob` bytes 156–5120 | **unique** `[$ownerId, handle]` | mutable, not deletable |
| `dmKeyring` | group owner | `handle` b10, `slots` bytes 264–5120 | **unique** `[$ownerId, handle]` | immutable, not deletable |
| `encryptionKeyBridge` | key owner | `payload` b81 | `[$ownerId, $createdAt]` | immutable, not deletable |
| `dmSelfState` (optional) | user | `slot` u8, `blob` bytes 156–5120 | **unique** `[$ownerId, slot]` | mutable |

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

### 5.1 `dmInvite`: sealed, padded, bucketed first contact

```
bucket   = HKDF(recipientId, "yappr/dm/v5", "bucket\0")[0:2] masked to k bits
nonce    = 12 random bytes
ik       = HKDF(Z_inviter_recipient, "yappr/dm/v5", "invite\0" || nonce)
sealed   = nonce | AES-256-GCM(ik, iv=nonce, pad(grant), aad="yappr/dm/invite/v5" || $ownerId)
selfHint = recipientId XOR HKDF(hintKey, info="invite-self\0" || nonce)[0:32]
```

Here `ik` is unique per nonce, so reusing the nonce as the GCM IV is safe.

**Grant contents:**
- **1:1:** `0x01 | optional first message`. The recipient derives `gid` and
  `K` from `Z`. A first message carried in the invite **is index 0 of the
  inviter's stream** (§6.1), so the inviter's next message uses `i = 1`. This
  saves a document on every new conversation.
- **Group:** `0x02 | gid(10) | S16(b) | S16(r) | K[b,r](32)`. The recipient
  reads the name and roster from `dmRoster` (§5.5).

**Padding.** The grant pads to the §5.3 message size classes. The smallest class
(128 bytes) holds any group grant and a 1:1 grant with no message or a short
one. So an observer cannot tell a 1:1 invite from a group invite, and learns a
first message's length only to the nearest class.

**Discovery:**
- The recipient polls `bucket == mine, $createdAt > lastScan`. For each distinct
  `$ownerId` in the results, it fetches the identity (cached) and computes `Z`
  for each combination of the inviter's keys and its own keys (§4.2), usually
  one. For each invite it runs one HKDF and one AES-GCM trial. A GCM failure
  means the invite is for someone else in the bucket.
- At `k = 0`, the identity fetches, not the crypto, are the real cost.

**Sender recovery.** On a new device, the sender reads their own invites via
`[$ownerId, $createdAt]`, unmasks `selfHint`, re-derives `Z`, and confirms by
decrypting.

**Duplicate 1:1 invites.** Before inviting B, A checks its own bucket scan for
an invite from B, and writes nothing if one exists. If both invite at the same
moment, the result is two harmless invites.

**Why this reverses the "hidden membership is too slow" objection in
`DM_V5_GROUPS.md` §9.** A recipient scans only its own bucket, not the whole
network. The costly step, ECDH, happens once per *distinct inviter* rather than
once per invite. And invites are rare next to messages. The observer learns only
"A invited someone in bucket x".

| k | Anonymity set at 10k DM users | Trials per recipient at 1k invites/day network-wide |
| --- | --- | --- |
| 0 | everyone | 1000 |
| 4 | ~625 | ~63 |
| 8 | ~39 | ~4 |

`k` is a client constant, not part of the contract, so it can grow with the
network. If `k` changes, recipients also query their bucket under earlier `k`
values. Start at **k = 0–4**.

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

- **Size classes.** Padded plaintext is **128, 512, 2048 or 4972 bytes**, so
  the body is 156, 540, 2076 or 5000 bytes. Every encrypted blob in this
  contract (invite grants, rosters, self-state) uses the same classes.
- **Padding format:** `u16 length | plaintext | zeros`.

`DM_V5_GROUPS.md` rejected padding as paid storage. Its own cost data says
otherwise. Padding a short message to 128 bytes adds at most about 3.4M credits,
against a document whose fixed cost is in the 46–59M class. That is under 10%.
Size is a real correlation signal next to timing, so padding is always on, and
the size classes themselves are open decision 2.

### 5.4 `dmKeyring.slots` (removal)

`kc(K[b,0])(8) | wrap_1 | … | wrap_n`: one 32-byte slot per remaining non-owner
member (§4.5), in shuffled order.

- **Padding.** The slot count pads with random slots to the next of **8, 32 or
  128**, so an observer learns only a coarse group size, and only when someone
  is removed.
- **Unwrapping.** A member does one ECDH, derives its pad once, XORs each slot,
  and keeps the one whose `kc` matches.
- **Size limit.** The largest class is 8 + 128 × 32 = 4104 bytes, which fits the
  5120-byte field. That caps a group at **129 members including the owner**.
  Proposed limit: 100.

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
  about a 4× band. At 36 bytes per member, 100 members is about 3.6 KB, which
  fits the 4972-byte class.
- **Timing jitter.** Every roster replace that follows an invite or a keyring is
  delayed by a random 1–30 minutes, carried in the owner's local queue and
  retried on the next open. Invites for a new group go out on separate ticks.
  Without jitter, "invite, then roster replace" ties the new member's bucket to
  this group.
- **Still visible:** `$revision`, which counts changes and renames (§3).

**The pointer never regresses.**
- The owner never writes a roster under a base older than the newest keyring.
- Readers use the maximum of `roster.b` and the newest keyring's base.
- A reader whose ratchet is ahead of the roster (the new member's invite landed
  but the roster has not) polls both `r` and `r+1` streams (§6.5).

### 5.6 `dmSelfState`: optional private sync

```
blob = iv(12) | AES-256-GCM(HKDF(stateKey, "slot\0" || u8(slot)), iv, pad(state))
```

The blob holds read positions, stream heads, contacts, and a **client-side**
block list, split across up to 8 slot docs of about 5 KB each. That is room for
about 1,000 conversations.

**Writes are debounced (at least 5 minutes) and never happen immediately on
read**, because a state update seconds after someone's message is a timing
signal. With self-state disabled, read state stays on the device.

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
- **Each epoch's streams start again at `i = 0`,** so a new member knows where
  to start without any hint.

**Why each sender has their own stream, rather than one shared counter per
conversation.** A shared counter would let readers poll a few tags per
conversation regardless of group size. But concurrent senders would then collide
by design. If rejected transitions are visible on chain, and fee-charged failed
transitions may well be, the loser's attempt at the winner's tag would publicly
link them. Battery item 4 settles this.

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
2. **Wait for the send tick.** Outgoing messages leave on a randomised 15–60 s
   tick (§8, open decision 3).
3. **Write.** Write `dmMessage{tag_i, body}` at the current `(b, r)`, using the
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
    for more than a day every *other* tick.
  - Polling rides the existing 30 s notification poll.
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

- `GRACE` must exceed Platform's `$createdAt` tolerance plus the maximum send
  tick. 10 minutes is proposed, and battery item 5 confirms it.
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
| Mark read | 1 receipt replace | **0** (local), or a debounced self-state replace | |

On the read side, the bucket scan costs about one ECDH per new inviter, and
polling costs one `in` query per ~33 member streams (3 tags each).

## 8. Remaining leaks, and what to do about them

The design removes every *structural* link. What remains is statistical. At
Yappr's scale, **timing is the dominant attack**. The anonymity set is the set
of DM users active *at the same time*, not all users. The first item is the one
that matters most.

- **Timing correlation.** If A writes, then B writes 20 seconds later, over and
  over, the pair shows up in simple co-occurrence statistics. Mitigations, from
  cheapest:
  1. **Send ticks.** Outgoing messages leave on randomised ticks (§6.2).
  2. **Jittered owner writes.** Roster and removal writes are delayed (§5.5,
     §6.5).
  3. **Receipts** are delayed or off, and `dmSelfState` is debounced.
  4. **Optional cover traffic:** dummy documents on random tags. These cost real
     credits, so they are opt-in.

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
  - an optional mode that downloads the global `dmMessage` window and matches
    locally (fine at today's volume, not at scale);
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
2. **Phase 2: forward secrecy and post-quantum keys.** This is more urgent than
   for Signal, because every ciphertext is public forever ("harvest now, decrypt
   later"). Planned pieces:
   - A signed prekey plus an ML-KEM-768 key in a per-user doc, used for PQXDH on
     first contact. The ciphertext alone is 1,088 bytes, which fits the invite's
     2,048-byte class.
   - Double Ratchet on 1:1 streams.
   - Sender-chain ratchets in groups.

   The cost is stateless recovery. Ratchet state cannot be recomputed, so each
   device needs its own session (Signal's Sesame model), and every message is
   sent once per device. This should be offered as an opt-in "sealed chat" mode
   rather than the default. The coarse form of forward secrecy is already
   available: rotate without a bridge (§4.6).
3. **Phase 3: hiding the sender.** On Platform, signing is always done by
   `$ownerId`. Hiding the sender needs a throwaway identity per contact or per
   epoch, funded untraceably through the shielded pool:
   - The installed SDK has `sdk.addresses.createIdentity` and `topUpIdentity`.
   - `sdk.shielded` is **read-only** for now; building shielded transitions
     needs the Orchard prover, which the SDK has deferred. So this phase is
     blocked on SDK work.
   - A further option is Orchard note memos as the transport itself. That hides
     everything, but hits the same trial-decrypt-everything scaling wall as Zcash
     light clients.

## 12. Where the two drafts disagreed

| Topic | Privacy draft | `DM_V5_GROUPS.md` | Merged |
| --- | --- | --- | --- |
| Membership and the social graph | Hidden | Public `recipientId` / `groupId` (cheapest) | **Hidden.** It is goal 1. The bucketed scan answers the scaling objection (§5.1). |
| Key material | Signed prekey doc + X3DH | ENCRYPTION key, no key docs | **ENCRYPTION key.** A prekey doc adds a document per user and buys forward secrecy that goal 6 gives up anyway. It moves to Phase 2. |
| Groups | Sender keys | Owner-derived `S`, ratchet on add, keyring on remove | **Groups draft,** with keyrings and rosters moved under secret handles. |
| Read receipts | Encrypted in-stream | Public `dmReadReceipt` | **Local / self-state, with opt-in in-stream receipts.** |
| Padding | Size classes | None (storage cost) | **Size classes.** Under 10% of a document's cost (§5.3). |
| Unread counts | `tag in` window | rangeCountable count | **Tag window.** There is no shared id to count by. |
| Invite deletion | n/a | Deleted on removal (refund) | **Never deleted.** A delete would point at the removed member's bucket. |
| Key rotation | Not covered | One bridge doc | **Bridge,** plus 1:1 threads that move on their own. |

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
| A shared tag stream per conversation | Collision risk (§6.1). Revisit once battery item 4 has an answer. |

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
   - message size classes, invites with and without a first message, keyrings
     at 8/32/128 slots, roster replaces, bridges;
   - spoofed keyrings and rosters under a stranger's `$ownerId`;
   - squatted tags under `[tag, $ownerId]`;
   - unique-index races.
4. **Are rejected transitions visible?** Establish whether a document create
   rejected by a unique index shows up on chain or in anything a node exposes.
   The answer decides the choice in §6.1.
5. **`$createdAt` tolerance,** to set `GRACE`.
6. **Service and UI,** then deployed e2e on /devnet.

## 14. Open decisions

1. **Bucket width `k`.** Start at 0–4.
2. **Padding size classes.** They trade cost against the size leak.
3. **Send-tick interval.** UX latency against timing privacy. Should ticks be
   on by default?
4. **Whether to ship `dmSelfState` in Phase 1,** or keep read state per device.
5. **Group size limit.** 100 is proposed, and the ceiling is 129.
6. **Whether Phase 2 "sealed chat"** (per-device sessions, true forward secrecy)
   is worth its fan-out cost.
