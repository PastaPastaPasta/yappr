# DM v5: unlinkable 1:1 and group messaging

Status: **design, not implemented.** Revised 2026-09-23 after a simplification
review (§12.3). Supersedes the 1:1-only DM contract
(`contracts/yappr-dm-contract.json`, topology v3/v4) for new conversations. It
merges the metadata-privacy research with `DM_V5_GROUPS.md` (branch
`design/dm-v5-groups`).

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
4. **Store as little as possible.** Each stored byte costs about 27,000
   credits, but the fixed cost of a document and each of its index entries
   dominates (a follow is about 46M credits, a like about 59M). Minimise, in
   this order: **documents per operation, index entries per document, bytes
   per document.**
5. **History follows the user.** Any browser the user logs into rebuilds their
   conversations from the login-derived encryption key plus chain data: their
   encrypted self-state (§5.5) and messages still inside the retention window
   (§5.6). So there is no forward secrecy against compromise of your own key.
   This is deliberate: Yappr does not try to replace Signal.
6. Static export, no backend, one document per state transition. Everything
   runs in the browser, and only while the app is open.
7. **Buildable and debuggable by one maintainer.** Prefer one mechanism over
   several, and no protocol machinery for rare events.

The design rests on one rule. **No field on chain is shared between the
documents of two different participants, and no field can be derived from
public identity ids.** Everything that locates a conversation's documents is a
pseudorandom value that only its members can compute.

## 2. What v4 leaks today

Each of these links is enough on its own to reveal a pair.

| # | v4 leak | v5 fix |
| --- | --- | --- |
| 1 | `conversationInvite` stores `$ownerId = A` next to `recipientId = B` in plaintext, with an index on recipient. It is a public edge list. | Invites name no recipient. Each is a sealed check only the recipient can verify (§5.1). |
| 2 | `conversationId = sha256(A:B)[0:10]`. Anyone can hash every pair of users and reverse every conversation. | There is no conversation id on chain. |
| 3 | A's and B's messages share one `conversationId`, so the index groups the pair. | Every message has a one-time tag (§6.1). |
| 4 | `readReceipt` publishes `(B, conversationId, time B read it)`. | Read state lives in an encrypted self-state only the user can read (§5.5). |
| 5 | Static ECDH on the auth key. | ECDH on the ENCRYPTION key. |

v4 history is **permanently** linkable. Deleting its documents does not remove
them from block history. Migration must say this plainly (§10).

## 3. Threat model

**Protected against:**
- **A passive chain observer linking participants.** They cannot tell who
  messages whom, which documents belong to the same conversation, or who is in
  a group.
- **Non-members, and Platform itself, reading content,** group names or
  rosters.
- **Removed members reading messages sent after their removal,** once the
  other members' clients have seen the keyring (seconds; §6.4).
- **New members reading messages sent before they joined.**
- **One member impersonating another.** Platform signs `$ownerId`, and readers
  accept a stream's documents only from that stream's sender (§6.1).

**Still visible to a passive observer (accepted):**
- Per identity: the number of DM documents, when they were written, and their
  size class.
- Per group owner: that they own some group documents, how often each changes
  (`$revision`), and size classes.
- That an owner created a group or added someone, and how many people were
  granted. The roster write right after the grants marks them as grants, and
  their count is the group's size at creation. Who they went to stays hidden.
- **Timing correlation** (§8). There is no send batching and no random delay
  anywhere.

**Out of scope:**
- **The nodes that answer your queries** (§8). A node that serves your polls
  learns your contacts and group memberships over time. Accepted for Phase 1.
- Compromise of your own encryption key.
- Members leaking content or membership.
- Hiding the *sender* (§11).
- Deniability.

## 4. Keys

### 4.1 Notation

- `HKDF(ikm, info)` is HKDF-SHA256 with salt `"yappr/dm/v5"` and a 32-byte
  output unless noted. Every `info` is a fixed ASCII label, a NUL byte, then
  fixed-width fields, so no two derivations share an input.
- `S16`, `U32` are big-endian u16 and u32. `b` and `r` are u16.
- **`week`** is `floor(time_ms / 604,800,000)`, as a u32. Clients take
  `time_ms` from the latest Platform block time the SDK has returned, never the
  device clock. A slightly stale value costs latency, not messages (§6.3), so
  a client never refuses to send because of it.
- Every AES-256-GCM encryption uses a **fresh random 12-byte IV**, because two
  devices can derive the same key.

### 4.2 Identity keys

Each participant needs an active ENCRYPTION key of type ECDSA_SECP256K1, found
with `findEncryptionKey` (`lib/crypto/encryption-key-lookup.ts`). The private
key is the login-derived one (`deriveYapprEncryptionKeyFromLogin`), the same
key private feeds use. A counterpart without one cannot be messaged; the UI
says so and links to the add-key flow. Contract-bound keys stay off for now
(`NON_SOCIAL_CONTRACTS.md`). Once DashPay Connect v2 ships, DMs move to the DM
contract's bound key; that is a key rotation (Appendix A).

**No document carries a key id,** so which key a client uses is purely a
client concern. That is what lets key rotation be designed now and built later
(Appendix A).

`selfRoot = HKDF(encPriv, "self\0")` and `stateKey = HKDF(selfRoot,
"state-key\0")`. The self-state is sealed under `stateKey` (§5.5); group ids
the user owns derive from `selfRoot` (§4.4).

