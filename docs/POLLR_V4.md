# Pollr contract v4

**Not currently deployed.** The 2026-09-17 registration
(`HRuWcjcGVmhDZV63SWWqRKdorGuVMKGeC7VqU9rYHFZK`, 40/40 battery checks) went with
the moutai wipe, and the JSON has since been re-cut for **4.2.0-beta.2** — see
"beta.2 re-cut" below. Built by `scripts/build-pollr-v4-contract.py` from the v3
file, published by `scripts/register-feature-contract.mjs`, verified live by
`scripts/verify-pollr-v4.mjs`. Protocol 14, Platform 4.2.0-beta.2 or later.

## beta.2 re-cut

beta.2 lets a `propertyAgreement` name the referenced document's `$ownerId`, so
ballots bind to the identity that actually signed the poll:

- **`vote.pollId` / `multiVote.pollId` agree `{pollOwnerId: "$ownerId"}`**,
  not `{pollOwnerId: "author"}`.
- **`poll.author` is gone**, and with it the whole "attested author, and the
  gap" section this document used to carry: the flag (`Poll.authorIsOwner`),
  the client refusal built on it, and the battery case that documented a forged
  poll landing. There is nothing left to forge.
- `byPollOwner` stays preallocatable — a referenced document determines its own
  `$ownerId` exactly as it determined `author` — and `COUNT_AND_RANK` drops the
  `countable` key `rangeCountable` now implies.

A side effect worth keeping: the v4 poll payload is byte-identical to v3's
again, so battery case p7's preallocation measurement is the ballot trees
alone, with no payload difference mixed in.

**The standalone Pollr app needs the same cut.** The testnet contract
(`GBCR8Jqt…`) is externally owned and is what
`https://pastapastapasta.github.io/pollr` reads; only the devnet clone is ours.
This JSON is the source of record for that re-cut, and the app's own repo
(`PastaPastaPasta/pollr`) has to publish it and adopt the write/read shapes
below before a shared testnet v4 exists. The beta.2 re-cut makes that easier,
not harder: a v4 poll is now written exactly like a v3 one, so the standalone
app's poll-create path needs no change at all — only its ballot path does.
`scripts/verify-poll-interop.mjs`, which creates polls without an `author`,
works against a v4 contract again for the same reason.

## What changed and why

v3 stored ballots as ordinary documents: each carried a body nobody ever read,
a `pollId` consensus never checked (any vote could name a poll that did not
exist, or claim the wrong `pollOwnerId`), and its mode rule as a `unique`
index. v4 moves ballots onto the shapes the social contract's likes already
use.

| Doctype | v4 change | Serves |
| --- | --- | --- |
| `poll` | `canBeDeleted: false` | permanentDocument target; its `$ownerId` is the agreement source for `pollOwnerId` |
| `vote` | indexOnly; `pollId` refersTo poll with `{pollOwnerId: '$ownerId'}`; `byPoll` structural single ballot (preallocated); `byPollChoice` count + ranked; `byPollOwner` (preallocated); `byVoterChoice` | body-less flat-priced ballots, ghost-poll rejection, O(log n) winner, "my votes", "votes on my polls" |
| `multiVote` | the same, minus any `[pollId]`-terminating index: `byPollChoice`, `byPollOwnerChoice`, `byVoterChoice` | one entry per (poll, voter, choice) |

Ballots stay free — v4 declares no `tokenCost`. Structural uniqueness already
caps what one identity can write per poll, and a token price on voting would
make polls useless.

