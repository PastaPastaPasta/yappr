# Testnet staging release rehearsal

This is the D36 rehearsal on Dash **testnet**, chain `dash-testnet-51`, using Platform 5.0.0-rc.4 / protocol 14. The production maker is excluded from all operations. Root, `/testing` and `/devnet` keep their existing resolved configuration. The rehearsal uses a separate maker, App Connect anchor, group and storage epoch; production registration remains an owner action after QA.

## Registered set

Maker: `At8Xd9BpbVbzxvrna2smE3GbACeTaxf7YGUEwn7FHUZF`. Group: `ePtSmVdSqxJESyegxxRGcS7CwznyWSAn2FULYow8Dks`. Every member is version 1. The proved initial maker nonce was 0; registration consumed nonces 1–8. Plan, unsigned dry run and signed dry run preceded the journaled live registration with `--interim notYetUsable --election-windows 3600,3600`.

| Member | ID | Nonce | Credits | Reference ¢ |
|---|---|---:|---:|---:|
| app | `AwjuEqZtXwBq5jU9tg8UnRMmXrwb3nozSgGx59ghD1c1` | 1 | 13,098,395,870 | 785.90 |
| social | `AbDUiaXbJML5FQGSpt5oEdx88tXK8FPRXbAt1jwK3Us9` | 2 | 91,786,311,700 | 5,507.18 |
| blocks | `8nqBhNLpschHdSfodFRfKP4xiu13KWqddoe54eXgEDcA` | 3 | 19,112,142,480 | 1,146.73 |
| dmV5 | `EoPoTVht7vkQcymBLajhbmEg62mAAxA3EUAqvB1DoxvE` | 4 | 22,184,626,110 | 1,331.08 |
| blog | `HAEBfyZP9ECiX8crakwRSdjvVDkeJKPbG8Zs4YaRQrRa` | 5 | 38,427,571,200 | 2,305.65 |
| pollr | `BFSLhfSc5yzoKg1iCymw37kZusNkMVk2K48qPEsdvd6Q` | 6 | 17,161,715,480 | 1,029.70 |
| storefront | `9Z5W23rzbMdwPBEn9e5pKKz6rmRVAkoCYDTWaqzLpWqS` | 7 | 60,740,381,750 | 3,644.42 |
| passkeyVault | `7yVNQ35szs8ZvsYAwBd8o3QGj1zuMN1EkQbgDtdw9M3U` | 8 | 13,085,824,250 | 785.15 |

Total registration: **275,596,968,840 credits (16,535.82¢)**. Reference conversion throughout is 1M credits ≈ 0.06¢. Maker identity registration cost 133,806,160 credits (8.03¢). Funding principal and charter deposits are accounted separately from fees.

The protected signed journals retain exact transition hashes and verification times. Exact transaction inclusion heights are being reconciled separately; an observed chain tip is not labeled an inclusion height. The public testnet explorer backend returned HTTP 503 during this run, and the old official explorer hostname no longer resolves.

## Elections and batteries

Three sole-contender applications were proved, each led by a staging persona with three distinct members: social 60–63, blog 64–67 and storefront 68–71. No masternode votes were cast. The API reports join close and uncontested end at 18:53:53.583 UTC (social), 18:54:23.439 (blog) and 18:54:47.231 (storefront), 2026-10-18. Seating and write-gate proofs follow after those deadlines. App Connect read checks passed 32/0. Remaining battery and demo evidence is added when the live run completes; this PR remains a draft until then.

## Deployment isolation

`.env.staging` is the authoritative public release configuration; it explicitly pins all eight group members, the App Connect protocol and storage epoch `testnet-staging-20261018`. The staging-only snapshot lives outside the ordinary dynamic bundle directory. It includes the eight members plus proved current DashPay profile, DPNS and token-history system contracts. The build refuses a mismatched snapshot or a client compilation that did not replace it.

Both `npm run build:staging` and `BASE_PATH=/staging npm run build` load this configuration. The latter preserves the rehearsal when the older workflow on master builds the staging checkout. CI builds the rehearsal too. Monitoring reads the staging env/snapshot as its own set. No master change or manual master deploy is required.

Regenerate this read-only snapshot with:

```sh
NETWORK=testnet npm run contracts:snapshot -- --staging --prune
```

This reads only `.env.staging` and writes only `lib/contracts/snapshots/testnet-staging.json`; ordinary testnet snapshots remain separate. Root's existing profile/history snapshots are older than the proved testnet v2 system contracts and must be refreshed for the later production cut.

## Operational lessons

- Pin `NETWORK=testnet` and the testnet Insight endpoint explicitly in every operational child. Repository env fallbacks can otherwise select the devnet Insight URL.
- Wait for the owner's funding confirmation before spending. Confirm a bulk split before creating many descendant locks; Core's unconfirmed descendant limit is 25.
- Under `notYetUsable`, social profile extensions are gated as well as posts. Prepare identities, DPNS names, encryption keys and non-moderated batteries first, then resume profiles after seating.
- Preserve signed bytes and journals after uncertain outcomes. Adopt proved writes rather than resetting nonces or creating replacement fixtures.
- The responder now accepts an explicit testnet env/pool, uses trusted testnet SDK defaults, and refuses mainnet and cross-network requests before writes. Messaging keys use the wallet's CRITICAL-key/anchor derivation; immutable store orders must verify those advertised keys and checkpoint provenance before writing.
- Operational seeder copies are isolated in the protected run directory, explicitly require testnet, and remap demo actors into the new ledger. Repository devnet-only seeder guards remain in place.
- D36 temporarily overrides D20's shared production/staging set. After the owner's QA all-clear, change the staging pins/snapshot and epoch together when retiring this set.