### 4.3 1:1 keys: nothing stored

```
Z    = ECDH_x(encPriv_A, encPub_B)                     // = ECDH_x(encPriv_B, encPub_A)
gid  = HKDF(Z, "direct-id\0"  || id_lo || id_hi)[0:10]  // ids sorted by byte order
K    = HKDF(Z, "direct-key\0" || gid)
```

Both parties derive `gid` and `K` alone, so no key is sent or stored, and
starting a chat twice lands in the same thread. `gid` never appears on chain.
A 1:1 chat never turns into a group; adding a third person creates a group.

### 4.4 Group keys

Members of three or more cannot derive a shared key from public keys alone (it
needs pairings or multilinear maps, which secp256k1 lacks). So the **owner**,
the group's creator, derives it and hands it out.

```
gid_n   = HKDF(selfRoot_owner, "group\0" || U32(n))[0:10]   // the owner's n-th group
S       = HKDF(encPriv_owner, "group-secret\0" || gid_n)     // never leaves the owner
K[0,0]  = HKDF(S, "base\0" || S16(0))                        // first base, at creation
K[b,0]  = HKDF(S, "base\0" || S16(b) || nonce_b)             // new base b on each removal; nonce_b is
                                                               // 16 random bytes stored in keyring b
K[b,r]  = HKDF(K[b,r−1], "ratchet\0" || S16(b) || S16(r))    // one step on each add
kc(K)   = HKDF(K, "kc\0")[0:8]                               // key check
```

- **The owner stores nothing.** On any device they rebuild their groups by
  querying the roster handles (§5.2) of `gid_0, gid_1, …` in batches of 100
  (`$ownerId == me, handle in [...]`), stopping at an empty batch.
- **`n` is never reused.** An ended group's roster becomes a small tombstone
  and group documents cannot be deleted (§5), so a new group never inherits an
  old group's keys. If two owner devices pick the same `n`, the unique index
  rejects the second roster create and that device takes `n + 1`.
- **Adds cost existing members nothing.** Anyone holding `K[b,r]` can step to
  `K[b,r+1]`. The new member receives `K[b,r+1]` and cannot step back.
- **Removals need a new base.** Only the owner has `S`, so the removed member
  cannot compute `K[b+1,0]`. It reaches the others in one keyring (§5.3).
- **Adds are deterministic per `(gid, b, r)`,** so two owner devices doing the
  same add produce the same key. **Bases are not:** each keyring carries a
  fresh random `nonce_b`. If two owner devices remove different members at
  once, the unique index rejects one keyring, but its transition stays in
  block history. Without the nonce it would wrap the *same* new key for the
  member the other device removed. With it, the rejected keyring's key is
  simply unused.

### 4.5 Sealing a key to a member

Keyring slots use static-static ECDH, with no ephemeral key:

```
pad  = HKDF(ECDH_x(encPriv_owner, encPub_member), "slot\0" || gid || ownerId || memberId || S16(b))
wrap = K[b,0] XOR pad
```

Each `(pair, group, base)` always wraps the same `K[b,0]`, so no pad masks two
different values. Only the group owner can write the document (§5.2), and
`kc` tells a member which slot is theirs.

## 5. Documents

New contract, `yappr-dm-contract-v5.json`. Four doctypes.

| Doctype | Owner | Fields | Indexes | Rules |
| --- | --- | --- | --- | --- |
| `dmInvite` | inviter | `bucket` u16, `epk` b33, `check` b16 | `[bucket, $createdAt]` | immutable, `canBeDeleted: false` |
| `dmMessage` | sender | `tag` b16, `body` 156–5120 B, optional `body2`/`body3` ≤ 5120 B | unique `[tag]` | immutable; deleted by the sweep |
| `dmGroupDoc` | group owner | `handle` b10, `blob` 156–5120 B | unique `[$ownerId, handle]` | mutable, `canBeDeleted: false` |
| `dmSelfState` | user | `blob` 156–5120 B, optional `blob2`/`blob3` ≤ 5120 B | unique `[$ownerId]` | mutable; deletable by its owner (the sweep never does) |

- **No doctype has a recipient, group or conversation field.**
- **No `refersTo` or `propertyAgreement`:** each adds a read to every write.
- `dmMessage`'s tag index is **unique `[tag]`**, the cheapest layout. Drive
  stores a unique index's reference directly under the value; a non-unique
  index needs an extra subtree per value to hold several documents, and a
  second property (`$ownerId`) adds another tree level. Every tag is distinct,
  so that extra structure would be paid on every message for nothing.

### 5.1 `dmInvite`: first contact

An invite says only "I, `$ownerId`, want a 1:1 channel with you". It carries
no content. It borrows Orchard's note trick: a fresh ephemeral key, so the
recipient recognises its invites with its own private key alone.

```
e      = random scalar;  epk = e·G                                         // 33 B
check  = HKDF(ECDH_x(e, encPub_R), "invite\0" || $ownerId || epk)[0:16]    // R computes ECDH_x(encPriv_R, epk)
bucket = (1 << k) | (HKDF(R, "bucket\0")[0:2] >> (16 − k))                  // §5.1.2; k = 0 gives 1
```

- **Every invite is the same size** (about 51 bytes of fields).
- **The sender is `$ownerId`,** which Platform signs, and it is bound into
  `check`. A copy re-posted by anyone else fails the check.
