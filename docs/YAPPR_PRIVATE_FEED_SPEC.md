Yappr Encrypted Private Feeds — Technical Specification

1. Overview

This specification defines a cryptographic system for encrypted private feeds on Yappr, a decentralized social media platform built on Dash Platform. The system enables users to maintain a private feed visible only to approved followers, with the ability to revoke access without expensive O(N) on-chain operations.

---
2. User Capabilities

2.1 Feed Owner Capabilities
┌──────────────────────┬──────────────────────────────────────────────────────────────┐
│      Capability      │                         Description                          │
├──────────────────────┼──────────────────────────────────────────────────────────────┤
│ Enable Private Feed  │ Initialize a private feed with cryptographic key material    │
├──────────────────────┼──────────────────────────────────────────────────────────────┤
│ Create Private Post  │ Publish encrypted content visible only to approved followers │
├──────────────────────┼──────────────────────────────────────────────────────────────┤
│ Create Public Post   │ Publish unencrypted content (existing behavior, unchanged)   │
├──────────────────────┼──────────────────────────────────────────────────────────────┤
│ Create Mixed Post    │ Publish a post with public teaser and encrypted full content │
├──────────────────────┼──────────────────────────────────────────────────────────────┤
│ View Follow Requests │ See pending requests to follow private feed                  │
├──────────────────────┼──────────────────────────────────────────────────────────────┤
│ Approve Follower     │ Grant a user access to decrypt private posts                 │
├──────────────────────┼──────────────────────────────────────────────────────────────┤
│ Revoke Follower      │ Remove a user's ability to decrypt future private posts      │
├──────────────────────┼──────────────────────────────────────────────────────────────┤
│ Recover Feed State   │ Restore private feed management capability on a new device   │
└──────────────────────┴──────────────────────────────────────────────────────────────┘
2.2 Follower Capabilities
┌────────────────────┬──────────────────────────────────────────────────────────┐
│     Capability     │                       Description                        │
├────────────────────┼──────────────────────────────────────────────────────────┤
│ Request Access     │ Request to follow a user's private feed                  │
├────────────────────┼──────────────────────────────────────────────────────────┤
│ Cancel Request     │ Withdraw a pending follow request                        │
├────────────────────┼──────────────────────────────────────────────────────────┤
│ View Private Posts │ Decrypt and view private posts from feeds where approved │
├────────────────────┼──────────────────────────────────────────────────────────┤
│ View Teaser        │ See public teaser content when not approved              │
├────────────────────┼──────────────────────────────────────────────────────────┤
│ Recover Keys       │ Restore decryption capability on a new device            │
├────────────────────┼──────────────────────────────────────────────────────────┤
│ Catch Up           │ Apply missed rekey operations after being offline        │
└────────────────────┴──────────────────────────────────────────────────────────┘
2.3 Non-Follower Capabilities
┌─────────────────────────┬─────────────────────────────────────────────────────────┐
│       Capability        │                       Description                       │
├─────────────────────────┼─────────────────────────────────────────────────────────┤
│ View Public Posts       │ See all public posts (unchanged)                        │
├─────────────────────────┼─────────────────────────────────────────────────────────┤
│ View Teasers            │ See teaser content on private posts                     │
├─────────────────────────┼─────────────────────────────────────────────────────────┤
│ See Private Post Exists │ Observe that a private post was made (metadata visible) │
└─────────────────────────┴─────────────────────────────────────────────────────────┘
---
3. Security Model

3.1 Trust Assumptions
┌─────────────────────────┬─────────────────────────────────────────────────────────────────────────────────────────┐
│       Assumption        │                                       Description                                       │
├─────────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────┤
│ Dash Platform Integrity │ The platform correctly stores and retrieves documents; does not forge or modify content │
├─────────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────┤
│ Identity Key Security   │ Users' Dash identity private keys are secure and not compromised                        │
├─────────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────┤
│ Client Integrity        │ The Yappr client correctly implements the cryptographic protocols                       │
├─────────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────┤
│ No Collusion Assumption │ Not assumed — approved followers may share decrypted content out-of-band                │
└─────────────────────────┴─────────────────────────────────────────────────────────────────────────────────────────┘
3.2 Threat Model

In Scope (Protected Against):
- Revoked users decrypting future private posts from on-chain data
- Non-approved users decrypting private posts
- Passive observers reading private content
- Observers determining the plaintext content of private posts

Out of Scope (Not Protected Against):
- Approved followers screenshotting or sharing decrypted content
- Approved followers sharing their key material with others
- Traffic analysis (timing, frequency of private posts)
- Metadata leakage (see below)
- Compromised client devices
- Owner key compromise (would expose all private content)

Publicly Observable Metadata (by design):
- **Follower identities**: PrivateFeedGrant.recipientId is plaintext (required for recipient lookup)
- **Follower count**: COUNT(PrivateFeedGrant) for any owner is queryable
- **Revocation events**: PrivateFeedRekey documents are public, including revokedLeaf index
- **Revocation history**: Full sequence of which leaves were revoked and when
- **Private post existence**: Post.encryptedContent presence reveals a private post was made
- **Private post timing**: Post.$createdAt is plaintext
- **Private post size**: len(encryptedContent) reveals approximate plaintext length
- **Follow requests**: FollowRequest documents reveal who is requesting access to whom

This metadata exposure is an acceptable tradeoff for a decentralized system with no access control
at the query layer. All access control is cryptographic (content encryption), not visibility-based.

3.3 Security Properties
┌───────────────────────────────────┬───────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│             Property              │                                                    Definition                                                     │
├───────────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Confidentiality                   │ Private post content is readable only by the author and approved followers                                        │
├───────────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Forward Secrecy (Post-Revocation) │ Revoked followers cannot decrypt future posts (also called "backward security" in LKH literature)                │
├───────────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ No Backward Secrecy               │ Newly approved followers CAN decrypt all historical private posts                                                 │
├───────────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Authenticated Encryption          │ Ciphertext integrity is verified; tampering is detected                                                           │
├───────────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Key Independence                  │ Compromise of one epoch's key does not reveal other epochs' keys (except via hash chain derivation of older keys) │
└───────────────────────────────────┴───────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
3.4 Security Non-Goals
┌───────────────────────────┬─────────────────────────────────────────────────────────────────────────────┐
│         Non-Goal          │                                  Rationale                                  │
├───────────────────────────┼─────────────────────────────────────────────────────────────────────────────┤
│ Backward Secrecy          │ Explicitly not required; new followers should see history                   │
├───────────────────────────┼─────────────────────────────────────────────────────────────────────────────┤
│ Metadata Privacy          │ Private post existence and timing are visible; acceptable tradeoff          │
├───────────────────────────┼─────────────────────────────────────────────────────────────────────────────┤
│ Revoked Access to History │ Revoked users retain ability to decrypt posts from their tenure; acceptable │
├───────────────────────────┼─────────────────────────────────────────────────────────────────────────────┤
│ Deniability               │ Posts are attributable to owner; not a goal to deny authorship              │
└───────────────────────────┴─────────────────────────────────────────────────────────────────────────────┘

**Re-approval note:** If a revoked user is later re-approved, they regain access to posts made
during their revoked interval (via hash chain derivation from the new CEK). This is an accepted
consequence of the "no backward secrecy" design.

---
4. System Properties

4.1 Operational Properties
┌───────────────────────┬───────────────────────────────────────────────────────────────┐
│       Property        │                           Guarantee                           │
├───────────────────────┼───────────────────────────────────────────────────────────────┤
│ Enable Private Feed   │ O(1) on-chain documents                                       │
├───────────────────────┼───────────────────────────────────────────────────────────────┤
│ Create Private Post   │ O(1) on-chain documents, O(1) computation                     │
├───────────────────────┼───────────────────────────────────────────────────────────────┤
│ Approve Follower      │ O(1) on-chain documents                                       │
├───────────────────────┼───────────────────────────────────────────────────────────────┤
│ Revoke Follower       │ 2 state transitions (1 create, 1 delete), O(log N) packet size │
├───────────────────────┼───────────────────────────────────────────────────────────────┤
│ Follower Decryption   │ O(1) per post after key catch-up                              │
├───────────────────────┼───────────────────────────────────────────────────────────────┤
│ Follower Key Catch-up │ O(R) where R = missed revocations                             │
├───────────────────────┼───────────────────────────────────────────────────────────────┤
│ Owner Recovery        │ O(N + R) reads where N = followers, R = revocations (reads are free) │
├───────────────────────┼───────────────────────────────────────────────────────────────┤
│ Follower Recovery     │ O(1) + O(R) where R = revocations since grant                 │
└───────────────────────┴───────────────────────────────────────────────────────────────┘
4.2 Capacity Limits
┌────────────────────────┬───────────┬────────────────────────────────────────────────┐
│         Limit          │   Value   │                   Rationale                    │
├────────────────────────┼───────────┼────────────────────────────────────────────────┤
│ Max Private Followers  │ 1024      │ Binary tree capacity; upgradeable in future    │
├────────────────────────┼───────────┼────────────────────────────────────────────────┤
│ Max Epoch Chain Length │ 2000      │ Hard limit; see §4.2.1 for extension           │
├────────────────────────┼───────────┼────────────────────────────────────────────────┤
│ Max Rekey Packets      │ ~19       │ 2*(log N)-1 for N=1024; see 8.5 step 8         │
├────────────────────────┼───────────┼────────────────────────────────────────────────┤
│ Max Encrypted Content  │ 1024 bytes│ ~500 UTF-8 chars; see §7.5.1                   │
├────────────────────────┼───────────┼────────────────────────────────────────────────┤
│ Max Revocation History │ 2000*     │ *Operational limit is epoch chain (2000); uint16 version counters allow 65535 │
└────────────────────────┴───────────┴────────────────────────────────────────────────┘

