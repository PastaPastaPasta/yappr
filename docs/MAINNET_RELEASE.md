# Mainnet release

`npm run build:mainnet` is a local static build. It does not register contracts
or deploy the site. `npm run build` still loads `.env.testnet`.

## Public configuration

Copy `.env.mainnet.template` to `.env.mainnet`. Fill the Yappr contract, App
Connect app/group/owner, maker and YAPP token ids from the completed mainnet
registration journal and its verified readback. Use social **v19**, blog **v11**,
storefront **v12**, Pollr **v8**, DM **v5** and DashPay profile **v2**. Store and
Blog stay `beta`; credit tips stay `off`.

Pin exactly the registrar's eight release members, in registration order, as
`id:version`: the App Connect anchor,
social, blocks, DM v5, blog, Pollr, storefront and passkey vault. Profile and
system contracts are separate grants. Use the registered versions, including
an explicit `:1`. Do not copy ids from another network or publish the journal
(it contains signed transitions). Confirm YAPP with `tokens.calculateId(social,
0)` and the group membership through read-only SDK queries.

Set `NEXT_PUBLIC_MASTERNODE_VOTE_URL` to the reviewed HTTPS mainnet voting
site; it supports `{contract}`, `{charters}`, `{documentType}` and `{index}`.
The blank slot and links containing `testnet` or `devnet` are refused. Keep
`NEXT_PUBLIC_APP_CONNECT_CARRIER=dashpay`: mainnet uses `dashpay://connect`
and never offers `dash-key:` or `dash-st:`. Keep a separate `mainnet-` storage
epoch and all retired ids and devnet endpoint overrides explicitly blank.

The build requires all ids to encode 32 bytes in base58 and rejects application
ids found anywhere in `.env.testnet`, `.env.beta`, `.env.staging-old`,
`.env.testing` or `.env.devnet`, plus the legacy testnet defaults in
`lib/constants.ts`. Mainnet builds refuse the existing testnet/devnet subpaths.
Only the three system ids below may be shared,
and only in their own slots. Shell `NEXT_PUBLIC_*` values cannot override the
chosen file. An alternative public file can be supplied explicitly:

```sh
flock /work/tmp/yappr-build.lock npm run build:mainnet -- /absolute/path/mainnet.env
```

## System contracts

On 2026-11-11, read-only `EvoSDK.mainnetTrusted()` queries with
`await sdk.connect()` followed by `await sdk.contracts.fetch(id)` returned:

| Contract | Id | Version | Checked document types |
| --- | --- | --- | --- |
| DPNS | `GWRSAVFMjXx8HpQFaNJMqBV7MBgMK4br5UESsB4S31Ec` | 2 | `domain`, `preorder` |
| DashPay / profile | `Bwr4WHCPz5rFVAD87RqTs3izo4zpzwsEdKPWUT1NS1C7` | 2 | `profile`, `contactInfo`, `contactRequest` |
| Token history | `43gujrzZgXqcKBiScLa4T8XTDnRhenR9BLx8GWVHjPxF` | 2 | `transfer`, `mint`, `burn` and other token events |

These are the template's only filled ids. No keys, signatures or broadcasts
are needed to repeat the reads. The runtime DashPay constant uses the same id.

## Contract snapshot

After copying the journal's verified public pins into `.env.mainnet`, run
`NETWORK=mainnet npm run contracts:snapshot` (or set `MAINNET_ENV_FILE` to the
alternative public env path). This reads contracts from mainnet with the SDK
and writes `lib/contracts/bundled/mainnet.json`; it never signs or broadcasts.
The script always prunes on mainnet, rejects `CONTRACT_IDS` overrides, and
checks the exact release membership and versions before writing. A missing
contract leaves the previous file intact. Review and commit the public env
and snapshot together. A mainnet build checks any existing snapshot against
its env pins and loads it as the SDK cache; before a snapshot exists, the app
fetches contracts from mainnet instead. Never use placeholder ids as release
pins or copy serialized contracts from testnet.

## Activation

Run lint, unit/script tests, dead-code checks and both builds before proposing
activation. A successful build with dummy ids proves configuration and static
export only; it does not prove chain registration or wallet interoperability.

There is no mainnet deployment job. A separate activation change needs reviewed
registered pins and snapshot, a chosen deployment path and storage epoch,
CI checks for the mainnet build, an explicit gated artifact/deployment step,
mainnet voting and wallet sign-in verification, and a rollback plan. Preserve
the existing testnet and QA deployments when adding that job.