- **Sending:** A writes one invite, then sends its first message as a normal
  `dmMessage` (§6.1). Before inviting B, A checks whether a conversation with B
  already exists: in its self-state, or as an invite from B in its own scan. If
  it does, A writes no invite. At most one invite exists per started pair.
- **Invites are never deleted.** That makes lost-state recovery of every
  incoming chat possible (§9). At tens of invites a day network-wide, the
  unclaimed refund is a few DASH a year across all users.

**Discovery.** Each poll, the recipient fetches new invites in its buckets
(§5.1.2) and, for each, computes one ECDH with its own key and checks `check`.
A mismatch means "not mine". On a match it fetches the sender's identity
(needed anyway to show them), derives the 1:1 keys (§4.3), and the
conversation appears in the inbox as a normal first DM.

**Who can reach you.** Anyone. The chain cannot filter without revealing the
recipient. Blocking someone adds them to the block list in the self-state;
their invites, messages and grants are dropped after decryption.

#### 5.1.1 Measured scan throughput (2026-09-22)

Benchmark: `scripts/bench-dm-scan*`. Crypto was measured in Chromium 152 on a
14-core Mac. Fetching was measured with 100-document pages against the moutai
devnet, over an equality-plus-`$createdAt` index.

| Step | Per invite | Throughput |
| --- | --- | --- |
| Trial, one thread (`@noble/secp256k1` ECDH + WebCrypto) | 578 µs | ~1,700/s |
| Trial, 4 Web Workers | 151 µs | ~6,600/s |
| Fetch, one query at a time | — | ~540/s |
| Fetch, 16 parallel queries over disjoint `$createdAt` windows | — | ~2,700/s |

The measured trial used AES-GCM; the HKDF check costs about the same, since
ECDH dominates. **Fetching is the bottleneck.** Native X25519 would decrypt
17× faster but needs a second published key per user; rejected, because
decryption is not the bottleneck.

#### 5.1.2 Buckets (`k`)

Each bucket level splits invites by recipient. A higher `k` means less to
scan, but every invite then leaks `k` bits about its recipient on top of what
the observer already guesses from public replies and follows. **`k = 0` leaks
nothing and is the target.**

```
my levels : [bucket(me, 0), bucket(me, 1), bucket(me, 2)]     // = [1, 2|p1, 4|p2]
recipient : always scans all three, in one `bucket in [...]` query
sender    : k = clamp(ceil(log2(V / B)), 0, 2)
            V ≈ n0 + 2·n1 + 4·n2   // invites/day the sender itself saw at each level, last 30 days
            k = 0 with no scan history
```

- **Disagreement is harmless.** Recipients scan every level, so a sender with
  a different estimate still reaches them. No coordination, no transition
  windows.
- **`B` ≈ 900 invites/day** network-wide: the volume at which a device away for
  30 days catches up in about 10 s (§5.1.1). Yappr sends tens a day. `k` stays
  0 for a long time.
- **The ceiling is 2.** Beyond that the leak outweighs the saving, and scanning
  needs a different tool.

### 5.2 Group documents and handles

A group's roster and keyrings are all `dmGroupDoc`s owned by the group owner,
told apart by handle:

```
roster(g)      = HKDF(gid, "roster\0")[0:10]
keyring(g, b)  = HKDF(gid, "keyring\0" || S16(b))[0:10]
```

- Only members can compute handles. The unique `[$ownerId, handle]` index
  means only the owner can occupy one.
- A member fetches everything for all groups of one owner in one query:
  `$ownerId == O, handle in [...]`.
- Keyrings are never replaced. That is a client rule, since the owner is the
  only writer.

### 5.3 Keyring: removing someone

`blob = nonce_b (16 B) | kc(K[b,0]) (8 B) | slot | slot | …`, with one 32-byte slot (§4.5) per
remaining member except the owner, in random order. The slot count is padded
with random slots to a power of two from 8 to 128, so an observer learns the
group's size only to within 2×. At the 100-member limit a keyring is about
4.1 KB.

Keyrings are permanent: each removal costs its owner a document that is never
refunded. Removals are rare, so this is accepted.

### 5.4 Roster: the group's current state

```
blob = iv | AES-256-GCM(HKDF(K[b,r], "roster\0"), pad({b, r, name, avatarRef, members[], ended?}), aad = handle)
```

The owner replaces the roster immediately after every grant, keyring, or
rename. It holds the current epoch `(b, r)`, the member list (whose streams to
poll), and the name and avatar. The epoch is not in plaintext. A reader tries
`K[b, r]`, `K[b, r+1]`, … until it decrypts. Each add is at least one roster
replace, so at most `$revision − (last seen $revision)` steps are needed; the
client caches the last seen `$revision` per group. Keyrings are applied first,
so `r` restarts at 0 on a new base. When a group ends, the roster becomes a
tombstone (`ended`).

### 5.5 `dmSelfState`: cross-device state

```
blob = iv | AES-256-GCM(HKDF(stateKey, "state\0"), pad(state))     // spread over blob/blob2/blob3
```

**What it holds:**
- **Conversations:** for a 1:1, the peer; for a group, `gid`, owner, and the
  earliest group key the user was granted, with its epoch. Later epochs of the
  same base come from ratcheting forward, and later bases from the user's
  keyring slots, so one key reads all of the user's group history. Each
  conversation also has `since` (the week it started) and `readAt` (a
  `$createdAt`: everything newer is unread).