4.2.1 Epoch Chain Limit

The epoch chain uses a hash chain construction: CEK[n-1] = SHA256(CEK[n]). This requires
pre-generating the full chain at feed creation time. The chain CANNOT be extended past
the pre-generated maximum (2000 epochs) without a migration.

**When the limit is reached:**
- Clients MUST detect when currentEpoch approaches maxEpoch (e.g., within 100)
- Clients SHOULD warn the owner that a migration will be needed soon
- At currentEpoch == maxEpoch, no further revocations are possible

**Future extension (not specified in v1):**
A future protocol version may define a segmented chain extension scheme, such as:
- Publishing an encrypted "next segment root" before the current chain exhausts
- Re-granting all followers with keys for the new segment
- This would be an O(N) migration similar to tree capacity upgrades (§13.2)

For v1, 2000 epochs (revocations) is treated as a hard limit. Users who require more
revocations than this should consider that they may be better served by rebuilding
their private feed from scratch.

4.3 Storage Constraints
┌───────────────────────┬────────────────────┬──────────────────────────────────────┐
│      Constraint       │       Limit        │                Impact                │
├───────────────────────┼────────────────────┼──────────────────────────────────────┤
│ Document Field Size   │ 5120 bytes         │ Bounds rekey packet size, grant size │
├───────────────────────┼────────────────────┼──────────────────────────────────────┤
│ State Transition Size │ 20480 bytes        │ Bounds total document size           │
├───────────────────────┼────────────────────┼──────────────────────────────────────┤
│ Rekey Doc Size        │ ~1.2 KB typical    │ Well under limits                    │
├───────────────────────┼────────────────────┼──────────────────────────────────────┤
│ Grant Doc Size        │ ~500 bytes typical │ Well under limits (485 bytes)        │
└───────────────────────┴────────────────────┴──────────────────────────────────────┘
---
5. Cryptographic Primitives

5.1 Algorithms
┌───────────────────────┬───────────────────────────┬───────────────────────────────────────────┐
│        Purpose        │         Algorithm         │                Parameters                 │
├───────────────────────┼───────────────────────────┼───────────────────────────────────────────┤
│ Content Encryption    │ XChaCha20-Poly1305        │ 256-bit key, 192-bit nonce, 128-bit tag   │
├───────────────────────┼───────────────────────────┼───────────────────────────────────────────┤
│ Key Wrapping          │ XChaCha20-Poly1305        │ Same as above                             │
├───────────────────────┼───────────────────────────┼───────────────────────────────────────────┤
│ Key Derivation        │ HKDF-SHA256               │ Variable length output                    │
├───────────────────────┼───────────────────────────┼───────────────────────────────────────────┤
│ Hash Chain            │ SHA256                    │ 256-bit output                            │
├───────────────────────┼───────────────────────────┼───────────────────────────────────────────┤
│ Asymmetric Encryption │ ECIES (see §11.5)         │ Ephemeral ECDH + XChaCha20-Poly1305       │
└───────────────────────┴───────────────────────────┴───────────────────────────────────────────┘

5.1.1 Encoding Conventions

All integer values in cryptographic operations MUST use fixed-width big-endian encoding:

| Type   | Width   | Range       | Example                          |
|--------|---------|-------------|----------------------------------|
| uint8  | 1 byte  | 0-255       | packetCount                      |
| uint16 | 2 bytes | 0-65535     | nodeId, version, leafIndex       |
| uint32 | 4 bytes | 0-4294967295| epoch                            |

Concatenation in HKDF info strings and AAD:
- String literals: UTF-8 encoded, no null terminator
- Identifiers (ownerId, recipientId): 32 bytes, as stored on platform
- Integers: fixed-width big-endian as specified above
- Byte arrays (nonce, keys): raw bytes, length implicit from context

Example: HKDF(feedSeed, "node" || nodeId || version) with nodeId=1024, version=3
- "node" = [0x6E, 0x6F, 0x64, 0x65] (4 bytes)
- nodeId = [0x04, 0x00] (uint16 big-endian)
- version = [0x00, 0x03] (uint16 big-endian)
- info = [0x6E, 0x6F, 0x64, 0x65, 0x04, 0x00, 0x00, 0x03] (8 bytes)

5.1.2 HKDF Parameterization

This specification uses HKDF-SHA256 (RFC 5869) for all key derivation. The canonical
function signature is:

    HKDF(ikm, salt, info, length) → derived_bytes

Where:
- ikm: Input key material (bytes)
- salt: Optional salt value (bytes, may be empty)
- info: Context/application-specific info string (bytes)
- length: Output length in bytes

**Shorthand notation**: Throughout this spec, we use a shorthand form for common cases:

    HKDF(ikm, info)           →  HKDF(ikm, salt="", info, length=32)
    HKDF(ikm, info, len=N)    →  HKDF(ikm, salt="", info, length=N)

The shorthand uses an empty salt and defaults to 32-byte output (256 bits).

**Full form**: When salt is explicitly needed (e.g., ECIES, nonce derivation), the full
form is written as:

    HKDF(ikm, salt=X, info=Y, length=N)

All HKDF calls in this specification use SHA-256 as the underlying hash function.

5.2 Key Hierarchy

feedSeed (256 bits, generated at feed creation)
│
├─► nodeKey[nodeId, version] = HKDF(feedSeed, "node" || nodeId || version)
│   // Each node has its own version counter, incremented on rekey
│   // Version 0 is initial; version increments when node is on a revoked path
│
├─► epochChainRoot = HKDF(feedSeed, "epoch-chain")
│       │
│       └─► CEK[maxEpoch] = HKDF(epochChainRoot, "cek" || maxEpoch)
│           CEK[n-1] = SHA256(CEK[n])  (hash chain, computed backwards)
│
└─► recoveryKey = HKDF(feedSeed, "recovery")

5.3 Per-Post Key Derivation

postKey = HKDF(CEK[epoch], "post" || nonce || authorId)

The nonce is randomly generated at encryption time and stored in the post document.
This avoids dependency on platform-assigned postId, which may not be accessible
before encryption.

5.4 Key Separation

All derived keys use distinct HKDF info strings to ensure domain separation:
- "node" — tree node keys
- "epoch-chain" — epoch chain root
- "cek" — content encryption key derivation
- "cek-wrap" — wrapping key for CEK in rekey docs
- "cek-nonce" — nonce derivation for CEK wrapping
- "post" — per-post key derivation
- "wrap" — key wrapping operations
- "yappr/ecies/v1" — ECIES key and nonce derivation (see §11.5)

5.5 AAD (Additional Authenticated Data) Contexts

All AEAD encryption operations use AAD to bind ciphertext to its context:
- "yappr/post/v1" — private post content encryption (see §8.2, §8.6)
- "yappr/cek/v1" — epoch CEK encryption in rekey docs (see §8.5, §8.7)
- "yappr/rekey/v1" — rekey packet wrapping (see §8.5, §8.7)
- "yappr/grant/v1" — grant payload ECIES encryption (see §8.4)
- "yappr/feed-state/v1" — feed state ECIES encryption (see §8.1)

---
6. Data Structures

6.1 Key Tree Structure

Binary tree with heap indexing:
- Root node: index 1
- Node i's children: 2i (left), 2i+1 (right)
- Leaves: indices 1024 to 2047 (for 1024-leaf tree)
- Leaf for follower at leafIndex: node (1024 + leafIndex)

Follower path: Each follower knows keys for nodes on path from their leaf to root (~10 keys for 1024 leaves).

Helper functions:
- parent(n) = floor(n / 2)
- leftChild(n) = 2n
- rightChild(n) = 2n + 1
- sibling(n) = n + 1 if n is even (left child), n - 1 if n is odd (right child)
- isLeftChild(n) = (n % 2 == 0)
- depth(n) = floor(log2(n))

6.2 Node Version Derivation

Each node in the tree has a version counter. A node's version equals the number
of times it has appeared on a revoked leaf's path to root. This can be derived
from the ordered list of revoked leaves without explicit storage.

Computing node version:

computeNodeVersion(nodeId, revokedLeaves[]):
  version = 0
  for each leafIndex in revokedLeaves:
    if nodeId is on path from (1024 + leafIndex) to root:
      version++
  return version

Helper to check if node is on path:

isOnPath(nodeId, leafNodeId):
  current = leafNodeId
  while current >= 1:
    if current == nodeId: return true
    current = floor(current / 2)
  return false

Key derivation uses the computed version:

nodeKey(nodeId, version) = HKDF(feedSeed, "node" || nodeId || version)

