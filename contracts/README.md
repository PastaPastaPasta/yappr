# Yappr data contracts

The JSONs here are authored schemas, not a claim that each file is deployed.
The clean-start testnet release (social v17, blog v9, storefront v10, pollr v8
and DM v5, behind an App Connect anchor and group) was registered on
2026-10-21. The owner then abandoned its social, blog and storefront for
"hide, don't delete" (D42–D44, [SOCIAL_V18.md](../docs/SOCIAL_V18.md)):
**social v18, blog v10 and storefront v11** join the same group as new
members, and the three abandoned ones stay in it, unused. `.env.testnet` pins
the registered set until the activation PR moves it to v18; `/staging` builds
from it now and root after the staging→master merge. Until then master's root
still uses social v2. `.env.devnet` selects Sakura social v16, blog v8,
storefront v9, pollr v7 and DM v5.

Registration ids and pinned member versions come from `.env.testnet` and the
[release record](../docs/TESTNET_RELEASE.md#production-registration-record-2026-10-21).
Posting stays closed until the elected moderation teams are seated.

## Planned release set

[`scripts/app-connect-set.mjs`](../scripts/app-connect-set.mjs) owns the
registration order and complete SHA-256 pins. Hashes below are the source-file
hashes at this revision; the publisher also verifies them before rendering
network-specific moderation configuration.

| Role | Source file | SHA-256 |
| --- | --- | --- |
| app | [yappr-app-contract.json](yappr-app-contract.json) | `d3acd888168f6ee074d2eb7f73442917b255aa0be3b6417698d637844ce41f41` |
| social | [yappr-social-contract-v17.json](yappr-social-contract-v17.json) | `77cf4308d40d916ce9f128e84f584344b57e3525c30d4d20509bf3a4485196bf` |
| blocks | [yappr-blocks-contract.json](yappr-blocks-contract.json) | `ba0ef67a458cae5c702612a096a6b71fb0098fa370b3861da6da735dd80d3677` |
| dmV5 | [yappr-dm-contract-v5.json](yappr-dm-contract-v5.json) | `4fe2b3f46447d8aff30efcafc0e6235bee97724e34e7c96130951a59b0037c21` |
| blog | [yappr-blog-contract.json](yappr-blog-contract.json) | `448fb9ea4a9b6b4f4c0e0224dfe5ba610514d18793b6927255f3a7c67631504c` |
| pollr | [pollr-contract.json](pollr-contract.json) | `a77afe5f27ad97d80e530551bbd5561ab02b1c622698b1a583a4893b03bd2347` |
| storefront | [yappr-storefront-contract.json](yappr-storefront-contract.json) | `69daf9799cb4f34552e4fce3ec7963a66f6f492f37d45baee4f6c83880bf05dc` |
| passkeyVault | [yappr-passkey-vault-contract.json](yappr-passkey-vault-contract.json) | `14094cadcaf6c9b575fcb97ea53b769c5b0d88cfa99b3c5c827da0ab176f73c5` |
| socialV18 | [yappr-social-contract-v18.json](yappr-social-contract-v18.json) | `71e4d4b3353965cf343448e254150d0a4ff183a17384d53c437b4c6eefb6604d` |
| blogV10 | [yappr-blog-contract-v10.json](yappr-blog-contract-v10.json) | `8a169b979ff6e138035ff7aabc0e226b626d59ae64d5edfffddc44cc617d4159` |
| storefrontV11 | [yappr-storefront-contract-v11.json](yappr-storefront-contract-v11.json) | `645a51a475a33794d713e23d9b27fd9a54531920e61c37e8e34c74b46f70b167` |

The first eight rows are registered on testnet. `social`, `blog` and
`storefront` (v17, v9, v10) are replaced members: they keep their files and
pins so the set stays reproducible, but no variable names them and no charter
is filed on them. The last three are the "hide, don't delete" members,
appended with `register-app-connect-contracts --append-after passkeyVault`.

The password-era vault is not a release member.

- [Social v18, blog v10 and storefront v11](../docs/SOCIAL_V18.md): no moderator
  delete, the `mod` lane in every listing, the moderation logs, restriction
  instead of bans, and the archive and log queries.
- [Social v17](../docs/SOCIAL_V17.md): the registered, abandoned cut, and the
  rules v18 keeps.
- [Blog v9](../docs/BLOG_V9.md), [storefront v10](../docs/STOREFRONT_V10.md),
  [DM v5](../docs/DM_V5.md), and [non-social reference](../docs/NON_SOCIAL_CONTRACTS.md).
- [App Connect](../docs/APP_CONNECT_CONTRACTS.md): anchor, group, registration
  prerequisites, `id:version` pins and validation.

The elected social, blog and storefront contracts render `notYetUsable` for
testnet; the election windows and delay are registration flags (the v17
members took 86400 s each; v18's are the owner's call). Moderated writes open
only after teams are seated. Mainnet has a one-day window floor. Release YAPP
has no manual authorities: its only supply is the 100-YAPP identity claim.

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
node scripts/validate-contract-offline.mjs contracts/yappr-social-contract-v18.json --network testnet --strict-size
node scripts/validate-contract-offline.mjs --probes
node scripts/validate-contract-offline.mjs --constraints
node scripts/verify-appconnect.mjs --self-test
node scripts/verify-v10.mjs --self-test
```

These checks are offline. Registration and live batteries require the release
runbook's network, maker, interim and signing controls. Do not publish a
standalone replacement for an App Connect member.