- Blocks as `identity → (blocked, changedAt)`, so an unblock survives a
  merge. Each conversation's `hiddenAt` ("delete conversation"; a message newer
  than it un-hides the chat). Settings (including retention) with the time they
  were last changed, the invite scan position, and, for owners, the next group
  number `n`.
- `pastKeys`, empty in Phase 1 (Appendix A).

Where each stream is up to is **not** stored. Devices find it from the chain
(§6.3).

**One document, one atomic replace.** About 15 KB across three fields,
roughly 290 conversations (about 52 bytes per 1:1, 98 per group). **That is
the Phase 1 cap, and it is a lifetime cap:** entries are never dropped,
because a dropped entry would stop both polling and sweeping, and a 1:1 you
started has no invite addressed to you to rediscover it from. "Delete
conversation" hides it; it reappears if a new message arrives. Unanswered
invites from strangers also take slots, so blocking spam matters. At the cap
the app says so, and newly discovered conversations still show but are not
saved until there is room. Splitting the state comes later if people hit the
cap.

**Two devices saving at once:** Platform rejects a replace whose revision is
not current + 1 (error 40106). The losing device re-reads, merges
(conversations are a union; `readAt` and `hiddenAt` take the maximum; each
block entry and the settings take the newer `changedAt`; the scan position
takes the minimum, so no invite is skipped) and saves again. The loser often
sees only a DAPI timeout, not the 40106, so a replace whose result is
uncertain is read back: unless the document now holds exactly its fields at
the next revision, it merges and saves again.

**When it is written:** changes are coalesced to save fees, and flushed when
the page is hidden or closed (`visibilitychange`/`pagehide`). It is also
written immediately when the user starts a conversation, so their other devices
find it. Incoming 1:1s need no immediate write, because invites are permanent
and every device scans them. **Joining a group does:** its grant sits in a 1:1
stream the sweep deletes, and once the roster moves on (the member is later
removed) the grant no longer verifies, so a join left to the coalesced save is
lost with the page. **The invite scan position never advances past an invite
whose conversation is not yet saved.** It is written
together with the conversations found up to it, so a crash before a save, or
a full state at the cap, means the next scan finds those invites again rather
than skipping them.

### 5.6 Deletion sweep: fee saving, not privacy

Deleting a document refunds part of its storage fee: measured on moutai,
about half for a 156-byte message and 76–90% for a 4 KB one (the fixed
document cost is not refunded). Only the owner can delete, so each user reclaims what they
wrote. The write stays in block history forever.

**The sweep** deletes the user's own messages by **whole tag weeks**, oldest
first, in shuffled order across conversations. Per conversation it walks the
user's own `prev` chain (§6.1) back from their newest message; that chain
crosses weeks and group epochs, so no epoch has to be enumerated. Every own
message in a week that is entirely older than the retention age is deleted.
The client caches the oldest surviving own message per conversation, so later
sweeps resume from there. Nothing else is swept: invites and group documents
are permanent, and the self-state is only ever replaced.

- **Retention is a user setting:** 30 days (default), 90 days, 1 year, or
  never. A message lives 30 to 37 days on the default.
- **It reveals nothing.** Creation times are already public, and a whole week
  goes at once across all conversations.
- **On a new device,** each side's history reaches back as far as that
  sender's own retention allows.
- **Wording.** The setting must say so plainly:

  > **Reclaim message fees**
  > Delete your sent messages from Dash Platform after 30 days and get most of
  > their storage fee back. This saves money. It does not make old messages
  > private: copies remain in the blockchain's history, and the people you
  > messaged keep what they have.

  Never "disappearing", "self-destructing" or "delete for everyone".

### 5.7 Padding

Every encrypted blob is padded (`u16 length | plaintext | zeros`) to a size
class, so its length reveals only the class:

- **Messages, Phase 1:** one `body` field, classes 128, 256, 512, 1024, 2048,
  4096 bytes. Longer text is split across messages. The contract keeps
  `body2`/`body3`, so 8 KiB and 14 KiB classes (Platform caps a field at 5,120
  bytes and a transition at 20,480) can be added for media without a re-cut.
- **Roster:** the same classes up to 4096. **Self-state:** up to about 15 KB
  over three fields.

Padding a short message to 128 bytes costs about 3M credits, under 10% of the
document.

## 6. Messages

### 6.1 Streams, tags and back-links

Every sender has a stream in every conversation epoch:

```
K         = the 1:1 key (§4.3) or K[b,r] (§4.4)
SK        = HKDF(K, "stream\0" || ownerId || senderId)        // ownerId: the group owner; 32 zero bytes for a 1:1
tag[w,j]  = HKDF(SK, "tag\0" || U32(w) || U32(j))[0:16]      // w = week, j = 0, 1, 2 … within the week
mk[w,j]   = HKDF(SK, "msg\0" || U32(w) || U32(j))
body      = iv | AES-256-GCM(mk[w,j], pad(prev | type | payload), aad = "yappr/dm/msg/v5" || tag || senderId)
prev      = U32(w) | S16(b) | S16(r) | U32(j)   // the sender's previous message in this conversation, any epoch; zero if none
```

- **Tags look random and never repeat,** so an observer cannot group one
  sender's messages by conversation.