Benefits:
- No explicit version storage needed
- Versions derived from revokedLeaf field in PrivateFeedRekey docs
- O(R × log N) computation where R = revocations (done rarely, on recovery)
- Only affected nodes are rekeyed (O(log N) per revocation)
- Sibling subtrees retain their existing keys

6.3 Available Leaves Tracking

Bitmap of leaf availability:

availableLeaves: bytes (128 bytes for 1024 leaves, 1 bit per leaf)

Bit = 1: leaf is available (unused or revoked)
Bit = 0: leaf is assigned to active follower

IMPORTANT: availableLeaves is a DERIVED cache, not authoritative.

The authoritative source of leaf assignments is the set of active PrivateFeedGrant
documents. The unique index on ($ownerId, leafIndex) enforced by the platform
prevents collisions even if the local availableLeaves bitmap is stale.

Derivation from grants:
  availableLeaves = all 1s (all available)
  for each PrivateFeedGrant where $ownerId = myId:
    availableLeaves[grant.leafIndex] = 0  (mark assigned)

On recovery or sync, clients MUST derive availableLeaves from grants rather than
trusting cached or stored values. The platform-enforced unique index ensures that
even concurrent approvals from multiple devices will fail safely (one succeeds,
others get a uniqueness violation) rather than silently corrupting state.

---
7. Document Schemas

7.0 Uniqueness Constraints (Protocol Safety)

The following uniqueness constraints MUST be enforced by the platform to prevent
ambiguous state and chain forks:

| Document           | Unique Index                    | Rationale                              |
|--------------------|---------------------------------|----------------------------------------|
| FollowRequest      | (targetId, $ownerId)            | One pending request per requester      |
| PrivateFeedGrant   | ($ownerId, recipientId)         | One active grant per recipient         |
| PrivateFeedGrant   | ($ownerId, leafIndex)           | One recipient per leaf (CRITICAL)      |
| PrivateFeedRekey   | ($ownerId, epoch)               | Exactly one rekey per epoch            |
| PrivateFeedState   | ($ownerId)                      | One feed state per owner               |

Violation of these constraints would cause:
- Duplicate grants (same recipient) → ambiguous state
- Duplicate grants (same leaf) → two users share path keys, revocation undefined
- Duplicate rekeys → chain fork, followers diverge on key state
- Duplicate feed state → undefined initialization behavior

The ($ownerId, leafIndex) uniqueness is CRITICAL for protocol safety. Without it,
multi-device race conditions or stale recovery state could assign the same leaf
to multiple recipients, causing them to share identical path keys.

7.0.1 Document Mutability Constraints

The following mutability rules MUST be enforced at the contract level:

| Document           | canBeDeleted | Rationale                                      |
|--------------------|--------------|------------------------------------------------|
| FollowRequest      | true         | Requester can cancel; owner ignores stale ones |
| PrivateFeedGrant   | true         | Deleted on revocation                          |
| PrivateFeedRekey   | false        | CRITICAL: History required for version derivation |
| PrivateFeedState   | false        | Feed initialization must persist               |

PrivateFeedRekey immutability is non-negotiable. See §7.3 for detailed rationale.

7.1 FollowRequest

Created by user requesting access to a private feed.

FollowRequest {
// System fields
$ownerId: Identifier        // Requester's identity (system-assigned)
$createdAt: Timestamp

// Application fields
targetId: Identifier        // Feed owner's identity
publicKey: bytes (optional) // Requester's encryption public key (if not derivable from identity)

// Indices
- targetAndRequester: (targetId ASC, $ownerId ASC)
    UNIQUE: true  // One pending request per (target, requester)
- target: (targetId ASC, $createdAt ASC)  // Owner queries pending requests
}

Size: ~100 bytes

7.2 PrivateFeedGrant

Created by feed owner when approving a follower.

PrivateFeedGrant {
// System fields
$ownerId: Identifier        // Feed owner's identity
$createdAt: Timestamp

// Application fields
recipientId: Identifier     // Approved follower's identity
leafIndex: uint16           // Assigned position in tree
epoch: uint32               // Current epoch at time of grant
encryptedPayload: bytes     // Encrypted to recipient's public key

// Indices
- ownerAndRecipient: ($ownerId ASC, recipientId ASC)
    UNIQUE: true  // One grant per (owner, recipient)
- ownerAndLeaf: ($ownerId ASC, leafIndex ASC)
    UNIQUE: true  // CRITICAL: One recipient per leaf - prevents key sharing collision
}

encryptedPayload format (ECIES ciphertext, see §11.5):
┌─────────────────────────────────────────────────────────────┐
│ ephemeralPubKey: bytes[33]  (compressed secp256k1 point)    │
│ ciphertext: bytes[N]        (XChaCha20-Poly1305 output)     │
│   └─ includes 16-byte auth tag                              │
└─────────────────────────────────────────────────────────────┘

Plaintext contents (before encryption):
{
version: uint8,             // Protocol version (0x01)
grantEpoch: uint32,         // Epoch these keys are valid for
leafIndex: uint16,          // Assigned leaf (for path validation)
pathKeyCount: uint8,        // Number of path keys (typically 11 for 1024-leaf tree)
pathKeys: [                 // O(log N) node keys
  { nodeId: uint16, version: uint16, key: bytes32 },
  ...
],
currentCEK: bytes32         // Current epoch content key
}

Size: 33 (ephemeral pubkey) + 1 (version) + 4 (epoch) + 2 (leafIndex) + 1 (pathKeyCount) +
      (11 × 36) (pathKeys) + 32 (CEK) + 16 (auth tag) = 485 bytes

Follower MUST validate on decryption:
1. version == 0x01 (reject unknown versions)
2. leafIndex matches grant document's leafIndex field
3. pathKeys[0].nodeId == 1024 + leafIndex (correct leaf node)
4. Each subsequent pathKeys[i].nodeId == parent(pathKeys[i-1].nodeId)
5. pathKeys[last].nodeId == 1 (root node)

Note: Follower must apply any PrivateFeedRekey docs with epoch > grantEpoch
to obtain current keys.

7.3 PrivateFeedRekey

Created by feed owner when revoking a follower.

PrivateFeedRekey {
// System fields
$ownerId: Identifier        // Feed owner's identity
$createdAt: Timestamp

// Application fields
epoch: uint32               // New epoch number after this rekey
revokedLeaf: uint16         // Which leaf was revoked
packets: bytes              // Rekey packets (see below)
encryptedCEK: bytes         // CEK[epoch] encrypted under new root key

// Note: No mutable state stored here. All derived values come from:
// - currentEpoch: MAX(epoch) across all rekey docs, or 1 if none
// - availableLeaves: derived from grants (see §6.3)
// - activeFollowerCount: COUNT of grants
// - nodeVersions: derived from sequence of revokedLeaf across all rekey docs (see §6.2)

// Document properties
canBeDeleted: false         // CRITICAL: Rekey docs are IMMUTABLE (see below)

// Indices
- ownerAndEpoch: ($ownerId ASC, epoch ASC)
    UNIQUE: true  // Enforced by platform - exactly one rekey per epoch
                  // Prevents chain forks from duplicate rekey docs
}

IMMUTABILITY REQUIREMENT:

PrivateFeedRekey documents MUST be non-deletable at the contract level. This is
enforced via `canBeDeleted: false` in the Dash Platform data contract.

Rationale:
- Node versions are derived from the complete sequence of revokedLeaf values
  across ALL rekey documents (see §6.2 computeNodeVersion)
- If ANY rekey document is deleted:
  - New devices cannot correctly compute node versions during recovery
  - Followers who missed rekeys cannot catch up
  - The feed's forward evolution breaks permanently
- This is NOT a soft requirement - deletion causes unrecoverable protocol failure

The rekey history is append-only. Once published, it exists forever.

packets binary format (see section 9.1 for detailed encoding):
- count: uint8
- entries[]: { targetNodeId: uint16, targetVersion: uint16, encryptedUnderNodeId: uint16, encryptedUnderVersion: uint16, wrappedKey: bytes48 }

Size: ~1.2 KB typical (1 + 19 × 56 = 1065 bytes for packets field, plus document overhead)

7.4 PrivateFeedState

Created by feed owner at private feed initialization. This document is IMMUTABLE
after creation - it contains only configuration and the encrypted seed.

PrivateFeedState {
// System fields
$ownerId: Identifier        // Feed owner's identity
$createdAt: Timestamp

// Application fields (immutable config)
treeCapacity: uint16        // 1024 (fixed for this feed)
maxEpoch: uint32            // Pre-generated chain length (2000)
encryptedSeed: bytes        // Feed seed encrypted to owner's key (versioned, see §13.1)

// Document properties
canBeDeleted: false         // Feed initialization must persist

// Indices
- owner: ($ownerId ASC)
    UNIQUE: true  // One feed state per owner
}

Size: ~170 bytes (33 ephemeral pubkey + 1 version + 32 seed + 16 tag + overhead)

DERIVED STATE (not stored in PrivateFeedState):
The following values are derived from other documents, NOT stored here:

| Value               | Derived From                                        |
|---------------------|-----------------------------------------------------|
| currentEpoch        | MAX(PrivateFeedRekey.epoch) for owner, or 1 if none |
| activeFollowerCount | COUNT(PrivateFeedGrant) for owner                   |
| availableLeaves     | All leaves minus those in active grants (see §6.3)  |
| revokedLeaves       | Ordered list of PrivateFeedRekey.revokedLeaf        |

