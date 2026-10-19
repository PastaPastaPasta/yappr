# Blog v9 owner amendments

The 2026-10-17 owner decisions amend the unregistered v9 cut in
`contracts/yappr-blog-contract.json` in place. No production contract is
updated or registered by this work. Storefront's contract is unchanged.

## Deleting a blog

`blog.canBeDeleted` is true. Blog settings offers **Delete blog**, confirmed
with an explanation that posts stop showing on the blog page and in discovery,
remain stored, and cannot be brought back by undoing the blog deletion.
The client clears cached blogs after acceptance and returns to the blog list.
A missing blog's page says it is no longer available; post discovery already
omits posts whose parent blog cannot be read. Public post links need their
blog and therefore become unavailable too. This is not a cascade deletion:
the `blogPost`, `blogComment` and `blogFollow` documents stay stored.

Platform 5.0 PV14 admits exactly one reference kind for a target type:
`moderatedDocument` requires that only moderators can remove it and every
removal leaves a record. Owner deletion makes the blog a `deletableDocument`
target. Accordingly `blogPost.blogId`, `blogFollow.blogId` and `report.blogId`
change kind. The post's `where: {$ownerId: $ownerId}` gate and immutable
`blogId` stay. A live post must still carry `blogId` (`hasBody`), but a
tombstone may omit it. Platform permits clearing an immutable
`deletableDocument` reference once its target is gone; the client retries a
post retraction with only that missing reference cleared. This avoids locking
an author's content permanently after blog deletion. Existing live posts
remain stored, but further content edits need their parent; retraction is
still possible. **My posts** in the management page lists the author’s live
posts independently of their blogs, including deleted ones, and offers a
confirmed retraction. `blogPost.ownerAndTime [$ownerId, live, $createdAt]`
with `skipIfAbsent` makes this reachable without a parent.
`blogComment.ownerAndTime [$ownerId, $createdAt]` lets cleanup find the
reader’s comments even on another author’s only tombstoned post.
The slug index skips absent parents. There is no
`ownerRefersTo` on these types to change.
`blogComment.blogPostId` stays `moderatedDocument`: posts remain
owner-permanent and recorded moderator removals preserve the target identity
needed by `postOwnerAndTime`'s derived `$ownerId`.

## Moderating posts and comments

Both types mirror social v17's post/reply rule:

```json
{"delete": true, "deleteWithin": 86400, "deleteSettled": {"leader": true, "approvals": 3}}
```

Recorded removals stay enabled (the same default as social).
`deleteKeepsFields` keeps `blogId` and `$createdAt` for a post,
`blogPostId` and `$createdAt` for a comment, adapting social's retained parent
and index fields to this contract. Content is not retained in those records.
For a day after its last change (D39; 604,800 s before 2026-10-19) content can be
removed by one moderator; settled content requires
three approvals including the elected leader. The interim cannot delete
settled content. Author comment deletion and post tombstones stay as before.

The per-contract moderation descriptor reads the window and team rule from
the contract file. The shared removal dialog and team-actions panel therefore
offer proposals and approvals for blog posts/comments. Existing v8 deployments
stay windowless and keep owner-permanent blogs. Blogs themselves keep
windowless moderator deletion; storefront's rules do not change.

## Validation and Sakura evidence

Strict-size validation passes for testnet and mainnet: approximately **9,247 B
signed** (original v9 8,852 B), below the 20,000 B working budget and 20,480 B
protocol cap. The App Connect set pins the amended file's SHA-256.

The offline probes include both accepted owner-deletable blog references and
a refusal control for `moderatedDocument` pointing at one. Constraint cases
cover unconstrained owner blog deletion. The blog battery's b8 now deletes a
separate blog with a post and verifies that the post remains, leaving its main
fixture available for later cases. b8 also retracts that orphaned post, leaving a blank tombstone. Cleanup scans
the live timeline so deleted parents do not hide run fixtures, and uses owner
blog deletion on v9. Its self-test pins reference kinds,
settled moderation and retained record fields.

### Live proof (2026-10-17)

[Public readbacks and measured balance deltas](evidence/blog-v9-amendments-sakura.json)
record the final throwaway contract and the earlier five-second variant,
owned by persona 79; author 77 and reader
78 supplied fixtures. Personas 70–75 were not used. The maker signed nothing
and its identity nonce stayed **34 → 34**.

- Amended v9: `36Fk9xCJqwsSVVd6UYYFP6rWN9SFuzaff55ipJRcR844`.
  Signed create **9,213 B**, registration **38,405,323,540 credits (2,304.3¢)**.
  Its serialized contract is **9,153 B**, including both owner indexes.
- Owner deletion: blog `6dmx2PzUsi8qqk9RZGsW71KpjxDbs6RFjDsuAq93pugf`
  is absent; post `ALiU9YrtSxbS15Two9bkCH7CWS3wjx2jBKRNkGsuQrQv`
  and comment `54JsPWxxD5k8hXcxLhj81sg6kXitvjNneLfALzVv5FyQ` still
  read back. A follow existed when deletion ran. Deletion returned
  **48,244,974 credits (2.9¢)**. The author’s owner-index query found the
  retained post without its parent. Retraction then cleared the missing blog
  reference, body and live marker, retaining a tombstone and returning
  **105,123,710 credits (6.3¢)**. The reader’s owner-index query still found
  their comment after this third-party post retraction.
- Fresh moderator removal: post `7mVtG4R4ZMTZ3veA95Y7fai8zDvX4HB6tPUGExyMZaVj`
  is absent and its removal record keeps the correct `blogId` and `$createdAt`.
  Removal cost **16,177,220 credits (0.97¢)**.
- Five-second variant: `BzsLLtHuWvBMHJTCU3gr6iWs1zHC867fReKyFCoM6E9F`.
  Signed create **9,005 B**, registration **36,392,824,060 credits (2,183.6¢)**.
  Post `4HDkpfQ9CprABL65b71pNPno8FyBhm596WzM8dGsZPVv` was last modified
  at `1792275905104`; block time `1792275914608` was beyond its five-second
  window. Single-moderator removal was refused with the window-elapsed
  message; the settled API refused because no team is seated. Both readbacks
  retain the post. This proves the team requirement; executing three live
  approvals needs an elected charter and was not part of this short proof.

Offline validation: **315 probes passed**, **805 constraint cases passed**,
**10 node-only cases skipped**, no failures; blog self-test **20 checks**.
The unit tests exercise blog proposal and approval writes with the blog's
contract id, plus the v9/older-cut moderation gates and deletion cache reset.

Local validation also passed lint, dead-code lint, production build,
**3,459 unit tests across 238 files**, and **21 browser component tests**,
including blog deletion followed by owner retraction and paging after a
retraction removes the cursor from the live index.