- **Streams are bound to the group's owner.** A member who copies a roster
  under their own identity and "adds" someone creates a separate, empty group:
  its streams derive differently, so it never exposes the real group.
- **Readers accept a document only if `$ownerId` is the stream's sender.**
  Anything else at that tag is ignored.
- **One document per tag.** Two of your own devices picking the same `j` get
  one rejection; the loser retries at `j + 1`, so each stream stays strictly
  ordered.
- **A member could squat another member's next tag** (only members can compute
  tags). The victim's client just retries at the next `j`. The squatter pays a
  document per blocked slot, is visible to the owner and can be removed; it is
  the same insider abuse as spamming. The victim's rejected write, recorded in
  a block next to the squatter's document, shows only that the two share a
  conversation, which an insider can publish anyway.
- **The count restarts each week.** Messages are deleted in whole weeks, so a
  device that knows nothing starts at the current week's `j = 0` and never
  mistakes "deleted" for "never sent".
- **`prev` links each message to the sender's previous one,** across weeks and
  epochs. A reader uses it to fill any gap and to scroll back without querying
  empty weeks (§6.3).
- **Why weeks.** Days roll over too often, months keep messages too long, and
  Platform epochs differ between networks.

**Why one stream per sender, not one per conversation.** With a shared stream,
two members sending at once would write the same tag. The rejected transition
is recorded in a block, so the collision would link them.

### 6.2 Message types

- `0x01` **text.**
- `0x02` **leave** (groups). The owner's client removes the sender on its
  next poll.
- `0x05` **group grant**: `gid | S16(b) | S16(r) | K[b,r]`, sent by an owner on
  its 1:1 stream to a member. The member accepts it only if:
  - it came on the counterpart's stream;
  - the roster at `roster(gid)` under `$ownerId == sender` decrypts with that
    key (or one derived from it by ratchet or a newer keyring) and lists the
    member.

  So only the real owner can add you, and forwarded keys add you to nothing.
  A 1:1 that holds only grants is hidden from the inbox (the group shows
  instead) until its first text message. It is still in the self-state, so
  messaging that person never writes a second invite.
- `0x03`, `0x04`, `0x06`: reserved. Read receipts, join nudges and automatic
  key resends were removed in review (§12.3).
- `0x10` and up: reserved for replies, reactions and edits. Phase 1 is text
  only.

### 6.3 The client loop

Streams are polled for their **next** tag. A hit pulls the rest of that week.
`prev` fills any gap. Polling runs every 30 s, every few seconds while a
conversation is open, and once when the app opens.

```
# Local cache per stream: cur = newest (w, j) held, or none. Self-state as in §5.5.
# A 1:1 is a group with members {me, peer}, one fixed epoch and no group documents.

POLL():
  for each group owner O:  APPLY(groups of O, query dmGroupDoc where $ownerId == O, handle in [roster, next keyring] of each, orderBy handle)
  want = []
  for c in conversations, s in members(c):
    if s == me and not (c.open or appJustOpened): continue          # own stream: catches your other devices
    st = stream(c, s, c.epoch)
    if st.cur == none:  want += [(w, 0) for w in max(week(c.readAt), c.since, curWeek − 52) .. curWeek]
    else:               want += [(st.cur.w, st.cur.j + 1)] + [(w, 0) for w in st.cur.w + 1 .. curWeek]
    want += st.stale                                                 # old week or epoch, kept 10 minutes
  for each hit in query dmMessage where tag in want (100 per query, orderBy tag), keeping docs whose $ownerId == sender:
    DRAIN(hit)
  for i in query dmInvite where bucket in myLevels, $createdAt >= scanCursor, orderBy [bucket, $createdAt]
           (results come bucket by bucket, so read them all before moving the cursor; skip ids already seen at scanCursor):
    if check verifies, sender not blocked, no conversation with sender:  add 1:1 (since = week(i))
  advance scanCursor to the newest $createdAt read

DRAIN(st, w, j):            # a hit: take the rest of week w, 100 tags per query (holes are fine)
  RECEIVE each doc from (w, j) onward until a page returns nothing
  if w > st.cur.w: st.stale += next tag of the old week, for 10 minutes
  st.cur = (w, last j found)

RECEIVE(st, doc):
  m = decrypt with mk, else drop
  if group, doc is on base b < g.b, sender not in roster, and doc.$createdAt > keyringAt[b+1]: drop   # removed member
  if m.prev points strictly before this message and at a message not held: BACKFILL(m.prev)   # ignore prev that points forward
  show m; unread if doc.$createdAt > readAt

BACKFILL(w, j, epoch):      # walk back along prev; 100 tags per query
  while that message is not held:
    fetch tags (w, j−99 .. j) of that stream and epoch; show them; (w, j, epoch) = oldest one's prev
    stop at zero, at a prev that does not point strictly backwards, or past the retention horizon

APPLY(g, docs):
  while a keyring for g.b + 1 is present:
    unwrap my slot (kc tells which); none → I was removed: mark left, stop
    keyringAt[g.b+1] = its $createdAt; SWITCH(g, g.b + 1, 0); fetch the next keyring handle
  if the roster is present: decrypt it by ratcheting forward (bounded by $revision, §5.4)
    ended → mark ended; newer (b, r) → SWITCH(g, b, r); take its member list

SWITCH(g, b, r):            # new epoch: every member stream restarts at the current week
  for each member stream on the old epoch: st.stale += its next tag, for 10 minutes
  g.epoch = (b, r)

SEND(c, text):
  if c is a group and its documents were last polled over 10 s ago: APPLY(c, fresh query)   # never send on an old base
  j = next free j this week on my stream (0 if new week); on a unique-index rejection, j += 1 and retry
  broadcast dmMessage{tag[curWeek, j], body(prev = my newest message in c, 0x01, text)}
  if the broadcast result is uncertain (timeout): it landed only if the tag holds exactly this body
    (my other device writes the same tags); someone else's document there → j += 1; nothing → broadcast the same body again
```