This design avoids extra paid writes on every approve/revoke operation.

7.5 Post (Modified)

Existing post document with additional optional fields for private content.

Post {
// Existing fields
$ownerId: Identifier
$createdAt: Timestamp
content: string             // Public content OR teaser for private posts

// New optional fields for private posts
encryptedContent: bytes     // AEAD ciphertext (byte array, max 1024 bytes)
epoch: uint32               // Which epoch key to use
nonce: bytes[24]            // XChaCha20-Poly1305 nonce (byte array)

// Existing optional fields
mediaUrl: string
replyToPostId: Identifier
quotedPostId: Identifier
// ... etc

// Existing indices (unchanged)
}

Private post identification: Presence of encryptedContent field indicates private post.

7.5.1 Encrypted Content Size Limit

The encryptedContent field is capped at 1024 bytes (1 KB).

Breakdown:
- Plaintext content: up to ~1000 bytes (supports ~500 UTF-8 characters)
- AEAD overhead: 16 bytes (Poly1305 auth tag)
- Padding/encoding: ~8 bytes buffer

This limit ensures:
1. Private posts stay well under the 5KB Dash Platform field limit
2. Consistent with the existing ~500 character UI limit for public posts
3. Room for future metadata without hitting platform constraints

Posts exceeding this limit MUST be rejected at the client before encryption.
Chunking is NOT supported in this version of the protocol.

---
7.6 Multi-Device Consistency Requirements

Owner clients MUST sync before any write operation to maintain forward secrecy.

Problem: If owner has multiple devices and Device A revokes a follower (advancing to epoch e+1)
while Device B is stale (still on epoch e), Device B could create posts encrypted under epoch e.
The revoked user could decrypt these "future" posts, violating forward secrecy.

Protocol Rule: Before performing any of these operations, the client MUST:
1. Fetch the highest PrivateFeedRekey.epoch for the owner (if any exist)
2. If fetched epoch > local epoch: run Owner Recovery (8.8) to sync state
3. Only then proceed with the operation

Operations requiring sync-before-write:
- Create Private Post
- Approve Follower (to get correct current epoch for grant)
- Revoke Follower (to ensure sequential epoch numbering)

This cannot be enforced cryptographically in a decentralized system. It is a client
implementation requirement. Clients that skip this step may produce posts that violate
the forward secrecy guarantee.

**Implementation note:** Sync-before-write is the weakest link in the security model.
Implementers MUST ensure:
1. The sync check runs before EVERY approve/revoke/post operation (no exceptions)
2. Owner Recovery (§8.8) fetches ALL rekey documents, not just the latest epoch number
3. Recovery fully completes before proceeding (partial state = broken crypto)
4. Network failures during sync should abort the operation, not proceed with stale state

The Owner Recovery algorithm fetches all PrivateFeedRekey documents to rebuild the
complete revokedLeaves list, which is necessary for correct node version computation.
Fetching only the highest epoch number is NOT sufficient.

---
8. Algorithms

8.1 Enable Private Feed

Inputs: Owner identity

Procedure:
1. Generate feedSeed = random(32 bytes)
2. Compute epochChainRoot = HKDF(feedSeed, "epoch-chain")
3. Pre-compute CEK chain:
   CEK[2000] = HKDF(epochChainRoot, "cek" || 2000)
   for i = 1999 down to 1:
     CEK[i] = SHA256(CEK[i+1])
4. Encrypt feedSeed to owner's own public key using ECIES (§11.5):
   - versionedPayload = 0x01 || feedSeed  (version prefix, see §13.1)
   - aad = "yappr/feed-state/v1" || ownerId
   - encryptedSeed = ECIES_Encrypt(ownerPubKey, versionedPayload, aad)
5. Create PrivateFeedState document:
   - treeCapacity: 1024
   - maxEpoch: 2000
   - encryptedSeed: encryptedSeed
6. Initialize local state:
   - Store feedSeed
   - Set currentEpoch = 1
   - Set availableLeaves = all available (derived: no grants exist yet)
   - Set revokedLeaves = [] (derived: no rekeys exist yet)

Outputs: PrivateFeedState document created

Cost: 1 state transition

8.2 Create Private Post

Inputs: Plaintext content, optional teaser, owner's feedSeed

Procedure:
1. SYNC CHECK (required, see 7.6):
   a. Fetch highest PrivateFeedRekey.epoch for self
   b. If fetched epoch > local currentEpoch: run Owner Recovery (8.8)
2. Validate plaintext size:
   - If len(plaintext) > 999 bytes → reject (exceeds limit after version prefix, see §7.5.1)
3. Retrieve CEK[currentEpoch] from local storage (or derive from chain)
4. Generate nonce = random(24 bytes)
5. Compute postKey = HKDF(CEK[currentEpoch], "post" || nonce || ownerId)
6. Compute AAD = "yappr/post/v1" || ownerId || currentEpoch || nonce
7. Prepend version: versionedContent = 0x01 || plaintext  (see §13.1)
8. Compute ciphertext = XChaCha20-Poly1305-Encrypt(postKey, nonce, versionedContent, AAD)
   - Result: len(ciphertext) = 1 + len(plaintext) + 16 (auth tag) ≤ 1016 bytes
9. Create Post document:
   - content: teaser (or empty string)
   - encryptedContent: ciphertext
   - epoch: currentEpoch
   - nonce: nonce

Outputs: Post document created

Cost: 1 state transition (plus O(1) read for sync check)

Note: The nonce is generated before deriving postKey, ensuring we use only values
we control at encryption time. Platform-assigned postId is not used for key derivation.

8.3 Request Follow Access

Inputs: Requester identity, target owner identity

Procedure:
1. Check if PrivateFeedGrant already exists for (owner, requester) → already approved
2. Check if FollowRequest already exists for (target, requester) → already pending
3. Determine if requester's identity has usable public key
- If only hash160 key available, include full publicKey in request
4. Create FollowRequest document:
- targetId: owner's identity
- publicKey: (if needed)

Outputs: FollowRequest document created

Cost: 1 state transition

8.4 Approve Follower

Inputs: FollowRequest document, owner's feedSeed

Procedure:
1. SYNC CHECK (required, see 7.6):
   a. Fetch highest PrivateFeedRekey.epoch for self
   b. If fetched epoch > local currentEpoch: run Owner Recovery (8.8)
2. Select available leafIndex from local availableLeaves cache
3. Mark leafIndex as unavailable in local cache (bit = 0)
4. Compute path from leaf to root:
   path = []
   nodeId = 1024 + leafIndex
   while nodeId >= 1:
     version = computeNodeVersion(nodeId, revokedLeaves)  // see 6.2
     key = HKDF(feedSeed, "node" || nodeId || version)
     path.append({ nodeId, version, key })
     nodeId = nodeId / 2  // parent
5. Retrieve current CEK[currentEpoch]
6. Build payload (binary format per §9.3):
   payload =
     0x01                              || // version byte
     currentEpoch (uint32)             || // grantEpoch
     leafIndex (uint16)                || // assigned leaf (for validation)
     len(path) (uint8)                 || // pathKeyCount
     for each {nodeId, version, key} in path:
       nodeId (uint16) || version (uint16) || key (bytes32)
     ||
     CEK[currentEpoch] (bytes32)          // currentCEK
7. Encrypt payload to recipient's public key using ECIES (§11.5):
   - aad = "yappr/grant/v1" || ownerId || recipientId || leafIndex || currentEpoch
   - encryptedPayload = ECIES_Encrypt(recipientPubKey, payload, aad)
8. Create PrivateFeedGrant document:
   - recipientId: requester's identity
   - leafIndex: assigned index
   - epoch: currentEpoch
   - encryptedPayload: encryptedPayload
9. Update local cache: availableLeaves[leafIndex] = 0, increment follower count
   (These are derived from grants; local cache just avoids re-querying)

Outputs: PrivateFeedGrant document created

Cost: 1 state transition (plus O(1) read for sync check)

Error handling - leafIndex collision:
If the state transition fails with a uniqueness violation on ($ownerId, leafIndex),
it means another device concurrently assigned the same leaf. This is safe (the
collision was caught), but the client must:
1. Run Owner Recovery (8.8) to refresh availableLeaves from current grants
2. Select a different available leafIndex
3. Retry the approval

This should be rare with proper sync checks, but the unique index guarantees safety.

8.5 Revoke Follower

Inputs: Follower to revoke, owner's feedSeed

Procedure:
1. SYNC CHECK (required, see 7.6):
   a. Fetch highest PrivateFeedRekey.epoch for self
   b. If fetched epoch > local currentEpoch: run Owner Recovery (8.8)
2. Lookup follower's leafIndex from their PrivateFeedGrant
3. Advance epoch: newEpoch = currentEpoch + 1
4. Compute new CEK[newEpoch] from hash chain
5. Compute revoked path from leaf to root:
   revokedPath = []
   nodeId = 1024 + leafIndex
   while nodeId >= 1:
     revokedPath.append(nodeId)
     nodeId = nodeId / 2  // parent
   // revokedPath[0] = leaf, revokedPath[last] = root (node 1)

