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

Local lint, production build and dead-code checks pass. The full unit suite
passes 236 files / 3,422 tests. Offline social/seed checks cover both v16 and
v17; each seeder self-test reports 98 PASS / 0 FAIL. Social-shape tests report
595 PASS / 0 FAIL, and App Connect self-tests report 30 PASS / 0 FAIL.

Live results and cleanup evidence are recorded below after each full run.