- **Every `in` query needs an `orderBy` on its `in` field** (Drive refuses it
  otherwise). The three shapes above were verified on moutai
  (`docs/evidence/dm-v5-battery.json`).
- **One gap rule.** A message whose `prev` points at something not held
  triggers a fetch. That covers week rollovers, epoch changes, a sender's
  device dying mid-send, and history.
- **The 10-minute stale window** is the only timing constant. It catches a
  message signed just before a week rollover or an epoch change. Inclusion
  takes seconds. If a straggler is missed anyway, the sender's next message
  links to it through `prev`.
- **Opening a conversation on a new device** first finds the current messages
  (from `readAt` onward), then scrolls back through `prev`. A stream with
  nothing since `readAt` is probed further back when the conversation opens,
  back to `max(since, curWeek − 52)`. Only retention "never" can hit the
  52-week limit: a contact silent for over a year shows no history until
  someone writes. The worst first poll on a fresh device is about 30 queries,
  once.

**Poll cost, for a user with 28 1:1 chats and 2 groups of 15:** 56 tags (1
query), 2 group-owner queries, 1 invite query. That is 4 queries per 30 s,
against about 33 for one feed load. No credits.

### 6.4 Group membership changes

- **Create:** one roster create, then a `0x05` grant to each member on the
  owner's 1:1 stream. For someone the owner has never messaged, that stream
  starts with an invite (§5.1).
- **Add:** a grant at `(b, r+1)`, then an immediate roster replace. Messages a
  member sends on `r` in the seconds before they see the new roster are
  unreadable to the newcomer.
- **Remove:** a keyring at `b+1` (§5.3), then an immediate roster replace. The
  removed member cannot compute any tag on the new base. Messages other members
  send in the seconds before their clients see the keyring are still on the
  old base, so the removed member can read those. Readers look at old-base tags
  only for the 10-minute stale window, and drop anything there from a
  non-member dated after the keyring. If the roster replace failed, readers
  still list the removed member until the owner's repair loop fixes it (§6.5).
  A member removed and later re-added shows their own old-base writes from the
  gap; harmless.
- **Leave:** the member sends `0x02`. The owner's client removes them on its
  next poll. Until then they can still read.
- **Owner leaves:** the group ends (tombstone roster).
- **Resend keys (manual):** a member who cannot read a group sees "ask the
  owner to resend your keys". The owner's group page has a **Resend keys**
  action per member, which sends a fresh grant for the current epoch.
- **Limit:** 100 members including the owner.

### 6.5 Owner writes: one repair loop

Every membership write by the owner follows one loop:

```
OWNER_WRITE(g, change):
  loop:
    read the roster and walk keyring handles b+1, b+2, … to the newest
    if the newest keyring's base > roster.b:            # an earlier roster replace failed
      members = old roster members who have a slot in it (test each pad)
      replace the roster under the new base; continue
    do the change (grant + roster replace, or keyring + roster replace, or rename)
    if Platform rejects a write as stale (40106) or duplicate (unique index): continue
    break
```

Every multi-device race (two adds, two removals, an add during a removal, a
failed roster replace) is this loop re-running. The owner **never** grants or
writes a keyring from a roster behind the newest keyring. Otherwise a stale
device could hand the new key back to someone just removed. Duplicate grants
from two devices are harmless, because keys are deterministic.

## 7. Operations and costs

| Operation | v4 | v5 writes | Notes |
| --- | --- | --- | --- |
| Start a 1:1 | 2 invites | 1 invite + 1 message | About 52–60M credits measured |
| Send | 1 message | 1 message | Padded (§5.7) |
| Create a group of N | n/a | 1 roster + N−1 grants | + 1 invite per member the owner has never messaged |
| Add a member | n/a | 1 grant + 1 roster replace | Existing members need nothing |
| Remove a member | n/a | 1 keyring + 1 roster replace | The keyring is never refunded |
| Leave | n/a | 1 message; owner removes on next open | |
| Rename / end a group | n/a | 1 roster replace | |
| Resend keys (manual) | n/a | 1 grant | |
| Mark read, block | 1 receipt replace | 0 now; one coalesced self-state replace | |
| Sweep | n/a | 1 delete per message | About half refunded for short messages, more for long ones |

## 8. Remaining leaks

The design removes every structural link. What remains:

- **Timing correlation.** If A writes and B writes 20 seconds later, over and
  over, a patient observer can link them, especially when few users are
  active. There is no send batching and no random delay anywhere: they would
  make chat laggy and a static app cannot run timers while closed. The UI must
  not over-promise.
