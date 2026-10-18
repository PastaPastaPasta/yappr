# Release-cut battery rehearsal

Sakura devnet, Platform protocol version 14, 2026-10-17. These are throwaway
contracts registered by seed persona 63, not the devnet maker. The published
`/devnet` contract set was not rewired.

| Contract | Cut | Throwaway ID |
| --- | --- | --- |
| Social | v17 | `C7dekFJE2inDet6YybjZ8RDLUYj8KRxj39Zs7YaGtg6w` |
| Blog | amended v9 (PR #792) | `GMDGphpxsC6AucUxWmD6piYV43o2CDefmYeWTfRJzLxh` |
| Storefront | v10 | `D9hakoJZadyFKKvTiSfAdY8ietNV7Bc6mnu2YrC17BFB` |
| Pollr | v8 | `JBGmaZ1FCpgBBJaGLdUjZFm8YjNwA4BRAX6ySijq7fRv` |

The amended blog copy matches the release JSON after staging PR #792 (SHA256
`a03012221e543b850d7524b27148e6b9c2b84fae3a0c291426e22de30d6dccef`).
The original v9 rehearsal used `AHxeMag66mxfzaWDcBqsr43FpsXGVXxjeanQ8NLb6Dvt`;
its historical results are retained below. Cleanup detects the deployed owner
indexes and whether an orphan tombstone may omit `blogId`, preserving the
original v9 and older cuts as well as the amended release.

Pollr uses its reusable test-contract registry. Ballots cannot be deleted, so
balloted polls remain confined to that copy. The merged-count proof registers
its own copy with token fees removed and shortened moderation/trend windows;
it is an index-layout proof, not a token-fee rehearsal.

The shared Sakura DAPI gateway advertises a per-IP allowance of 150 requests
per minute per node. Initial runs hit `grpc-status: 8`,
`x-envoy-ratelimited: true`, and `ratelimit-remaining: 0`, including on proved
reads. Those transport failures are not contract refusals. Final runs use a
local transport wrapper that paces DAPI calls and honors Envoy's reset header
before replaying an explicitly refused request. It leaves consensus refusals
unchanged. The wrapper and local identities/configuration are not committed.

## Adaptations

- Derive timeline, tag, author, reply and blog read shapes from the target cut;
  include the release live pins and exclude tombstones where required.
- Claim each actor's own starter grant. Detect disabled minting on chain and
  use credit payment for seeder work beyond the available grant. Provisioning
  reads the deployed grant amount and does not trust a marker for another cut.
- Exercise numbered `privateFeed` grants/rekeys and private post/reply rules
  directly against the contract; keep the legacy shape on earlier cuts.
- Refuse server-side blog drafts without `publishedAt`; publish a new document
  and set `live` on published release posts.
- Use paired sealed storefront status payloads and nonces. An independent test
  opens seeder ciphertext with both app participant keys.
- Track poll IDs for no-index poll cleanup and retain the reusable test-contract
  pattern. Cleanup refuses undiscoverable scope instead of silently succeeding.
- Exercise self-like refusals without storing index-only helper documents.
  Broad rejection checks cannot score a transient rate limit as enforcement.

## Validation

Local lint, standalone TypeScript checking, production build and dead-code checks pass. The full unit suite
passes 239 files / 3,497 tests after merging staging elections/blog amendments and the
review regressions. Offline social/seed checks cover both v16 and
v17; each seeder self-test reports 98 PASS / 0 FAIL. Social-shape tests report
595 PASS / 0 FAIL, and App Connect self-tests report 30 PASS / 0 FAIL.
The amended blog battery self-test passes 26 checks plus its moderation-rule declarations.
Opus r14/r15 approved the final blog topology and Pollr refusal changes; Sonnet r3
found no required simplifications. Pollr p2b/p2c require positive evidence of
`/choices` minItems/uniqueItems validation (DPP schema error or AJV client
validation), with 10 regression tests rejecting cache/confirmation ambiguity,
wrong fields and the other rule. The targeted suite passes 51/51. The focused
Sakura p1+p2 replay passed 9/0 using those stricter assertions: both schema
refusals were code10101 on `/choices` with their exact condition text. Cleanup
removed three unballoted polls; the closing poll and its immutable ballot
remain on the reusable throwaway. Two explicit Envoy resets were honored.

Live results and cleanup evidence are recorded below after each full run.
The query-bundle run used nonempty social pages (20 posts and one reply);
blog pages were empty after the blog battery cleaned them. The legacy DM v4
bundle is explicitly skipped because no DM v4 contract exists on this chain.