6. Compute new versions and keys for nodes on revoked path:
   // Nodes on revoked path get incremented versions and new keys
   // Sibling nodes keep their existing versions and keys
   // After this revocation, revokedLeaves will include leafIndex
   newRevokedLeaves = revokedLeaves + [leafIndex]  // append for version computation
   newVersions = {}
   newKeys = {}
   for i = 1 to len(revokedPath) - 1:  // skip leaf at index 0
     nodeId = revokedPath[i]
     // New version = count of revoked leaves whose path includes this node
     newVersion = computeNodeVersion(nodeId, newRevokedLeaves)
     newVersions[nodeId] = newVersion
     newKeys[nodeId] = HKDF(feedSeed, "node" || nodeId || newVersion)

7. Create rekey packets (bottom-up, precise LKH leave algorithm):
   packets = []
   for i = 1 to len(revokedPath) - 1:  // for each updated node
     nodeId = revokedPath[i]
     childOnPath = revokedPath[i - 1]
     siblingOfChild = sibling(childOnPath)  // sibling(n) = n+1 if n even, n-1 if n odd

     // Packet A: encrypt new key under sibling's CURRENT version key
     // (Sibling subtree users have this key from their grant or previous rekeys)
     // Sibling version computed from revokedLeaves BEFORE this revocation
     siblingVersion = computeNodeVersion(siblingOfChild, revokedLeaves)
     siblingKey = HKDF(feedSeed, "node" || siblingOfChild || siblingVersion)
     wrapKey = HKDF(siblingKey, "wrap")
     nonce = deriveNonce(newEpoch, nodeId, newVersions[nodeId], siblingOfChild, siblingVersion)
     aad = "yappr/rekey/v1" || ownerId || newEpoch || nodeId || newVersions[nodeId] || siblingOfChild || siblingVersion
     packets.append({
       targetNodeId: nodeId,
       targetVersion: newVersions[nodeId],
       encryptedUnderNodeId: siblingOfChild,
       encryptedUnderVersion: siblingVersion,
       wrappedKey: XChaCha20-Poly1305-Encrypt(wrapKey, nonce, newKeys[nodeId], aad)
     })

     // Packet B: encrypt new key under the UPDATED child's NEW key
     // (This lets users who already decrypted the child continue up the path)
     // Skip for the first updated node (its child is the revoked leaf)
     if i > 1:
       updatedChild = revokedPath[i - 1]
       childNewVersion = newVersions[updatedChild]
       childNewKey = newKeys[updatedChild]
       wrapKey = HKDF(childNewKey, "wrap")
       nonce = deriveNonce(newEpoch, nodeId, newVersions[nodeId], updatedChild, childNewVersion)
       aad = "yappr/rekey/v1" || ownerId || newEpoch || nodeId || newVersions[nodeId] || updatedChild || childNewVersion
       packets.append({
         targetNodeId: nodeId,
         targetVersion: newVersions[nodeId],
         encryptedUnderNodeId: updatedChild,
         encryptedUnderVersion: childNewVersion,
         wrappedKey: XChaCha20-Poly1305-Encrypt(wrapKey, nonce, newKeys[nodeId], aad)
       })

   // Total packets: 2 * (path_length - 1) - 1 = 2 * log(N) - 1
   // For N=1024 (depth 10): approximately 19 packets

8. Get new root key: newRootKey = newKeys[1]
9. Encrypt CEK for distribution:
    cekWrapKey = HKDF(newRootKey, "cek-wrap")
    cekNonce = HKDF(newRootKey, "cek-nonce" || newEpoch, len=24)
    cekAAD = "yappr/cek/v1" || ownerId || newEpoch
    encryptedCEK = XChaCha20-Poly1305-Encrypt(cekWrapKey, cekNonce, CEK[newEpoch], cekAAD)

--- CRITICAL: Two-phase commit (rekey-first) ---
The following steps MUST be executed in order with verification.
Rekey creation MUST succeed before grant deletion is attempted.

10. Create PrivateFeedRekey document:
    - epoch: newEpoch
    - revokedLeaf: leafIndex
    - packets: serialized packets
    - encryptedCEK: encryptedCEK
    (Note: availableLeaves and activeFollowerCount are derived from grants, not stored)
11. VERIFY rekey creation succeeded:
    a. Wait for state transition confirmation (or timeout with broadcast success)
    b. Query: PrivateFeedRekey where $ownerId = self AND epoch = newEpoch
    c. If document exists → proceed to step 12
    d. If document NOT found → ABORT, do NOT delete grant, alert user to retry
12. Update local state: currentEpoch = newEpoch, append leafIndex to revokedLeaves
    (availableLeaves will be re-derived from grants after step 13)
13. Delete PrivateFeedGrant for revoked follower
    - This is now SAFE: rekey exists, epoch advanced, followers can catch up
    - If deletion fails: log error, schedule retry (see §12.3 for cleanup)

Outputs: PrivateFeedRekey created, PrivateFeedGrant deleted (or scheduled for deletion)

Cost: 2 state transitions (plus O(1) reads for sync check and verification)

FAILURE MODES:
- Rekey fails → abort, grant intact, no state change, user retries
- Rekey succeeds, grant deletion fails → acceptable (see §12.3), user is cryptographically revoked
- NEVER delete grant without confirmed rekey → would strand followers

Error handling - epoch collision (multi-device race):
If the rekey state transition fails with a uniqueness violation on ($ownerId, epoch),
it means another device concurrently revoked someone (both chose currentEpoch + 1).
The client must:
1. Run Owner Recovery (§8.8) to sync currentEpoch and revokedLeaves
2. Recompute newEpoch = currentEpoch + 1 (now correct)
3. Recompute packets with updated node versions (revokedLeaves changed)
4. Retry the revocation

This is analogous to leaf collision handling in §8.4.

8.6 Decrypt Private Post (Follower)

Inputs: Post document, follower's cached keys

Procedure:
1. If no encryptedContent → post is public, render content directly
2. Extract epoch from post
3. If epoch > cachedEpoch:
   a. Fetch PrivateFeedRekey documents for author with epoch > cachedEpoch
   b. Sort by epoch ascending, apply each in order (see 8.7)
4. Derive CEK[epoch]:
   If epoch == cachedEpoch:
     CEK = cachedCEK
   Else if epoch < cachedEpoch:
     CEK = cachedCEK
     for i = cachedEpoch down to epoch+1:
       CEK = SHA256(CEK)  // hash chain backwards
5. Extract nonce from post document
6. Compute postKey = HKDF(CEK, "post" || nonce || authorId)
7. Compute AAD = "yappr/post/v1" || authorId || epoch || nonce
8. Decrypt: versionedContent = XChaCha20-Poly1305-Decrypt(postKey, nonce, encryptedContent, AAD)
9. If decryption fails → show teaser or "locked" UI
10. Validate and strip version prefix:
    - If versionedContent[0] != 0x01 → reject (unknown version)
    - plaintext = versionedContent[1:]  (strip version byte)
11. If decryption succeeds → render plaintext

Outputs: Decrypted content or teaser fallback

8.7 Apply Rekey (Follower)

Inputs: PrivateFeedRekey document, follower's current path keys, lastAppliedEpoch

Precondition: Rekeys MUST be applied in ascending epoch order. Fetch all rekey docs
with epoch > lastAppliedEpoch, sort by epoch, and apply sequentially.

Epochs MUST be contiguous (1, 2, 3, ...). The owner algorithm (§8.5) enforces this with
newEpoch = currentEpoch + 1. In LKH, each rekey's packets are encrypted under keys from
the prior state; missing an intermediate rekey leaves followers unable to decrypt later
rekeys because they lack the required intermediate key versions.

**If a rekey document is missing** (data loss, corruption): Affected followers will get
stuck and cannot catch up. Recovery requires the owner to issue a fresh PrivateFeedGrant
with current path keys, effectively re-granting access.

Procedure:
1. Verify epoch ordering: rekeyDoc.epoch > lastAppliedEpoch
2. Parse packets from rekey document
3. Build key lookup map:
   - Start with current path keys (from grant or previous rekeys)
   - These keys have versions from prior state
4. Process packets iteratively until no more progress:
   // Multiple passes may be needed as decrypting one packet unlocks others
   newKeys = {}  // nodeId -> {version, key} for newly decrypted keys
   repeat:
     progress = false
     for each packet not yet successfully decrypted:
       a. Check if I have the key for encryptedUnderNodeId at encryptedUnderVersion:
          - First check newKeys (for chained packets from this rekey)
          - Then check current path keys (for sibling-encrypted packets)
       b. If yes:
          - Retrieve that key
          - Derive unwrapKey = HKDF(key, "wrap")
          - Compute nonce = deriveNonce(epoch, targetNodeId, targetVersion, encryptedUnderNodeId, encryptedUnderVersion)
          - Compute aad = "yappr/rekey/v1" || ownerId || epoch || targetNodeId || targetVersion || encryptedUnderNodeId || encryptedUnderVersion
          - Decrypt: newKey = XChaCha20-Poly1305-Decrypt(unwrapKey, nonce, wrappedKey, aad)
          - Store: newKeys[targetNodeId] = {version: targetVersion, key: newKey}
          - Mark packet as decrypted
          - progress = true
       c. If no: skip for now (may be decryptable after other packets)
   until progress == false