The client selects the topology with `NEXT_PUBLIC_POLLR_TOPOLOGY=v4`
(`POLLR_TOPOLOGY` in `lib/constants.ts`). On `v3` (the default, matching the
testnet contract) nothing changes. The two are still incompatible: a v4 ballot
carries no `$createdAt`, which v3 requires, and a v3 ballot's `pollOwnerId` is
unchecked where v4's is consensus-bound — so the switch must match the deployed
contract. (The v4 poll payload itself is now identical to v3's.)

## Single-choice is structural now

indexOnly document types **cannot declare `unique` indexes**: uniqueness is a
property of the storage, one entry per value tuple and terminal. So

```
byPoll  [pollId]  terminal $ownerId
```

*is* "one ballot per voter per poll" — the same one-entry-per-owner trap the
social side documented, here the entire point. Consensus reports a second
ballot as `duplicate unique properties ["pollId", "$ownerId"]`, so the client's
existing duplicate handling works unchanged.

The client routes that rejection by text (`isDuplicateVoteError`), and a lot
hangs off it — a duplicate misread as an ordinary error would be handed to the
landed-write probe, which finds the voter's *earlier* entry and reports the
rejected write as cast. Battery case p3b' pins the live wording against the
client's exact predicate.

`multiVote` must NOT have that index. Any index terminating at `[pollId]` with
terminal `$ownerId` would make a voter's second selection a duplicate, so
`multiVote`'s every index carries `choice`. The cost is that no index counts
*distinct voters* on a multi-choice poll — one that did would cap a voter at a
single selection. v3 had the same limitation.

## Whose poll it is, settled by consensus

Every ballot must carry the poll's own `$ownerId` in `pollOwnerId`:

```
the document's pollOwnerId does not agree with the referenced document's
$ownerId (propertyAgreement on pollId)                            [40127]
```

`$ownerId` is assigned from the signature, so "votes on my polls"
(`byPollOwner`) cannot be filed under anyone but the real creator, and the
client simply sends `poll.ownerId`. On beta.1 the agreement could only name a
user property, so the poll carried an attested `author`; a poll naming someone
else was accepted (old battery case p1d) and `castVote` had to refuse to vote
on one. Both are gone.

## No `$createdAt` anywhere

v4 keeps no time index on ballots, so `$createdAt` stays out of `required` and
is never assigned. Two consequences:

- **Unvote is one hop.** An indexOnly delete must reproduce the whole value
  tuple; social-contract likes need the consensus `$createdAt` recovered from a
  time-carrying index projection first. A v4 ballot's tuple is just
  `{pollId, choice, pollOwnerId}` — `choice` off the `byPollChoice` projection,
  `pollOwnerId` off the referenced poll's `$ownerId`. (An indexOnly projection
  only carries what its own index path holds, which is why `pollOwnerId` is not
  in it.)
- **No vote history.** "Recent votes", "trending polls today" and v3's
  `pollVotesByTime` scan are gone. The tally scan fallback walks
  `byPollChoice` instead.

## Query shapes that serve, verified live

```js
// Per-option tally (unchanged from v3 — both topologies count [pollId, choice]).
// Keys are the hex of 0x80 + choice.
sdk.documents.count({ dataContractId, documentTypeName: 'vote',
  where: [['pollId', '==', P], ['choice', 'in', [0, 1, 2]]], groupBy: ['choice'] })

// Winning option in O(log n). Ranked pages hand integer group values back DECODED.
sdk.documents.ranked({ dataContractId, documentTypeName: 'vote',
  groupBy: 'choice', aggregate: { type: 'count' }, where: [['pollId', '==', P]], limit: 1 })

// Did this voter cast this exact choice? (the indexOnly write-confirmation probe)
sdk.documents.query({ dataContractId, documentTypeName: 'vote',
  where: [['pollId', '==', P], ['choice', '==', C], ['$ownerId', '==', me]], limit: 1 })

// My choices on one poll. An `in` on an indexOnly PREFIX property REQUIRES the
// matching orderBy — without it the query is refused outright.
sdk.documents.query({ dataContractId, documentTypeName: 'multiVote',
  where: [['pollId', '==', P], ['choice', 'in', [0, 1, 2]], ['$ownerId', '==', me]],
  orderBy: [['choice', 'asc']] })

// Every poll I have voted in, with the choice (byVoterChoice).
sdk.documents.query({ dataContractId, documentTypeName: 'vote', where: [['$ownerId', '==', me]] })

// Votes on my polls (byPollOwner / byPollOwnerChoice).
sdk.documents.query({ dataContractId, documentTypeName: 'vote', where: [['pollOwnerId', '==', me]] })
```

