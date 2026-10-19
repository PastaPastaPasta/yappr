# Non-social contracts: current deployments and release cut

The checked-in JSONs describe the **planned testnet release**, not every
contract currently deployed. Platform SDK packages pin 5.0.0-rc.3 (PV14).
The existing production default still uses its older testnet contracts;
Sakura `/devnet` stays on beta.6 until release cut-over. Contract ids and pins
are deployment-specific: use `.env.devnet` for Sakura, `lib/constants.ts`
for today's defaults, and [TESTNET_RELEASE.md](TESTNET_RELEASE.md) for the
registration and configuration gates. Do not infer registration from a file's name.

| Feature | Production default today | `/devnet` (`.env.devnet`) | Planned release | Schema / reference |
| --- | --- | --- | --- | --- |
| Storefront | v1 | v9 (v8 contract updated in place, version 2) | v10 | `contracts/yappr-storefront-contract.json`; [v10](STOREFRONT_V10.md), [devnet v9](STOREFRONT_V9.md) |
| Blog | v1 topology (legacy deployment) | v8 | v9 | `contracts/yappr-blog-contract.json`; [v9](BLOG_V9.md) |
| Direct messages | v3 | v5 | v5 | `contracts/yappr-dm-contract-v5.json`; [DM v5](DM_V5.md) |
| Polls | v3 | v7 | v8 | `contracts/pollr-contract.json`; no poll-list indexes on the release cut |
| YAPP tips / purchases | Available on social v2 | Locked on social v16 | Locked on social v17 | No separate tip contract; release supply is the once-per-identity grant |

Full ids are deliberately kept in the deployment environment and the release
record rather than duplicated here. The historical schema evolution, old ids,
fee experiments and prior battery results are in the
[pre-release reference](archive/NON_SOCIAL_CONTRACTS_PRE_RELEASE.md).

## Storefront

The release's v10 supports stores, items, shipping zones, encrypted orders,
status updates and deliveries, reviews, saved addresses, digital goods and
reports. An item's `shippingZoneIds` limits which of its store's zones apply.
`storeItem.storeStatusAndTime [storeId, status, $createdAt]` lists active stock
without scanning inactive items. Status notes, tracking numbers and carriers
are sealed to the order; item images accept https/IPFS URLs only.

Store, item and review removals use the storefront's own elected team, with
reports available on v10. Social and blog moderator powers do not carry over.
The testnet release registers a `notYetUsable` interim: moderated writes wait
for a seated team. [DIGITAL_PRODUCTS.md](DIGITAL_PRODUCTS.md) documents delivery
and takedown behavior; [STOREFRONT_V10.md](STOREFRONT_V10.md) records the full cut.

## Blog

Blog v9 supports blogs, posts, comments, follows and reports. `live` markers
keep tombstones out of post listings, and `publishedAt` is required (drafts
stay local). The blog's author can delete the blog; posts remain stored but
leave public discovery. **My posts** keeps the author's retraction path
available without the parent. References to the blog are `deletableDocument`.

Posts and comments use a one-day moderation window (D39), followed by the settled
leader/three-approvals rule. The blog has its own elected team, independent of
social and storefront. See [BLOG_V9.md](BLOG_V9.md) for the exact reference rules,
owner indexes, moderation and Sakura proof. `/devnet` continues using blog v8.

## Direct messages

DM v5 is the release protocol and the current `/devnet` protocol. Its separate
contract holds unlinkable invitations, messages and encrypted self-state for
one-to-one and group conversations. See [DM_V5.md](DM_V5.md) for cryptography,
contract rules, the saved-conversation cap and key-rotation limitations.

Today's production default still selects DM v3 through `NEXT_PUBLIC_DM_TOPOLOGY`.
The legacy v3/v4 service and the v5 screen's legacy reader remain only until
every shipping build switches to v5. The release registers no DM v4 contract
and carries no old DM data forward (D9/D21/D22).

## Polls

Pollr v8 retains v7's `poll` and `vote` documents: one editable ballot per voter,
with its `choices` array. The release drops the unused `poll.byCreatedAt` and
`poll.ownerAndTime` indexes; a poll is reached from its embedding post.
`/devnet` already runs pollr v7, and polls are enabled there. A ballot must not
be interpreted using the older v5/v6 shape. Production still defaults to v3.

## Tips and YAPP

The release's YAPP is non-transferable and cannot be bought. Its only supply
is a 100-YAPP once-per-identity grant; manual mint, burn, freeze, unfreeze and
destroy-frozen-funds authorities are `noOne`. Paid social writes consume the
grant with sponsored gas. Keep purchases and token tips only while the current
production default uses transferable social v2.

Payment-URI tips stay available. Credit tips remain hidden for the release
until wallets can send them (D23). Removing the legacy YAPP-tip code and the
production token-authority fallback is coordinated with WP15, not with the
Sakura environment. See [RELEASE_CLEANUP.md](RELEASE_CLEANUP.md) for deferrals.

## Registration and validation

The release set's file hashes and nonce order live in
[`scripts/app-connect-set.mjs`](../scripts/app-connect-set.mjs); the
[App Connect runbook](APP_CONNECT_CONTRACTS.md) documents the anchor, group and
pinned members. Use the group publisher for the release, not a one-off feature
registration. Production registration, signing and testnet writes are separate
release gates in [TESTNET_RELEASE.md](TESTNET_RELEASE.md).

Offline checks do not broadcast:

```sh
node scripts/validate-contract-offline.mjs contracts/yappr-storefront-contract.json --network testnet --strict-size
node scripts/verify-storefront.mjs --self-test
node scripts/verify-blog.mjs --self-test
node scripts/verify-pollr.mjs --self-test
node scripts/verify-dm-v5.mjs --self-test
```

Sakura's beta.6 deployment record reports pollr 77/77, blog 101/101 and DM v5
106/106 from the earlier cut. Those results establish the old deployment,
not the rc.3 release battery gate. Run release batteries only against the
isolated rehearsal set and with that work package's authorisation; never
against the production set. The archived reference's “not yet run” notes are
historical, not current test status.