- **The nodes that answer your queries learn your contacts.** A client asks
  for the tags it expects, and a node later sees who writes them. Polling your
  own stream also reveals which asker you are. Group queries leak the same way.
  Signal's server is in the same position and relies on not logging. The
  chain-observer goal still holds.
  **Future fix:** download every new `dmMessage` and match locally, as
  shielded wallets sync. It needs a `[$createdAt]` index on messages, and
  bandwidth grows with total network DM volume. Document queries return 100
  per page, about 20–80× less efficient than shielded note sync, so this suits
  today's volume and needs buckets later. A Platform query returning thousands
  of documents per page would close that gap. Worth raising upstream.
- **Group metadata:** the owner's group documents and their revisions, size
  classes, the grant-then-roster timing link, and the group's size at
  creation. Never the members.
- **Removed members** know the group's handles, so they can see *when* the
  roster changes. Not who changed.
- **Your own activity** (counts, times, sizes) is visible.

## 9. Recovery when the self-state is lost

The self-state is one atomic document, so it is lost only through a client
bug or a lost key. A device without it rebuilds what it can:

1. **Every incoming 1:1:** rescan every invite ever sent to you, newest first,
   in the background. Invites are permanent. That is about 4 s today, and about
   2 minutes per year of history at the `B` ceiling.
2. **1:1s you started:** probe the pair's streams for everyone you follow and
   everyone who follows you: the last 4 weeks first, then back to 52 weeks in
   the background. That is 104 tags per contact, so about 500 queries for 500
   contacts. Show a progress indicator.
3. **Groups you own:** probe `gid_n` (§4.4).
4. **Groups you are in:** from grants in the recovered 1:1 streams with each
   owner, within the owner's retention. Older ones: ask the owner to resend.

**Lost for good:** 1:1s you started with people you have no follow link to.
Also, anything older than the sender's retention, which is gone for everyone
anyway. Read positions are lost too, so recovered conversations start as read.

## 10. Migration

- v3/v4 threads stay readable through the existing `direct-message-service`
  read path, merged into the same timeline. New sends always go to v5.
- Users get a one-time notice: earlier conversations are publicly linkable and
  will stay that way; new ones are not.
- Rollout uses `NEXT_PUBLIC_DM_TOPOLOGY=v5`, with contract ids and flag
  changed in one commit, as for earlier re-cuts.

## 11. Roadmap

1. **Phase 1: this document.** Text only, unlinkable 1:1 chats and groups,
   history on any device.
2. **Key rotation** (Appendix A): designed, built when there is a rotation UI
   or DashPay Connect v2 lands.
