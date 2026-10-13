# Platform 5.0.0-beta.6: what changed for Yappr

Dash Platform 5.0.0-beta.6 (2026-10-13, still protocol 14) is a small release. Sakura's Platform chain was wiped for it the same day, so every Yappr contract was registered again on a fresh genesis ([SAKURA_BETA6_DEPLOY.md](SAKURA_BETA6_DEPLOY.md)). This note records what the release adds, what Yappr uses, and what was considered and left out. Credit costs are paired with cents at $60/DASH (1M credits = 0.06¢).

## The release

| Change | PR | What it means |
| --- | --- | --- |
| A `refersTo` `where` entry compares typed arrays | #5388 | `"tags": "tags"` holds when both lists have the same elements in the same order; `{ "contains": b }` when the referenced list holds `b` (`"$ownerId"` makes it a writer gate: only a listed identity may write); `{ "containsAll": b }` when it holds every element of another list. Billed 100 credits per element read. A typed array equals no single value. |
| An index-only type may index the elements of a typed array | #5390 | One entry per distinct element. The array needs `uniqueItems`, another index's whole key must be part of this one, and an index whose only skip property is the array is refused (10231). |
| `preallocated` and `summableOffCountIndex` through a list | #5394 | A `where` equality between two lists fixes every element, so a like can be counted per tag of its post. `contains` and `containsAll` fix no element and key nothing. |
| A sponsored batch's fee increase is charged to its signer | #5398 | The contract owner is judged and charged without the user fee increase; the signer pays the increase or the batch is refused unpaid (40210). |

## What Yappr uses

**Social v16** ([SOCIAL_V16.md](SOCIAL_V16.md), #746): up to four tags per post, and a like counted under every tag of its post. It is the only Yappr type that fits #5390/#5394: social `like` is the only index-only type whose counters follow a list on the referenced document.

**#5398 changes nothing for Yappr.** Social `post`, `reply`, `like` and `likeReply` offer contract-owner gas (`gasFeesPaidBy: 2`, PreferContractOwner, on their optional YAPP cost), but no Yappr code path sets a user fee increase: the web client, `vendor/platform-auth`, the mobile engine and the scripts never pass one, and the 5.0.0-beta.6 SDKs default it to 0. With an increase of 0 every branch of the new fee rule charges exactly what beta.5 did. Whoever pays the gas also pays the action fees, so a sponsored YAPP post costs the maker the 80M-credit (≈0.005¢) moderators' fee as before.

**Nothing registered breaks.** No `where` entry in any Yappr contract has a list on either side, the indexed lists (`post`/`reply` `mentionedUserIds`, pollr `vote.choices`) are on ordinary types within the limits, and pollr's `choicesAreOptions` rule still parses.

## Considered and left out

| Candidate | Decision | Why |
| --- | --- | --- |
| DM v5: a `members contains "$ownerId"` writer gate on group messages and keys | **No** | It needs a plain on-chain roster and a `groupId` on every message, which publishes every group's membership and links its messages, against DM v5's first rule that no field is shared between two participants' documents ([DM_V5.md](DM_V5.md)). There is no gap for it to close: rosters and keyrings are the owner's own documents under a unique `[$ownerId, handle]` index, non-members cannot derive a group's tags, and readers drop documents whose owner is not the stream's sender. |
| Blog: a post's `labels` must be among its blog's (`containsAll`) | **No** | Both documents belong to one owner, so it only stops an owner contradicting themselves; it would break the publish-then-label flow, block edits of posts using a label the blog dropped, and fail every post replace (40145) after a moderator removes the blog unless `blog.labels` joins `deleteKeepsFields`. |
| Blog: a label index `[blogId, labels, $createdAt]` | Deferred | The blog home reads the newest 100 posts and filters labels in the browser; the 100-post cap is the real limit, so this belongs to a blog pagination change. Indexes on lists already worked on beta.5. |
| Storefront: `paymentUris`, `contactMethods`, `postalPatterns` from JSON strings to lists | Deferred | `paymentUris` entries carry a seller-typed label a list of strings would drop ([SOCIAL_V9.md](SOCIAL_V9.md)); converting only the other two adds an encoding for little gain. |
| Storefront: an item review must name an item of its order (`storeOrder.itemIds`, `itemReview.orderId` `where { "itemIds": { "contains": "itemId" } }`) | Deferred: product decision | It closes a real gap (one purchase lets a buyer review every item of that store), for ~3,200 credits (≈0.0002¢) per review, but publishes what each buyer bought, which today stays in `encryptedPayload`. A `where` cannot compare a commitment, so there is no private form. |
| Multi-author blogs or store staff (`contains "$ownerId"`) | Not now | New products, and store staff could not decrypt orders keyed to the seller. Needs its own design. |
| Social: packed media bytes as lists | No | The `media` rule already enforces one digest and kind per URL. |

Everything except social is therefore registered on the beta.6 genesis from the same files, with the same sha256 pins, as on beta.5.