## Registration gotchas found on the way

1. **`preallocated` cannot cover `[pollId, choice]`.** The flag promises the
   whole index path is a pure function of one referenced document, so every
   index property must be the refersTo property itself or a `propertyAgreement`
   key (rs-dpp `index::preallocation`). `choice` is neither. Preallocation
   therefore lands on `vote.byPoll` and `vote.byPollOwner` only — and on
   `multiVote`, which has no `choice`-free index, on nothing at all. Measured
   effect: a v4 poll create costs ~18M credits more than the same poll on the
   v3 clone (battery p7).
2. **A ranked index's prefix may not also terminate an aggregating index.**
   `byPollChoice` is `rankedCountable` with prefix `[pollId]`, and `vote.byPoll`
   terminates at exactly that level — legal *only* because `byPoll` is plain.
   Putting `countable` on `byPoll` to get a voter count would be refused at
   registration.
3. **`rangeCountable` does not give you a prefix count.** A bare
   `count where pollId == P` is refused on both doctypes: the boolean
   `rankedCountable` puts the count tree at the `choice` level, and the
   `pollId` level is a plain grouping tree. Social v5 gets prefix counts from
   the `rankedCountable: {at: […]}` form, which `vote` cannot use (rule 2 —
   `byPoll` terminates at the `at` level). The client sums the grouped tally,
   which it needs for the bars anyway.
4. **`rankedCountable` needs `rangeCountable` spelled out** — the sugar is not
   expanded before the dependency check, so the offline validator accepts what
   registration refuses (dashpay/platform#4809). `countable` is the exception
   since beta.2: `rangeCountable: true` implies it in the meta-schema and in the
   structural parser alike.
5. **A terminal must be `$ownerId` or a refersTo identifier.** `choice` is an
   integer, so no index can be keyed (poll, voter) → choice; "my choices on a
   poll" is the `choice in [...]` walk above rather than a direct lookup.

## Confirming an indexOnly write

`documents.get` cannot confirm a v4 ballot — there is no row under the id — so
`stateTransitionService.createDocument` runs in `confirmation: 'affectedState'`
mode and its own landed-check (a get-by-id) always comes back empty. That means
its timeout branch returns `{success: true, confirmed: false}` on every DAPI
504, whether or not the transition was later rejected. `castVote` therefore
treats an **unconfirmed** success the same way it treats a reported failure: it
polls the entry probe (`pollId ==`, `choice ==`, `$ownerId ==`, four tries at
2.5s, matching `like-service`) and classifies on what the chain shows. A
single-choice ballot is one-shot and non-repeatable, so reporting an
unverified one as cast would close the ballot on a vote that never landed.

The tally's last-resort path has the mirror-image constraint: `paginateFetchAll`
cursors on the last document's `$id`, and an indexOnly type's synthesized ids
address nothing, so v4 keyset-walks the terminal instead
(`countByChoiceKeyset`) — prefix equality, then `$ownerId > last` with the
matching orderBy, page one omitting both. When no cursor can be recovered the
whole path fails rather than returning a truncated tally, because percentages
over a knowingly wrong total are worse than an error with a retry.

## Not in v4

- Trending polls / windowed vote counts (would need a `timeRange` index, and
  therefore `$createdAt` back in `required`).
- Distinct-voter counts on multi-choice polls (see above).
- A retract-vote UI. Delete-by-values works and the battery proves it (p8), but
  the poll card has no retract action, so no client path was added.
- A UI surface for the winner. `pollrVoteService.getWinner` implements the
  ranked query and the battery proves it, but the poll card already holds the
  full tally, so nothing calls it yet; it is there for a future "winner" or
  leaderboard surface that does not want to page every option.
- Consensus-enforced `endsAt`. Still advisory; clients refuse late ballots.
- `immutable` lists anywhere. `poll` is already `documentsMutable: false` and
  the ballots are indexOnly, so every property on this contract is frozen
  already; the keyword is only allowed on a mutable doctype.
