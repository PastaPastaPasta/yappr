# Pre-Mainnet TODO

Tasks to complete before deploying to Dash mainnet.

## Contract Changes

- [ ] **Merge avatar into profile document** - Currently `profile` and `avatar` are separate document types requiring 2 queries per user. The `avatarId` reference field on profile isn't used. Merging would:
  - Reduce queries (1 instead of 21 for 20 posts)
  - Simplify `enrichPostsBatch()` to fetch everything in one batch query
  - Avatar data is only ~50 bytes (seed + style JSON)
  - Remove unused `avatarId` field or repurpose for actual avatar data

- [ ] **Redesign DM contract** - Current design has redundancy and ownership issues:

  **Remove from current design:**
  - `recipientId` from every message (redundant with conversationId)
  - `read` field (recipient can't update sender-owned documents)
  - `directMessage` from main contract (using separate DM contract)

  **New document types:**
  ```
  conversationInvite:
    - recipientId (32 bytes)
    - conversationId (32 bytes)
    - indexes: (recipientId, $createdAt) for inbox
    - Purpose: notify recipient of new conversation

  directMessage:
    - conversationId (32 bytes only, no recipientId)
    - encryptedContent
    - indexes: (conversationId, $createdAt)

  readReceipt:
    - conversationId (32 bytes)
    - lastReadAt (timestamp) or lastReadMessageId
    - indexes:
      - unique ($ownerId, conversationId) - one per user per conversation
      - (conversationId) - so other party can query read status
    - Purpose: user-owned, updatable read tracking
  ```

  **Benefits:**
  - Saves 32 bytes per message (no recipientId after first)
  - Proper read receipts (each user owns their own)
  - Clean separation: inbox notifications vs messages vs read status

- [ ] **Remove `notification` from main contract** - Not implemented, and has the same `read` field ownership problem. Using derived notifications instead (see Notifications section below).

- [ ] **Remove unused document types** - Consider removing until actually needed:
  - `mute` - removing entirely, just use `block` instead
  - `list` / `listMember` - no service/UI

- [ ] **Remove redundant `ownerBlocks` index** - The `ownerBlocks` index exists to support `orderBy: $createdAt` but actual usage doesn't need chronological ordering. The `ownerAndBlocked` index can serve `$ownerId` queries alone since it's the first field.

- [ ] **Add `notificationReadState` document type** - Compact read state tracking for derived notifications:
  ```
  notificationReadState:
    - readHashes (bytes, max 5000) - packed 10-byte truncated hashes
    - indexes: unique ($ownerId) - one per user
    - mutable: true
  ```

  **Design:**
  - Notifications are derived from existing documents (likes, follows, reposts, replies, mentions)
  - No separate notification documents created - zero extra fees for actors
  - Read state stored as compact blob: 10-byte hash per notification = 500 notifications in 5KB
  - Hash is truncated from the source document ID (like, follow, repost, reply, or mention doc)
  - Oldest hashes pruned when blob is full (FIFO)
  - User pays only when marking notifications as read (updating their own document)

- [ ] **Add quote notification contract** - Similar to `yappr-mention-contract.json`:
  ```
  postQuote:
    - postId (32 bytes) - the quoting post
    - quotedPostId (32 bytes) - the original post being quoted
    - quotedPostOwnerId (32 bytes) - owner of the quoted post (for efficient queries)
    - indexes:
      - (quotedPostOwnerId, $createdAt) - "quotes of my posts"
      - (quotedPostId) - "all quotes of this post"
      - unique (postId) - one quote record per quoting post
    - mutable: false
  ```

  **Why needed:** Main contract has `quotedPostId` on posts but no index. Can't query "quotes of my posts" without this.

- [ ] **Remove unused profile fields** - Not implemented in UI:
  - `avatarId` (if merging avatar into profile)
  - `website`
  - `location`
  - `bannerUrl`

## Notifications

Notifications are derived from existing documents rather than stored separately. Query feasibility:

| Type | Query Method | Contract/Index |
|------|--------------|----------------|
| New follower | ✅ Direct | `follow.followers` (followingId, $createdAt) |
| Mention | ✅ Direct | `postMention.byMentionedUser` (mentionedUserId, $createdAt) |
| Quote | ✅ Direct (needs contract) | `postQuote` (quotedPostOwnerId, $createdAt) |
| Like on post | ⚠️ Per-post | `like.postLikes` - fetch user's posts first |
| Repost of post | ⚠️ Per-post | `repost.postReposts` - fetch user's posts first |
| Reply to post | ⚠️ Per-post | `post.replyToPost` - fetch user's posts first |

**Implementation approach for likes/reposts/replies:**
- Cache user's post IDs locally (update on new post creation)
- Query only recent posts (last 30 days or last 100 posts)
- Batch queries in parallel for efficiency
- Filter by `$createdAt > lastCheckTime` to get only new activity

## Performance

- [ ] Review batch query patterns for efficiency
- [ ] Audit all N+1 query situations

## Security

- [ ] Audit private key handling
- [ ] Review all state transition validations