5. Verify I have new root key: newKeys[1] must exist
   - If not, decryption failed (likely revoked or corrupted state)
6. Update path keys: for each node in my path, if newKeys has it, update to new key
   and new version; otherwise keep current key and version (sibling subtrees retain their keys)
7. Decrypt new CEK from encryptedCEK field:
   newRootKey = newKeys[1].key
   cekWrapKey = HKDF(newRootKey, "cek-wrap")
   cekNonce = HKDF(newRootKey, "cek-nonce" || epoch, len=24)
   cekAAD = "yappr/cek/v1" || ownerId || epoch
   CEK[epoch] = XChaCha20-Poly1305-Decrypt(cekWrapKey, cekNonce, encryptedCEK, cekAAD)
8. Update local state: cachedEpoch = epoch, cachedCEK = CEK[epoch], updated path keys

Outputs: Updated local key state

Note: The iterative approach handles packet dependencies. A packet encrypting node N
under node M's NEW key requires first decrypting the packet that provides M's new key.
The AAD binding prevents packet replay or substitution across epochs or feeds.

8.8 Owner Recovery

Inputs: Owner identity, access to identity private key

Procedure:
1. Fetch PrivateFeedState document for own identity
2. Decrypt encryptedSeed using ECIES (§11.5):
   - aad = "yappr/feed-state/v1" || ownerId
   - versionedPayload = ECIES_Decrypt(ownerPrivKey, encryptedSeed, aad)
   - If versionedPayload[0] != 0x01 → reject (unknown version)
   - feedSeed = versionedPayload[1:]  (strip version byte, should be 32 bytes)
3. Fetch ALL PrivateFeedRekey documents for own identity (ordered by epoch)
4. Build revokedLeaves list from rekey docs:
   revokedLeaves = []
   for each rekey doc in epoch order:
     revokedLeaves.append(rekey.revokedLeaf)
5. Determine currentEpoch:
   - If rekey docs exist: currentEpoch = highest rekey.epoch
   - Else: currentEpoch = 1
6. Query ALL PrivateFeedGrant documents where $ownerId = myId
7. Build recipientId → leafIndex mapping from grants
8. Derive availableLeaves from grants (authoritative source, see §6.3):
   availableLeaves = all 1s
   for each grant:
     availableLeaves[grant.leafIndex] = 0
9. Store feedSeed, currentEpoch, revokedLeaves, availableLeaves, recipientId→leafIndex map in local storage
10. Can now create posts, approve/revoke followers
    (Node versions computed on-demand via computeNodeVersion(nodeId, revokedLeaves))

Outputs: Restored local state

Cost: 0 state transitions (O(R + N) reads where R = revocations, N = followers)

Note: Node keys are derived from (feedSeed, nodeId, version). Versions are computed
from the revokedLeaves list using computeNodeVersion() (see 6.2). The authoritative
source of leaf assignments is always the set of active PrivateFeedGrant documents.

8.9 Follower Recovery

Inputs: Follower identity, feed owner identity, access to identity private key

Procedure:
1. Fetch PrivateFeedGrant for (ownerId, myId)
2. If not found → not approved for this feed
3. Decrypt encryptedPayload using ECIES (§11.5):
   - aad = "yappr/grant/v1" || ownerId || myId || grant.leafIndex || grant.epoch
   - payload = ECIES_Decrypt(myPrivKey, encryptedPayload, aad)
4. Validate payload (see §7.2 and §12.0.2):
   - If payload.version != 0x01 → reject (unknown version)
   - If payload.leafIndex != grant.leafIndex → reject (mismatch)
   - Validate path continuity: leaf → parent → ... → root
5. Extract: pathKeys (with nodeId, version, key for each), grantEpoch, grantCEK
6. Store in local storage (preserving version info for each path key)
7. Fetch PrivateFeedRekey documents with epoch > grantEpoch
8. Apply rekeys in order (see 8.7), updating path keys and their versions
9. Now have current keys, can decrypt posts

Outputs: Restored local key state

Cost: 0 state transitions (read only)

---
9. Binary Encoding Formats

9.1 Rekey Packets

┌─────────────────────────────────────────────────────────────┐
│ packetCount: uint8                                          │
├─────────────────────────────────────────────────────────────┤
│ packet[0]:                                                  │
│   targetNodeId: uint16 (big-endian)                         │
│   targetVersion: uint16 (big-endian)                        │
│   encryptedUnderNodeId: uint16 (big-endian)                 │
│   encryptedUnderVersion: uint16 (big-endian)                │
│   wrappedKey: bytes[48] (32 ciphertext + 16 tag)            │
├─────────────────────────────────────────────────────────────┤
│ packet[1]: ...                                              │
│ ...                                                         │
└─────────────────────────────────────────────────────────────┘

Per packet: 2 + 2 + 2 + 2 + 48 = 56 bytes
19 packets: 1 + (19 × 56) = 1065 bytes

Epoch binding: The epoch is stored once in the parent PrivateFeedRekey document,
not per-packet. All packets in a rekey doc apply to that single epoch transition.

AEAD Additional Authenticated Data (AAD):
AAD = "yappr/rekey/v1" || feedOwnerId || epoch || targetNodeId || targetVersion || encryptedUnderNodeId || encryptedUnderVersion

This binds each packet to the specific feed, epoch, and node/version pairs, preventing
packet replay or substitution attacks.

9.1.1 Encrypted CEK

┌─────────────────────────────────────────────────────────────┐
│ encryptedCEK: bytes[48] (32 ciphertext + 16 tag)            │
└─────────────────────────────────────────────────────────────┘

The CEK for the new epoch, encrypted under a key derived from the new root key.
Only followers who successfully derive the new root key can decrypt this.

Fixed size: 48 bytes


9.2 Available Leaves Bitmap

┌─────────────────────────────────────────────────────────────┐
│ bitmap: bytes[128]  (1024 bits, 1 bit per leaf)             │
└─────────────────────────────────────────────────────────────┘

Leaf i available: (bitmap[i / 8] >> (i % 8)) & 1 == 1

Fixed size: 128 bytes

9.3 Grant Payload

9.3.1 Plaintext Structure (Before Encryption)

┌─────────────────────────────────────────────────────────────┐
│ version: uint8              (0x01 for this spec)            │
│ grantEpoch: uint32          (epoch at time of grant)        │
│ leafIndex: uint16           (assigned leaf, for validation) │
│ pathKeyCount: uint8         (number of path keys, typically 11) │
├─────────────────────────────────────────────────────────────┤
│ pathKey[0]:                                                 │
│   nodeId: uint16                                            │
│   version: uint16                                           │
│   key: bytes[32]                                            │
├─────────────────────────────────────────────────────────────┤
│ pathKey[1]: ...                                             │
│ ...                                                         │
├─────────────────────────────────────────────────────────────┤
│ currentCEK: bytes[32]                                       │
└─────────────────────────────────────────────────────────────┘

Plaintext size: 1 + 4 + 2 + 1 + (11 × 36) + 32 = 436 bytes

9.3.2 ECIES Ciphertext Structure

┌─────────────────────────────────────────────────────────────┐
│ ephemeralPubKey: bytes[33]  (compressed secp256k1)          │
├─────────────────────────────────────────────────────────────┤
│ ciphertext: bytes[452]      (436 plaintext + 16 auth tag)   │
└─────────────────────────────────────────────────────────────┘

Total size: 33 + 452 = 485 bytes

AAD for grant encryption:
  "yappr/grant/v1" || ownerId || recipientId || leafIndex || grantEpoch

Note: grantEpoch is included so the follower knows which epoch these keys apply to.
They must apply any rekeys with epoch > grantEpoch to catch up.

---
10. Nonce Derivation

To avoid storing nonces in rekey packets, derive deterministically:

deriveNonce(feedOwnerId, epoch, targetNodeId, targetVersion, encryptedUnderNodeId, encryptedUnderVersion) =
  HKDF(
    ikm  = "yappr/wrapnonce",
    salt = feedOwnerId,
    info = epoch || targetNodeId || targetVersion || encryptedUnderNodeId || encryptedUnderVersion,
    len  = 24
  )

**Security property: deterministic uniqueness, not secrecy.**
Nonce secrecy is not required for AEAD security; only uniqueness matters. The derived nonce
is unique because the (epoch, targetNodeId, targetVersion, encryptedUnderNodeId, encryptedUnderVersion)
tuple is unique per packet:
- epoch increments monotonically
- targetVersion increments per node per revocation
- encryptedUnderNodeId differs between Packet A (sibling) and Packet B (child)

Using feedOwnerId (the 32-byte identity identifier of the feed owner) as the salt provides
feed-specific domain separation while using only public information. Both the owner and
followers have access to this value, enabling deterministic nonce derivation without needing
to transmit a secret salt in the grant payload.

For post encryption, nonce is randomly generated and stored with the post (prevents issues
with postId not being known at encryption time).

---
11. Identity Key Handling

11.1 Required Key Type: Contract-Bound Encryption Key

Private feed encryption requires a **contract-bound ECDSA secp256k1 encryption key** on
the identity. This key must have:

- **Purpose**: ENCRYPTION (or DECRYPTION)
- **Key type**: ECDSA secp256k1
- **Contract bounds**: SingleContract or SingleContractDocumentType referencing the
  Yappr social contract

BLS keys are NOT supported (incompatible with ECDH).

**Rationale for contract-bound keys:**
- Ensures the key is dedicated to this application
- Allows key rotation for other purposes without breaking private feed access
- Provides clear security boundary

11.2 Key Resolution for Grant Encryption

For grant encryption (owner → follower):

1. Fetch follower's identity from platform
2. Find a contract-bound ECDSA secp256k1 encryption key:
   a. Filter identity keys by purpose = ENCRYPTION and contract_bounds matching Yappr contract
   b. If multiple matching keys exist, use the one with the highest security level
   c. If full public key available on-chain → use it directly
   d. If only hash160 available → check FollowRequest.publicKey field
   e. If no matching key found → cannot approve (inform user to add encryption key)
3. Proceed with ECIES encryption (§11.5)

For owner's own PrivateFeedState encryption:
- Owner encrypts to their own contract-bound encryption key
- Same resolution rules apply

11.3 Follow Request Requirements

**Before submitting a FollowRequest**, the client MUST verify that the user's identity
has a contract-bound encryption key. If not, the UI should:
1. Prompt user to add an encryption key via identity update state transition
2. Block the follow request until the key exists on-chain

If the encryption key only has hash160 on-chain (no full public key):
- FollowRequest MUST include the full secp256k1 public key in the publicKey field
- Owner MUST verify: hash160(providedPublicKey) == on-chain hash160

11.4 Key Rotation Considerations

**Critical**: If a follower rotates their contract-bound encryption key, existing grants
become undecryptable because they were encrypted to the old public key.

Implications:
- Followers SHOULD retain old private key material if they rotate keys, OR
- Followers must request a new grant after key rotation
- Owners face the same issue with PrivateFeedState.encryptedSeed

Recommendations:
- Discourage encryption key rotation unless necessary (compromise, etc.)
- If rotation is required, follower should request re-grant before deleting old key
- Consider key escrow or backup mechanisms (out of scope for v1)

11.5 ECIES Encryption Scheme

This protocol uses an ECIES-like (Elliptic Curve Integrated Encryption Scheme)
construction for all asymmetric encryption. This avoids issues with static-static
ECDH and nonce reuse by using fresh ephemeral keys for each encryption.

11.5.1 ECIES_Encrypt(recipientPubKey, plaintext, aad)

Procedure:
1. Generate ephemeral keypair:
   - ephemeralPrivKey = random(32 bytes)
   - ephemeralPubKey = ephemeralPrivKey × G  (secp256k1 generator)

2. Compute shared secret via ECDH:
   - sharedPoint = ephemeralPrivKey × recipientPubKey
   - sharedSecret = SHA256(sharedPoint.x)  (x-coordinate, 32 bytes)

3. Derive encryption key and nonce via HKDF:
   - derived = HKDF(
       ikm  = sharedSecret,
       salt = ephemeralPubKey (compressed, 33 bytes),
       info = "yappr/ecies/v1",
       len  = 56
     )
   - encKey = derived[0:32]   (256-bit key)
   - nonce = derived[32:56]   (192-bit nonce for XChaCha20)

4. Encrypt with XChaCha20-Poly1305:
   - ciphertext = XChaCha20-Poly1305-Encrypt(encKey, nonce, plaintext, aad)
   - (ciphertext includes 16-byte authentication tag)

5. Return: ephemeralPubKey (compressed, 33 bytes) || ciphertext

11.5.2 ECIES_Decrypt(recipientPrivKey, eciesCiphertext, aad)

Procedure:
1. Parse eciesCiphertext:
   - ephemeralPubKey = eciesCiphertext[0:33]
   - ciphertext = eciesCiphertext[33:]

2. Compute shared secret via ECDH:
   - sharedPoint = recipientPrivKey × ephemeralPubKey
   - sharedSecret = SHA256(sharedPoint.x)

3. Derive encryption key and nonce via HKDF:
   - derived = HKDF(
       ikm  = sharedSecret,
       salt = ephemeralPubKey (compressed, 33 bytes),
       info = "yappr/ecies/v1",
       len  = 56
     )
   - encKey = derived[0:32]
   - nonce = derived[32:56]

4. Decrypt with XChaCha20-Poly1305:
   - plaintext = XChaCha20-Poly1305-Decrypt(encKey, nonce, ciphertext, aad)
   - If authentication fails → return error

5. Return: plaintext

11.5.3 Security Properties

- **No nonce reuse**: Each encryption uses a fresh ephemeral keypair, which produces
  a unique (key, nonce) pair. Even encrypting the same plaintext twice produces
  different ciphertexts.

- **Forward secrecy per-grant**: Compromise of the owner's long-term key does not
  reveal previously encrypted grants (ephemeral keys are discarded after use).

- **AAD binding**: The additional authenticated data (AAD) binds the ciphertext to
  its context (protocol version, identities, indices, epochs), preventing replay
  and substitution attacks.

- **No owner key reuse for ECDH**: The owner's identity key is NOT used in the ECDH
  computation. Only ephemeral keys (sender side) and recipient identity keys are used.

11.5.4 AAD Specifications

Different contexts use different AAD to prevent cross-context attacks:

| Context                | AAD Format                                                    |
|------------------------|---------------------------------------------------------------|
| Private Post           | "yappr/post/v1" \|\| ownerId \|\| epoch \|\| nonce            |
| Encrypted CEK          | "yappr/cek/v1" \|\| ownerId \|\| epoch                        |
| Rekey Packet           | "yappr/rekey/v1" \|\| ownerId \|\| epoch \|\| targetNodeId \|\| targetVersion \|\| encryptedUnderNodeId \|\| encryptedUnderVersion |
| PrivateFeedGrant       | "yappr/grant/v1" \|\| ownerId \|\| recipientId \|\| leafIndex \|\| epoch |
| PrivateFeedState       | "yappr/feed-state/v1" \|\| ownerId                            |