| Battery | PASS | FAIL | Scope |
| --- | ---: | ---: | --- |
| `verify-v10` full | 407 | 0 | Social v17; persona 63 moderator; fresh bot 3 |
| `verify-blog` full, original v9 rerun | 104 | 0 | Original blog v9; personas 60/61/62, moderator 63 |
| `verify-blog` full, amended v9 corrected runner | 105 | 1 | b8 quorum-key read abort; exact failure below |
| Amended blog b1+b8 isolated replay | 15 | 0 | Fresh fixtures; all owner-deletion/orphan-retraction cases |
| Original-v9 b19+b22 topology replay | 19 | 0 | Required blogId schema10101 and original-v9 live/tombstone constraints |
| Amended-v9 b19 strict constraint replay | 9 | 0 | Missing blog remains exact hasBody10422; fixture blog removed |
| `verify-storefront` full | 164 | 0 | Storefront v10; personas 80/81/82, moderator 63 |
| `verify-pollr` full | 77 | 0 | Reusable pollr v8 test contract; personas 63/83/84 |
| Pollr p1+p2 strict schema replay | 9 | 0 | Positive minItems/uniqueItems evidence, same reusable copy |
| `verify-dm-v5` full | 107 | 0 | Published DM v5 plus bot-2-owned layout variants |
| `verify-tips` full | 6 | 0 | Isolated credit-tip personas 85/86 |
| App Connect self-tests | 30 | 0 | Offline contract/derivation checks |
| `prove-merged-counts` full, final rerun | 174 | 0 | v17 layout copy; initial 173/1 timing failure below retained |
| Focused retention reproof | 10 | 0 | Same layout copy, refreshed fixture; cleanup included |
| Removed-blog comment cleanup regression | 8 | 0 | Blog v9; removed parent blog and tombstoned target post |
| Unpriced poll seeder smoke | 4 | 0 | Pollr v8; shared seeder writer, read by ID and delete |
| Lost-confirmation nonce-cache recovery | 6 | 0 | Pollr v8; actual SDK facade primed before manual create; both polls removed |
| Social query bundles | 10 | 0 | Release social and blog read shapes; legacy DM v4 absent |

Completed logs, including diagnostic attempts, are retained locally in
`~/.local/share/yappr-release-audit-20261016/batteries-v17-logs/`.

The merged-count copy deliberately retains its settled targets for a later
`--team-proof` rehearsal; its state file is
`~/.local/share/yappr-release-audit-20261016/battery-pmc-v17-state.json`.
The final full-run copy is `84e8dgZ9HAP2S8bTVEqUFFq8ATNfRxjSjdoLN3CfMMDm`,
registered by persona 64. The original copy and its state are preserved
separately as diagnostics.
DM v5 ran on `BnKea2J8BSF4CxK9eJGKVYu9pv9NQK58LyfkEHxmKQiJ`.
Its layout copies were registered by bot 2, not the devnet maker:

| DM layout | Contract ID |
| --- | --- |
| Unique tag | `2MzJesjWPLZDiCq2xJs3RMPv1BjZoNJYWcTg6ysZYXo9` |
| Non-unique tag | `C8hE3KBCFb6tjPM1m2yNditWQ1oUK2NiVeMMmwttRtEe` |
| Unique tag and owner | `8nvR5u1B5ziHg7zNpsAAFw4u9EjBiBBzuXhzA87VGYLV` |

Seven interleaved samples per layout gave median 156-byte message costs of
25,179,720 / 29,918,000 / 33,488,800 credits respectively. Both comparison
assertions passed. Immutable randomized encrypted invites and group documents
remain by contract design. The battery's sweep/self-state delete probes also
passed. Final ID-scoped cleanup checked 53 run-created message/self-state IDs:
51 were removed, 2 were already absent, and no deletions failed.

Permanent private-feed records/rekeys, moderation records and balloted polls
are confined to throwaway contracts. Topology-specific probes of fields absent
from the selected cut are logged as skips, not passes.
Social `r2` is also skipped because no charter is seated on the throwaway:
interim-owner moderation is covered, while seated-team report resolution and
the proof's optional `--team-proof` phase need a later governance rehearsal.

Social cleanup tombstoned all 61 live documents found in the rehearsal window
(bot 0: 20 posts / 10 replies; bot 1: 23 posts / 8 replies), with zero failed
removals and zero incomplete identity reads. The full battery deliberately kept
its fixtures until query-bundle verification finished.

