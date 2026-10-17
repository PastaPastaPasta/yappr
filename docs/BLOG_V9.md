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
still possible. The slug index skips absent parents. There is no
`ownerRefersTo` on these types to change.
`blogComment.blogPostId` stays `moderatedDocument`: posts remain
owner-permanent and recorded moderator removals preserve the target identity
needed by `postOwnerAndTime`'s derived `$ownerId`.

## Moderating posts and comments

Both types mirror social v17's post/reply rule:

```json
{"delete": true, "deleteWithin": 604800, "deleteSettled": {"leader": true, "approvals": 3}}
```

Recorded removals stay enabled (the same default as social).
`deleteKeepsFields` keeps `blogId` and `$createdAt` for a post,
`blogPostId` and `$createdAt` for a comment, adapting social's retained parent
and index fields to this contract. Content is not retained in those records.
Fresh content can be removed by one moderator; settled content requires
three approvals including the elected leader. The interim cannot delete
settled content. Author comment deletion and post tombstones stay as before.

The per-contract moderation descriptor reads the window and team rule from
the contract file. The shared removal dialog and team-actions panel therefore
offer proposals and approvals for blog posts/comments. Existing v8 deployments
stay windowless and keep owner-permanent blogs. Blogs themselves keep
windowless moderator deletion; storefront's rules do not change.

## Validation and Sakura evidence

Strict-size validation passes for testnet and mainnet: approximately **9,074 B
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

- Amended v9: `5F9AQMA8U3QdQNjXJx7WYbZtr7qaid6mBwuJY4sMkohV`.
  Signed create **9,040 B**, registration **36,393,733,480 credits (2,183.6¢)**.
  Its serialized contract is **8,980 B**.
- Owner deletion: blog `3VHFfRs2188ALyj4vCJyDbJFgjQgCfhXTXu3BeQirDHh`
  is absent; post `ckAnQbotbpcPRXBTb873Bzod65rEFjPis91ojUoZ94r`
  and comment `FtNJ7m7v2XoZSAHvFaujLWb5VvM5HHpK3qETYH1secpq` still
  read back. A follow existed when deletion ran. Deletion returned **48,203,094 credits (2.9¢)**. A later author
  retraction succeeded with the deleted blog reference cleared, its body and
  live marker absent; the post remains as a tombstone. Its measured refund
  was **72,244,330 credits (4.3¢)**.
- Fresh moderator removal: post `JAgL8SCgX8Tq7Es82haHA4bgXjYYLKkZHhbFnSxLw7Cj`
  is absent and its removal record keeps the correct `blogId` and `$createdAt`.
  Removal cost **15,358,780 credits (0.92¢)**.
- Five-second variant: `BzsLLtHuWvBMHJTCU3gr6iWs1zHC867fReKyFCoM6E9F`.
  Signed create **9,005 B**, registration **36,392,824,060 credits (2,183.6¢)**.
  Post `4HDkpfQ9CprABL65b71pNPno8FyBhm596WzM8dGsZPVv` was last modified
  at `1792275905104`; block time `1792275914608` was beyond its five-second
  window. Single-moderator removal was refused with the window-elapsed
  message; the settled API refused because no team is seated. Both readbacks
  retain the post. This proves the team requirement; executing three live
  approvals needs an elected charter and was not part of this short proof.

Offline validation: **315 probes passed**, **805 constraint cases passed**,
**10 node-only cases skipped**, no failures; blog self-test **19 checks**.
The unit tests exercise blog proposal and approval writes with the blog's
contract id, plus the v9/older-cut moderation gates and deletion cache reset.