The AAD is not stored (it's reconstructed from document fields on decryption).

---
12. Validation and Error Handling

12.0 Input Validation (Bounds/Sanity Checks)

Clients MUST validate all inputs before processing. Reject with appropriate error:

12.0.1 Rekey Document Validation
| Check                         | Constraint                | Reject if                |
|-------------------------------|---------------------------|--------------------------|
| packetCount                   | ≤ 64                      | packetCount > 64         |
| targetNodeId                  | 1 ≤ id ≤ 2047             | Outside valid tree range |
| encryptedUnderNodeId          | 1 ≤ id ≤ 2047             | Outside valid tree range |
| targetVersion                 | < 65535                   | Version overflow         |
| epoch                         | > lastAppliedEpoch        | Epoch not advancing      |
| revokedLeaf                   | 0 ≤ leaf < 1024           | Invalid leaf index       |

12.0.2 Grant Validation (Follower)
| Check                         | Constraint                          | Reject if              |
|-------------------------------|-------------------------------------|------------------------|
| version                       | == 0x01                             | Unknown version        |
| leafIndex (plaintext)         | == grant.leafIndex (document field) | Mismatch               |
| pathKeyCount                  | ≤ 11 (for 1024-leaf tree)           | Too many path keys     |
| pathKeys[0].nodeId            | == 1024 + leafIndex                 | Wrong leaf node        |
| pathKeys[i].nodeId            | == parent(pathKeys[i-1].nodeId)     | Path discontinuity     |
| pathKeys[last].nodeId         | == 1                                | Path doesn't reach root|

12.0.3 Version Monotonicity
When applying rekeys, track node versions. For each node on follower's path:
- New version MUST be > previous version for that node
- Reject rekey if version decreases unexpectedly (indicates corruption or attack)

12.1 Decryption Failures
┌──────────────────────────────┬──────────────────────────────────────────────┐
│           Scenario           │                   Behavior                   │
├──────────────────────────────┼──────────────────────────────────────────────┤
│ Missing grant                │ Show teaser, display "Request Access" UI     │
├──────────────────────────────┼──────────────────────────────────────────────┤
│ Epoch too new, no rekey docs │ Show teaser, retry fetch later               │
├──────────────────────────────┼──────────────────────────────────────────────┤
│ Rekey application fails      │ Show teaser, log error for debugging         │
├──────────────────────────────┼──────────────────────────────────────────────┤
│ AEAD authentication fails    │ Show teaser, log error (possible corruption) │
├──────────────────────────────┼──────────────────────────────────────────────┤
│ Grant exists, can't decrypt  │ User was revoked (see §12.3)                 │
│ current epoch                │                                              │
└──────────────────────────────┴──────────────────────────────────────────────┘
12.2 State Inconsistencies
┌────────────────────────┬──────────────────────────────────────────────┐
│        Scenario        │                   Recovery                   │
├────────────────────────┼──────────────────────────────────────────────┤
│ Local keys out of sync │ Refetch grant, replay all rekeys             │
├────────────────────────┼──────────────────────────────────────────────┤
│ Missing rekey doc      │ Query for all rekeys, apply what's available │
├────────────────────────┼──────────────────────────────────────────────┤
│ Owner state lost       │ Recover from PrivateFeedState + latest rekey │
└────────────────────────┴──────────────────────────────────────────────┘

12.3 Revoked Follower with Stale Grant

If grant deletion fails during revocation (network error, state transition timeout), the
grant document may persist even though the user has been cryptographically revoked.

Detection: Follower has a PrivateFeedGrant but cannot decrypt current-epoch posts:
- Rekey application fails (no packet decryptable)
- Unable to derive new root key after applying all available rekeys

Client behavior:
1. Treat as revoked: Show "Access Revoked" UI, not "Request Access"
2. Do NOT auto-retry or re-request access (owner explicitly revoked)
3. Clear locally cached keys for this feed
4. Optionally: Delete the orphaned grant (follower owns nothing, can't delete)

Owner cleanup (background task):
1. Periodically query own PrivateFeedGrant documents
2. For each grant, check if it is orphaned:
   - Let grantEpoch = grant.epoch
   - Let grantLeaf = grant.leafIndex
   - Query PrivateFeedRekey docs where revokedLeaf == grantLeaf AND epoch > grantEpoch
   - If any such rekey exists → this grant is orphaned (leaf was revoked after grant issued)
3. If grant is orphaned: retry deletion

IMPORTANT: Do NOT simply check if leafIndex appears in revokedLeaves. Since leaves can be
reused, a leaf may have been revoked in the past and later reassigned to a new follower.
Only grants issued BEFORE their leaf was revoked are orphaned.

**Security note:** Cryptographically, the user is revoked and cannot decrypt new posts
regardless of whether the grant document exists.

**Capacity note:** Orphaned grants DO affect operational capacity. The unique index on
($ownerId, leafIndex) prevents assigning that leaf to a new follower until the orphaned
grant is deleted. If cleanup is neglected or buggy, capacity can "leak" over time. At
expected revocation rates (5-50), this is unlikely to exhaust 1024 leaves, but cleanup
SHOULD be implemented and monitored.

---
13. Versioning and Migration

13.1 Protocol Version

This specification uses two versioning strategies depending on payload type:

**Variable-format payloads** (may have structural changes in future versions):

These include a version byte as the first byte of the plaintext (before encryption):

    plaintext = version (1 byte) || payload_data
    ciphertext = encrypt(plaintext)

Applies to:
- PrivateFeedGrant.encryptedPayload: 0x01 || grantEpoch || leafIndex || pathKeys || currentCEK
- PrivateFeedState.encryptedSeed: 0x01 || feedSeed
- Post.encryptedContent: 0x01 || plaintext_content

For ECIES payloads (grants, feed state), the full structure is:

    encryptedPayload = ephemeralPubKey (33 bytes) || ciphertext

Where ciphertext contains the encrypted (version || payload_data) plus auth tag.

**Fixed-size key wrapping** (raw 32-byte keys, no structural changes expected):

These do NOT include a version prefix. Instead, versioning is implicit in the AAD string:

- Rekey packet wrappedKey: AAD includes "yappr/rekey/v1"
- encryptedCEK: AAD includes "yappr/cek/v1"

This preserves the fixed 48-byte size (32-byte key + 16-byte auth tag) defined in §9.1.

If the wrapping format ever changes, a new AAD version string (e.g., "yappr/rekey/v2")
would be used, and the rekey document structure would need to indicate which version applies.

**Version 1**: Initial implementation as specified here.

13.2 Tree Capacity Upgrade

If 1024 followers becomes insufficient:

1. Create new PrivateFeedState with larger tree (2048, 4096)
2. Issue new grants to all existing followers with new leaf assignments
3. Existing posts remain readable (epoch keys unchanged)
4. New posts use new tree
5. Old tree becomes read-only

This is an O(N) migration but expected to be rare.

---
14. Summary of On-Chain Costs
┌─────────────────────┬───────────────────┬───────────────────┬───────────────────┬─────────────────┐
│      Operation      │ Documents Created │ Documents Deleted │ Total Transitions │ Reads Required  │
├─────────────────────┼───────────────────┼───────────────────┼───────────────────┼─────────────────┤
│ Enable Private Feed │ 1                 │ 0                 │ 1                 │ 0               │
├─────────────────────┼───────────────────┼───────────────────┼───────────────────┼─────────────────┤
│ Create Private Post │ 1                 │ 0                 │ 1                 │ 0               │
├─────────────────────┼───────────────────┼───────────────────┼───────────────────┼─────────────────┤
│ Create Public Post  │ 1                 │ 0                 │ 1                 │ 0               │
├─────────────────────┼───────────────────┼───────────────────┼───────────────────┼─────────────────┤
│ Request Follow      │ 1                 │ 0                 │ 1                 │ O(1)            │
├─────────────────────┼───────────────────┼───────────────────┼───────────────────┼─────────────────┤
│ Cancel Request      │ 0                 │ 1                 │ 1                 │ 0               │
├─────────────────────┼───────────────────┼───────────────────┼───────────────────┼─────────────────┤
│ Approve Follower    │ 1                 │ 0                 │ 1                 │ O(1)            │
├─────────────────────┼───────────────────┼───────────────────┼───────────────────┼─────────────────┤
│ Revoke Follower     │ 1                 │ 1                 │ 2                 │ O(1)            │
├─────────────────────┼───────────────────┼───────────────────┼───────────────────┼─────────────────┤
│ Owner Recovery      │ 0                 │ 0                 │ 0                 │ O(N+R) grants+rekeys │
├─────────────────────┼───────────────────┼───────────────────┼───────────────────┼─────────────────┤
│ Follower Recovery   │ 0                 │ 0                 │ 0                 │ O(R) rekeys     │
└─────────────────────┴───────────────────┴───────────────────┴───────────────────┴─────────────────┘
---
15. Open Items for PRD

The following are explicitly deferred to the PRD phase:

- UI/UX for enabling private feed
- UI/UX for composing private vs public posts
- UI/UX for managing follow requests
- UI/UX for viewing/managing private followers
- UI/UX for revocation confirmation
- Teaser content guidelines and character limits
- Notification system integration
- Analytics and metrics
- Rate limiting considerations
- Cost estimation and display to users

---
16. Addendum: Inherited Encryption for Replies

This section defines the encryption behavior when a private post is a reply to another
private post. Quotes are handled differently (see §16.7).

16.1 Problem Statement

When User B replies privately to User A's private post, which CEK should be used?

- Option A: B's own feed CEK → creates fragmented visibility (some see parent, not reply)
- Option B: A's CEK (inherited) → reply visibility matches parent visibility

This specification mandates Option B: **inherited encryption for replies**.

16.2 Inheritance Rule

A private reply to a private post MUST use the same CEK as the parent post.
This is determined by traversing the reply chain.

```
getEncryptionSource(post):
  if post.replyToPostId exists:
    parent = fetchPost(post.replyToPostId)
    if parent.encryptedContent exists:
      return getEncryptionSource(parent)  // recurse up the chain
  return post.$ownerId  // base case: use own feed's CEK
```

The encryption source is the `$ownerId` of the root private post in the reply chain.

16.3 Key Selection

When creating a private reply to a private post:

1. Determine encryption source via `getEncryptionSource(parentPost)`
2. Use that identity's CEK at the epoch currently cached by the replier
3. Encrypt using the standard post encryption algorithm (§8.2) with:
   - CEK from the source identity's feed
   - authorId in AAD remains the actual post author (`$ownerId` of the reply)

16.4 Decryption

When decrypting a private post with `replyToPostId`:

1. Determine encryption source via `getEncryptionSource(post)`
2. Use that identity's feed keys (from grant + rekeys) to derive CEK
3. Decrypt using standard algorithm (§8.6)

16.5 Implications

**Visibility inheritance**: Anyone who can decrypt the parent can decrypt the reply.
The reply's visibility is bound to the original poster's private follower set.

**No new document fields**: The `replyToPostId` field already exists; no schema
changes required.

**Epoch selection**: The replier uses whatever epoch they have cached for the
source identity's feed. If the source has revoked users since the replier last
synced, the reply may use an older epoch. This is acceptable—it reflects the
replier's view at the time of reply.

**Parent deletion**: If the parent post is deleted, clients cannot determine the
encryption source and cannot decrypt the reply. This is an accepted edge case.

16.6 Constraints

- A private reply to a private post MUST inherit encryption (not optional)
- A public reply to a private post is allowed (no encryption, visible to all)
- Cannot privately reply to a private post you cannot decrypt (no CEK available)

16.7 Quotes (Different Behavior)

Quotes do NOT inherit encryption. A quote post lives in the quoter's feed, not the
original thread.

**Quote encryption rules**:
- Public quote of any post → no encryption, visible to all
- Private quote → uses quoter's own feed CEK (quoter's private followers can see)

**Quoted content visibility**:
- The quote post references the original via `quotedPostId`
- The quoted content is fetched and decrypted separately by the viewer
- If viewer cannot decrypt the quoted post, they see a placeholder: "[Private post]"

**Example**:
- User A makes a private post (A's private followers can see)
- User B quotes it privately (B's private followers can see B's quote)
- User C follows B privately but not A:
  - C sees B's quote post (decrypted with B's CEK)
  - C sees "[Private post from @A]" for the embedded quoted content

This separation respects that quotes are the quoter's content in the quoter's space.