Storefront cleanup removed 2 item reviews, 1 store review, 1 deliverable and
5 shipping zones; marked 10 items deleted; and closed 2 stores. The contract's
5 permanent encrypted orders, 2 status updates and 2 deliveries remain on the
throwaway copy. Cleanup reported no failed removals.

A separate live cleanup regression created a reader comment on an author post,
tombstoned that post, then moderator-removed its blog. Cleanup scoped only to
the reader found and deleted the comment through the permanent comment index;
a read by ID confirmed removal. Its final fixture cleanup found no remaining
actions. All eight checks passed.

The final original-v9 b19+b22 replay passed 19/0, including the specific
missing-`blogId` schema refusal 10101 and frozen-publishedAt/tombstone checks;
cleanup removed its one blog with no failed actions. The amended-v9 b19
replay passed 9/0 with the exact missing-blog `hasBody` refusal 10422 and
removed its one fixture blog. Its transport honored four explicit Envoy resets. Offline schema-profile
checks cover v8 (no `live`, optional `publishedAt`), original v9 (required
`blogId`) and amended v9 (optional orphan reference with live `hasBody`).

Both original-v9 full blog runs removed their 6 comments, 1 follow, 7 live posts (by
tombstone) and 3 blogs (by moderator removal), with no failed cleanup actions.

The first amended-v9 run deleted 6 comments, 1 follow and 3 blogs and
tombstoned 8 remaining live posts. The corrected full run deleted 6 comments,
1 follow and 4 blogs and tombstoned 8 live posts, including the interrupted
b8 fixture scope. Both cleanups reported no failed actions. The focused b1+b8
replay deleted 3 comments, 2 follows and 1 blog and tombstoned 2 posts, also
without failures. The first run also deleted and retracted its separate b8
blog/post inside that case.

Tips ran all six applicable credit-transfer checks. Its t1–t5 YAPP-transfer
cases explicitly skip the release token, whose transfers are locked; document
action-fee payments in YAPP are covered by the social battery, including the
one-token like payment and sponsored gas.

## Timing failure retained from the rehearsal

The first full merged-count run on
`9d32tyKeyN6YZYgDxXZhSYT6M7r4NVgDqugRkEmN1x5b` failed `ol-h1`:
T2's permanent count was zero, its viewer heart was off, and it was absent
from profile Top as expected, but the oldest trend window no longer contained
T2. This copy uses 360-second post windows, not the release's three-day windows.
The earlier query probes, tag-window wait and explicit DAPI reset waits had
aged the original T2 like out before the retention check. The later `ol-h4`
re-like appeared in the trend window at count one; `ol-x1`, `ol-x2` and
`ol-x3` also passed their expiry/permanent-index checks.

The harness now deletes and recreates T2's like immediately before `ol-h0` /
`ol-h1`, so this retention check starts with a fresh window entry. The original
failed assertion remains in the original 173/1 transcript. The complete rerun
on `84e8dgZ9HAP2S8bTVEqUFFq8ATNfRxjSjdoLN3CfMMDm` passed 174/0,
including the later expiry and settling phases. No contract rule or expected
retention result was relaxed.

The focused live reproof on the same copy passed 10 checks, including both
`ol-h1` (count 0, heart off, profile Top 0, retained trend count 1) and `ol-h4`
(count 1, heart on, profile Top 1, trend count 1). It removed its like and
tombstoned its post. It used the same SDK-facade create/delete path as
`proveOutlives` and isolated personas 85/86.

The first blog run completed 103 PASS / 1 FAIL and cleaned all its fixtures.
`b22a` expected immutable-field refusal 40128 when a tombstone omitted
`publishedAt`; blog v9 requires that field, so schema validation correctly
refused it first with 10101 (`JsonSchemaError: "publishedAt" is a required
property`). The harness now requires that specific missing-field error on
published-only contracts and retains 40128 on older contracts. The full rerun
is reported in the final table.

The first full run on amended blog v9 completed 108 PASS / 1 FAIL and exposed
a battery fixture bug in b19:
`live post requires a blog` deliberately omitted `blogId`, but the live runner
unconditionally restored it while substituting the fixture reference. The
valid post was accepted and the strict refusal assertion failed. Fixture
binding now substitutes only a reference already present in the case; two
self-test checks preserve omission and verify ordinary reference binding.
The expected `hasBody` refusal remains unchanged and passed live with code
10422 on the corrected run. The original transcript is
retained alongside the corrected full rerun; this was not a contract failure.