3. **Post-quantum first contact (optional):** an ML-KEM-768 key mixed into
   1:1 key agreement. It needs a per-user key document and a larger invite.
   Per-device ratchets (Signal's model) were rejected: a new browser would
   start with an empty history.
4. **Hiding the sender:** a throwaway identity per contact, funded from the
   shielded pool (`IdentityCreateFromShieldedPool`, fixed amounts). Blocked on
   a browser Halo 2 prover (platform#3235).
5. **Download-everything polling,** to close the node leak (§8).

## 12. Design history

### 12.1 Choices between the two original drafts

| Topic | Privacy draft | `DM_V5_GROUPS.md` | Chosen |
| --- | --- | --- | --- |
| Membership | Hidden | Public `recipientId` / `groupId` | **Hidden** (goal 1) |
| Key material | Prekey doc + X3DH | ENCRYPTION key, no key docs | **ENCRYPTION key** |
| Groups | Sender keys | Owner-derived keys, ratchet on add, keyring on remove | **Groups draft**, under secret handles |
| Padding | Size classes | None | **Size classes** (under 10% of a document) |
| Key rotation | Not covered | Bridge document | **Past keys in the self-state** (Appendix A) |

### 12.2 Borrowed from Platform's shielded pool (and DIP-33)

- **Adopted:** a fresh ephemeral key per invite, fixed-size invites, and
  download-and-trial-decrypt for invites.
- **Rejected:** shielded notes as the transport. Memos are 36 bytes, each
  costs about 0.0016 DASH and 30 s of proving, and there is no browser prover.
- **Not found:** nothing called "OrchardPay" exists; DIP-33 (dips#188) is the
  closest design. There are no view tags or detection keys in Platform to
  borrow.

### 12.3 Rejected or removed

| Item | Why |
| --- | --- |
| One-time prekeys; a BIP-47-style public notification doc | Consuming or publishing them links the pair. |
| Per-message pairwise key wraps (no group key) | Every message's size would reveal the group's size. |
| Multi-party ECDH for groups | Impossible on secp256k1. |
| LKH key tree (private feeds' model) | Bigger grants to save bytes on rare removals; right for 1,000-follower feeds, wrong for 100-member groups. |
| A shared tag stream per conversation | Concurrent senders collide, and the rejected transition links them. |
| Non-unique `[tag]` or unique `[tag, $ownerId]` message index | Both add a tree level per message over unique `[tag]`; distinct tags never need either (2026-09-23). |
| Separate roster and keyring doctypes | Same shape; merged into `dmGroupDoc` (2026-09-23). |
| First message and group grants carried inside invites; `selfHint` | One payload path and a sender-recovery field for a rare case; the first message is a normal message (2026-09-23). |
| Invite sweep and its index | An index entry per invite for a tiny refund, at the cost of lost-state recovery (2026-09-23). |
| Coordinated `k` schedule | Recipients scan every level instead, so no agreement is needed (2026-09-23). |
| Stale-base rule with `GRACE`, week check, 24-hour dual polling, look-ahead, exponential probe | Replaced by `prev` gap-fill, one 10-minute stale window and the removed-member rule (2026-09-23). |
| Random delays (receipts, key resends, leave-to-remove, self-state), cover traffic | Timing leaks are accepted anyway, and a static app cannot run delays while closed (2026-09-23). |
| Read receipts, join nudges, automatic key-resend protocol | Cost, and automatic key release is where a bug becomes a security failure; key resend is a manual owner action (2026-09-23). |
| Multi-part or two-copy self-state | One document replace is atomic; capped at about 300 conversations (2026-09-23). |
| Separate key-bridge document | Past keys live in the self-state (Appendix A). |
| Linkability audit script | Replaced by one assertion (§13). |

## 13. Verification

1. **Pure `lib/dm/` modules with Vitest specs and fixed test vectors:** key
   schedule and label separation, handles, tags and `prev`, invite check,
   slot wrap and `kc`, padding, roster and self-state encoding, self-state
   merge, grant acceptance, the removed-member rule, the client loop
   (`DRAIN`, `BACKFILL`, `SWITCH`, the stale window, the scan position rule),
   the owner repair loop (`OWNER_WRITE`, membership from the newest keyring),
   and the `prev`-chain sweep, against a mock chain.
2. **One linkability assertion:** across all v5 documents a battery wrote,
   no field value repeats between documents of different owners, except
   `bucket` and `$createdAt`.
3. **`scripts/verify-dm-v5.mjs` on devnet**, measuring real credits for every
   row of §7, plus:
   - a `bucket in [...]` query combined with a `$createdAt` range (else: three
     parallel queries);
   - the cost of unique `[tag]` against non-unique `[tag]` and unique
     `[tag, $ownerId]`, to confirm the layout choice;
   - a `tag in [...]` query paging past a page of junk;
   - rejected deletes of invites and group documents;
   - forged group documents under a stranger's `$ownerId`.
4. **Scan throughput** on a mid-range phone and against testnet/mainnet nodes
   (`scripts/bench-dm-scan*`).
5. **Service and UI,** then end-to-end tests on /devnet.

## 14. Decisions

| # | Question | Decision |
| --- | --- | --- |
| 1 | Bucket width `k` | Starts at 0. Senders pick `k` from their own scan data; recipients always scan every level (§5.1.2). Ceiling 2. |
| 2 | Padding | Powers of two, 128–4096 in Phase 1 (one field); 8 KiB / 14 KiB later via `body2`/`body3`. |
| 3 | Send batching and random delays | None (§8). |
| 4 | Group size | 100 including the owner. |
| 5 | Cross-device sync | One self-state document, coalesced writes, capped at about 290 conversations (§5.5). |
| 6 | Per-device ratchets | No. History follows the user. |
| 7 | Key | The login-derived ENCRYPTION key; the bound key after DashPay Connect v2 (a rotation). |
| 8 | Who can start a conversation | Anyone. It shows as a normal first DM. The invite carries no content, and the first message is a normal message (+1 document per new conversation). |
| 9 | Content | Text only in Phase 1. |
| 10 | Owner leaves | The group ends. |
| 11 | Joining a group | Added directly, by any owner. |
| 12 | Deletion | Own messages by whole weeks after retention (default 30 days; 90 days / 1 year / never), framed as fee saving. Invites and group documents are permanent. |
| 13 | Group keys | Owner-derived epoch keys, delivered by grant or keyring. |
| 14 | Query-serving nodes | Their view of contacts is accepted for Phase 1; download-everything is the planned fix. |
| 15 | Key rotation | Designed (Appendix A), not built in Phase 1. |
| 16 | Removing a member who left | On the owner's next app open; no delay. |
| 17 | Lost group keys | The owner resends manually; no automatic protocol. |

## Appendix A: key rotation (designed, not built in Phase 1)

Rotation is purely client-side, because no document carries a key id. Phase 1
data will read unchanged once it is built.

- **Where keys come from.** The encryption key is
  `HKDF(loginKey, identityId, "encryption")`, and the wallet derives `loginKey`
  from its seed per `keyIndex` (`YAPPR_DET_SIGNER_SPEC.md` §5.1). Rotating
  means moving to `keyIndex + 1`. The wallet can always re-derive old keys, so
  there is no way to "rotate to forget".
- **Order,** so the self-state stays readable throughout:
  1. Add the new key to the identity.
  2. Re-save the self-state under the new key, with the old private key
     appended to `pastKeys`.
  3. Disable the old key.
- **1:1 chats** move to the new key by themselves. The next message uses the
  new `Z`. The peer notices the new public key when refreshing the identity and
  polls both threads for a while. Both show as one timeline. `prev` gains a
  field for "previous thread", so scroll-back crosses the change.
- **Readers try every key.** They try the counterpart's ENCRYPTION keys,
  including disabled ones, against their own current and past keys.
- **Groups.** A member's slot on the next keyring is wrapped to their new key.
  An owner's `S` stays bound to the key they held at creation, so rotating
  does not protect an owner's existing groups after a compromise; the fix is
  to recreate them. Group numbering `n` restarts under a new key; the owner
  probes old groups under each past key.
- **Lost key:** 1:1 threads under it are unreadable to the user who lost it.
  Groups they own end. Groups they are in need a manual resend.
