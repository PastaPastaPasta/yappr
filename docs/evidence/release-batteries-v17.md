# Release-cut battery rehearsal

Sakura devnet, Platform protocol version 14, 2026-10-17. These are throwaway
contracts registered by seed persona 63, not the devnet maker. The published
`/devnet` contract set was not rewired.

| Contract | Cut | Throwaway ID |
| --- | --- | --- |
| Social | v17 | `C7dekFJE2inDet6YybjZ8RDLUYj8KRxj39Zs7YaGtg6w` |
| Blog | v9 | `AHxeMag66mxfzaWDcBqsr43FpsXGVXxjeanQ8NLb6Dvt` |
| Storefront | v10 | `D9hakoJZadyFKKvTiSfAdY8ietNV7Bc6mnu2YrC17BFB` |
| Pollr | v8 | `JBGmaZ1FCpgBBJaGLdUjZFm8YjNwA4BRAX6ySijq7fRv` |

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
passes 238 files / 3,475 tests after merging staging elections updates and the
review regressions. Offline social/seed checks cover both v16 and
v17; each seeder self-test reports 98 PASS / 0 FAIL. Social-shape tests report
595 PASS / 0 FAIL, and App Connect self-tests report 30 PASS / 0 FAIL.

Live results and cleanup evidence are recorded below after each full run.
The query-bundle run used nonempty social pages (20 posts and one reply);
blog pages were empty after the blog battery cleaned them. The legacy DM v4
bundle is explicitly skipped because no DM v4 contract exists on this chain.

| Battery | PASS | FAIL | Scope |
| --- | ---: | ---: | --- |
| `verify-v10` full | 407 | 0 | Social v17; persona 63 moderator; fresh bot 3 |
| `verify-blog` full, final rerun | 104 | 0 | Blog v9; personas 60/61/62, moderator 63 |
| `verify-storefront` full | 164 | 0 | Storefront v10; personas 80/81/82, moderator 63 |
| `verify-pollr` full | 77 | 0 | Reusable pollr v8 test contract; personas 63/83/84 |
| `verify-dm-v5` full | 107 | 0 | Published DM v5 plus bot-2-owned layout variants |
| `verify-tips` full | 6 | 0 | Isolated credit-tip personas 85/86 |
| App Connect self-tests | 30 | 0 | Offline contract/derivation checks |
| `prove-merged-counts` full, final rerun | 174 | 0 | v17 layout copy; initial 173/1 timing failure below retained |
| Focused retention reproof | 10 | 0 | Same layout copy, refreshed fixture; cleanup included |
| Removed-blog comment cleanup regression | 8 | 0 | Blog v9; removed parent blog and tombstoned target post |
| Unpriced poll seeder smoke | 4 | 0 | Pollr v8; shared seeder writer, read by ID and delete |
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

Both full blog runs removed their 6 comments, 1 follow, 7 live posts (by
tombstone) and 3 blogs (by moderator removal), with no failed cleanup actions.

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
rejected candidate. Seven regression tests cover restart recovery, unresolved
IDs, schema/fee refusals, ambiguous nonce-used errors, local signing failure and checkpoint-save
failure without leaking an unsent ID into a later save. Local signing finishes
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