## Amended-blog quorum read failure

The corrected full amended-v9 run completed 105 PASS / 1 FAIL. b8 passed its
permanent-post delete refusal and created the separate deletable blog, then
aborted before the post-create probe completed. A proved read within that
probe exhausted four reconnect attempts with:

```
quorum key unavailable for quorum 107:562a103d43a312726a6041238fc9be892aa2d014b86cdadeeb63892729d39ac8
invalid quorum: Quorum not found in cache
```

This is a proof/quorum-resolution failure, not a consensus refusal. b8c-f
have no verdict in this run; a failed read does not establish whether the
create landed. Cleanup covered the complete actor/time scope. Later probes
reconnected and proceeded;
the corrected b19 missing-blog probe received the exact `hasBody` refusal
10422. The preceding amended full run passed all six b8 assertions but had the
separate b19 harness failure described above. The full-run failure is retained
rather than combined with another run to report an all-green full result.
A separate b1+b8 replay on fresh fixtures passed 15/0, including every b8
assertion. Its transport honored five explicit Envoy reset refusals.

## Review regressions

Broad refusal checks now reject confirmation timeouts and quorum failures,
as well as rate limits. An explicit consensus code or schema error inside the
SDK's generic confirmation-wait wrapper still establishes a contract refusal.
Unpriced poll seeder writes retain their derived IDs before broadcast so a
lost confirmation can be reconciled without a listing index or duplicate
create. Poll checkpoints persist these IDs atomically before broadcast in a
separate pending map. A fresh writer and recorder reconcile pending IDs before
creating anything; an unreadable pending write blocks another send. Confirmed
writes move to the confirmed map, while explicit consensus refusals clear the
rejected candidate. Eight regression tests cover restart recovery, unresolved
IDs, schema/fee refusals, ambiguous nonce-used errors, local signing failure and checkpoint-save
failure without leaking an unsent ID into a later save, plus preservation of
the original broadcast error when cache invalidation fails. Local signing finishes
before the checkpoint callback; broadcasting starts only after the atomic save. Signer-only DM seed actors retain their existing facade path.
Battery cleanup also retains pre-broadcast candidate IDs when all acceptance
reads fail; its regression makes a no-index poll visible only before cleanup
and confirms it is deleted without changing the failed create verdict.
Blog cleanup scans the permanent comment index directly, so removing a blog
and tombstoning all its posts cannot hide a reader's deletable comments.
The transport, unpriced no-index lost-confirmation and signer-only paths have
offline regression coverage; removed-blog discovery also has the live 8/0
proof above. A live smoke test of the shared seeder writer also created an
unpriced poll on the no-index v8 copy, read it by the returned ID, then
deleted it in a fresh cleanup session and confirmed absence: 4/0. The lost-
confirmation branch is deliberately injected only in the offline regression.

Manual creates now invalidate the facade nonce cache in a best-effort
`finally` after every attempted broadcast, including confirmation timeouts.
The original broadcast error is preserved if invalidation also fails. The
unit regression primes a simulated facade cache, recovers a landed manual
create after a timeout, then edits through the facade with a fresh nonce.
A separate live regression used persona 83 and the same pollr v8 copy: actual
facade create/delete primed the cache, a manual create completed on chain but
its wrapper injected a 504, readback recovered its ID, and the next facade
delete succeeded. All six checks passed, and a fresh SDK cleanup confirmed
both regression polls were already absent. This proves the formerly skipped
invalidation path; it does not claim to fix the separate diagnostic below.

## SDK follow-up

An auxiliary retention probe using `@dashevo/evo-sdk` and `@dashevo/wasm-sdk`
5.0.0-rc.3 exposed a mixed-write nonce-cache issue: a
hand-built index-only like create, SDK-facade unlike, hand-built recreate,
then SDK-facade unlike attempted nonce 3 after nonce 3 had already landed.
The second unlike was refused with `nonce already present at tip`;
`refreshIdentityNonce` after the manual create did not prevent it. This is
separate from contract retention. The auxiliary probe also needed to normalize
string-valued ranking keys before comparing identifiers. Its three failed
checks are preserved in the local diagnostic log, not counted as a full
battery run. The full merged-count battery uses facade writes consistently;
the corrected focused probe follows that path and passes. SDK support for
mixing manual document batches with cached facade writes remains a follow-up.
