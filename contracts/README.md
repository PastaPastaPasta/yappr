# Yappr data contracts

The JSONs here are authored schemas, not a claim that each file is deployed.
The current production default still uses social v2; `.env.devnet` selects
Sakura social v16, blog v8, storefront v9, pollr v7 and DM v5. The planned
clean-start testnet release selects social v17, blog v9, storefront v10,
pollr v8 and DM v5, behind an App Connect anchor and group.

Registration ids and pinned member versions come from the deployment env and
[release record](../docs/TESTNET_RELEASE.md). Until WP14/WP15 record registration
and cut over configuration, do not describe the release set as live.

## Planned release set

[`scripts/app-connect-set.mjs`](../scripts/app-connect-set.mjs) owns the
registration order and complete SHA-256 pins. Hashes below are the source-file
hashes at this revision; the publisher also verifies them before rendering
network-specific moderation configuration.

| Role | Source file | SHA-256 |
| --- | --- | --- |
| app | [yappr-app-contract.json](yappr-app-contract.json) | `d3acd888168f6ee074d2eb7f73442917b255aa0be3b6417698d637844ce41f41` |
| social | [yappr-social-contract-v17.json](yappr-social-contract-v17.json) | `ae4d3e7d38855bdfa1cebe5bc76c3ecf8f19cf344622c694f63c124c20d23c49` |
| blocks | [yappr-blocks-contract.json](yappr-blocks-contract.json) | `ba0ef67a458cae5c702612a096a6b71fb0098fa370b3861da6da735dd80d3677` |
| dmV5 | [yappr-dm-contract-v5.json](yappr-dm-contract-v5.json) | `4fe2b3f46447d8aff30efcafc0e6235bee97724e34e7c96130951a59b0037c21` |
| blog | [yappr-blog-contract.json](yappr-blog-contract.json) | `6f8b07e090768179442b8026c86b478e15adc15e5d469e2c1f759a57acea0b8a` |
| pollr | [pollr-contract.json](pollr-contract.json) | `a77afe5f27ad97d80e530551bbd5561ab02b1c622698b1a583a4893b03bd2347` |
| storefront | [yappr-storefront-contract.json](yappr-storefront-contract.json) | `581122bbf27b76ed014c2695e6c84d4dc14a9712c9c6fb97f9f3614a4455bdca` |

The passkey vault is implemented and registered by its own work package (PR
[#786](https://github.com/PastaPastaPasta/yappr/pull/786)); its current code and
schema are deliberately outside this cleanup. The password-era vault is not
a release member. Consult the set manifest again after that PR lands.

- [Social v17](../docs/SOCIAL_V17.md): release rules and live indexes.
- [Blog v9](../docs/BLOG_V9.md), [storefront v10](../docs/STOREFRONT_V10.md),
  [DM v5](../docs/DM_V5.md), and [non-social reference](../docs/NON_SOCIAL_CONTRACTS.md).
- [App Connect](../docs/APP_CONNECT_CONTRACTS.md): anchor, group, registration
  prerequisites, `id:version` pins and validation.

The elected social, blog and storefront contracts render `notYetUsable` for
testnet with 3600-second join/vote windows. Moderated writes open only after
teams are seated. Mainnet has different minimum windows. Release YAPP has
no manual authorities: its only supply is the 100-YAPP identity claim.

## Files retained until cut-over

- `yappr-social-contract-v2.json` and `yappr-profile-contract.json` support the
  current production defaults. Social v9–v15 still have client/test/tool
  references, while v16 is required by `/devnet`; age alone is not a deletion
  criterion.
- `yappr-dm-contract.json` is the old v4 authored shape; production still uses
  its existing v3 deployment. The release registers neither a legacy DM
  contract nor a migration reader.
- `key-exchange-v2.json`, `yappr-vault-contract.json`,
  `encrypted-key-backup-contract.json` and `yappr-auth-vault-contract.json`
  remain referenced by the retired-contract manifest or existing deployment
  tooling. None is registered for the release (D9/D10).
- Four unreferenced early standalone/scratch JSONs were removed in WP17.
  The current blocks file is **plural**, `yappr-blocks-contract.json`.

[RELEASE_CLEANUP.md](../docs/RELEASE_CLEANUP.md) records the safe removals and
production-dependent deferrals. Historical grammar experiments and deployment
records are in [docs/archive](../docs/archive/README.md); recover deleted
batteries and scratch schemas from git history.

## Validate before registering

```sh
node scripts/validate-contract-offline.mjs contracts/yappr-social-contract-v17.json --network testnet --strict-size
node scripts/verify-appconnect.mjs --self-test
node scripts/verify-v10.mjs --self-test
```

These checks are offline. Registration and live batteries require the release
runbook's network, maker, interim and signing controls. Do not publish a
standalone replacement for an App Connect member.
