# App Connect contracts: the `yappr-app` anchor and Yappr's contract group

App Connect logs a user in by having their wallet add keys to their identity that are scoped to Yappr. The main one is an AUTHENTICATION key bound to a **contract group**, so one key can sign for every Yappr contract and nothing else. This document covers the contract side: the anchor contract that registers the group, which contracts join it, how they are registered, and how the app decides whether to trust the group.

**Deployments.** The testnet release set (anchor, group and members) was registered on 2026-10-21; see [TESTNET_RELEASE.md](TESTNET_RELEASE.md). Sakura's Platform chain was wiped for 5.0.0-beta.6 on 2026-10-13, and the set is registered again on the new genesis with social v16 in v15's slot: the anchor at maker nonce 24 (`APP_ID` `BbWcUA8M…`) registers the group `7iM9B6WD…`, and the seven members joined it at nonces 25-31 ([SAKURA_BETA6_DEPLOY.md](SAKURA_BETA6_DEPLOY.md), which records why no beta.5 id is reproduced). `verify-appconnect.mjs --only g1,g2,g3,a1` passes there (32/0). `.env.devnet` and `.env.testnet` carry the four `NEXT_PUBLIC_APP_CONNECT_*` values, and builds with `NEXT_PUBLIC_LOGIN_PROTOCOL=app-connect` sign in with App Connect ([APP_CONNECT_PROFILE.md](APP_CONNECT_PROFILE.md)). The beta.5 re-cuts are in [PLATFORM_V5_BETA5_UPGRADE.md](archive/PLATFORM_V5_BETA5_UPGRADE.md), social v16 in [SOCIAL_V16.md](SOCIAL_V16.md).

Credit costs are paired with cents at $60/DASH (1M credits = 0.06¢).

## Why an anchor contract

The group has to be registered by some contract's create transition, and its id is `contractGroupId(owner, nonce)` of that create. Yappr registers it from a dedicated contract, `yappr-app` (`contracts/yappr-app-contract.json`), rather than from social or from the first feature contract as the sakura deploys did:

- **A stable app id.** The anchor's id is the App Connect app id: the id the login request names, the id grant records point at, and the only identity the app has. A wallet shows it, and may map it to a friendlier name of its own, but nothing on chain describes the app ([APP_CONNECT_PROFILE.md](APP_CONNECT_PROFILE.md#app-identity)). Social is re-cut every few weeks and gets a new id each time; the anchor has no reason to change.
- **A home for the encryption key.** Peers find a user's messaging key with `identities.contractKeys([...ids], APP_ID, [ENCRYPTION])`. Encryption keys can only be bound to a contract, never to a group (`InvalidKeyPurposeForContractBoundsError`), and only to one that opts in. The anchor is the contract that opts in, so the binding survives every re-cut of the contracts that use it.
- **A narrow group.** Memberships can never be removed. Before App Connect, Sakura's old group (`Cxxdiq5b…`, registered by key backup) held twelve contracts, including the retired password vault and key backup. That group was replaced at genesis; the current beta.6 group is the anchor-owned set in the status above. The release also uses a fresh anchor group containing only its intended members.

The cost is that every member is registered again, into the new group, at the cut-over. Their data starts empty (re-seeded on devnet). This was approved on 2026-10-11.

## The anchor: `contracts/yappr-app-contract.json`

| | |
| --- | --- |
| sha256 | `d3acd888168f6ee074d2eb7f73442917b255aa0be3b6417698d637844ce41f41` |
| Signed create | **707 B** with the group registration and its own membership (642 B unsigned plus a 65 B ECDSA signature) |
| Validation | rs-dpp 5.0.0-beta.4 at PV14 with full validation (`b4val`): OK, 528 B serialized. The wasm-sdk and wasm-dpp2 5.0.0-beta.4 full parses, meta-schema v3 and the node-rule audit: OK (`validate-contract-offline.mjs --network mainnet --strict-size`). |

**`config.requiresIdentityEncryptionBoundedKey: 2`** (`MultipleReferenceToLatest`). It lets an identity hold any number of ENCRYPTION keys bound `singleContract(APP_ID)`, and keeps a pointer to the current one. These are the details, checked in the beta.4 source:

- `StorageKeyRequirements` is `Unique = 0`, `Multiple = 1`, `MultipleReferenceToLatest = 2` (`rs-dpp/src/data_contract/storage_requirements/keys_for_document_type.rs`).
- Registering a key bound to a contract checks the contract's opt-in for that purpose. With none, the key is refused (`DataContractBoundsNotPresentError`). With `Unique`, a second key is refused (`IdentityPublicKeyAlreadyExistsForUniqueContractBoundsError`), so a user could never rotate. See `validate_identity_public_key_contract_bounds/v1`.
- With `MultipleReferenceToLatest`, Drive stores each key under its key id, plus a sibling reference at the empty key of the same purpose subtree that names the newest key (`add_potential_contract_info_for_contract_bounded_key/v1`). Drive identity methods v2 use this v1 from PV14. The v0 wrote the pointer one level up, where it could not resolve, so such keys could not be registered before PV14 at all.
- `identities.contractKeys` reads exactly that empty key: `identities_contract_keys_query` subqueries `[IdentityContractInfo, contractId, ContractInfoKeys, purpose]` with `set_subquery_key(Key::new())`. With `Multiple` (1) nothing is stored there, and the query returns no key. That is why the value must be 2.
- Drive's own test (`test_identity_update_adding_contract_bound_key_multiple_reference_to_latest`) pins it: the current key is the newest whatever the order inside an update, and disabling an older key leaves the pointer on the newer one.
- The opt-in can never change: a contract update that changes `requiresIdentityEncryptionBoundedKey` is refused (`DataContractConfig::validate_update_v0`).

No decryption opt-in: Yappr's anchor has no DECRYPTION twin, so Yappr asks for no DECRYPTION binding. (The profile still allows DECRYPTION `ENC_BINDING`s for an app whose contract opts in.)

**`appInfo`**, the one document type. It is deliberately small, and it is **not an app manifest**. It is owner-only metadata about the app. Wallets and apps do not read it, and a wallet must not use it to identify the app, to authorise a callback host or to set limits: an app is identified by its contract id alone, because anyone could publish an owner-only record that names itself "Yappr" ([APP_CONNECT_PROFILE.md](APP_CONNECT_PROFILE.md#app-identity)). The type exists because the anchor was registered with it; its schema is not extended.

| Property | |
| --- | --- |
| `version` | integer 1–255, the App Connect profile version the app speaks |
| `name` | display name, 1–32 characters |
| `url` | the app's https origin (`^https://[a-z0-9.-]+$`, up to 64 characters) |

- `creationRestrictionMode: 1` (owner only). Batch validation refuses a create whose owner is not the contract owner (`DocumentCreationNotAllowedError`, `document_create_transition_action/advanced_structure_v1`).
- A unique `byOwner` index, so there is at most one, and it is the maker's.
- Mutable, never deleted. Nothing reads it.

The anchor uses no byte arrays, so no property type shorthand applies. It is not `readonly`, which keeps additive updates possible (a later document type). Group memberships can only be declared at create, so an update never changes the member list. It can still widen the group: a whole-contract membership covers every type the contract has or will have (see "Group trust model").

## The group

The anchor's create transition (version 1, PV14) carries:

- `contractGroup: { name: "Yappr", description: "Yappr (yap.pr): the contracts a Yappr App Connect key signs for" }`, with **no admins**. Stored ownership is `singleOwner`: the maker, and only the maker, can add members.
- `contractGroupMemberships: [{ contractGroupId: GROUP_ID, member: "contract" }]`. The anchor joins the group it registers, which the protocol allows ("the group must exist, or be the one registered by the same transition").

Every member's create carries the same single membership (the whole contract), and no registration. The rules, from `docs/protocol/contract-groups.md` and the code:

- `GROUP_ID = sha256d("contract_group" ‖ ownerId ‖ identityNonce as u64 big-endian)` (`rs-dpp/src/contract_group/mod.rs`, `generate_contract_group_id`). It is not on the wire. `scripts/app-connect-set.mjs` implements it, and `verify-appconnect.mjs --self-test` pins it against sakura's group: `contractGroupId(9RPq2Ju…, 1) = Cxxdiq5b…`.
- The anchor's id is `generateId(ownerId, nonce)` for the same nonce, so both are known before anything is broadcast.
- A contract can only enrol itself, at creation, and only if its creator is the group's owner or an admin. Joining a group that does not exist is refused 41001; joining one you do not own is refused 41002.
- There is no update path and no leaving, at most 16 memberships per contract, and a redundant document-type or token membership is refused.

## Members

Registered from the maker, anchor first, normally at consecutive identity nonces (see "Registering the set" for when a member lands later). Every file is pinned by sha256 in `APP_CONNECT_ENTRIES` (`scripts/app-connect-set.mjs`). The publisher refuses a file that changed, and `verify-appconnect.mjs --self-test` fails until a re-cut updates the pin.

| Nonce | Entry | File | sha256 | Signed create | Env |
| ---: | --- | --- | --- | ---: | --- |
| N | `app` (registers the group) | `yappr-app-contract.json` | `d3acd888…` | 707 B | `NEXT_PUBLIC_APP_CONNECT_APP_ID` |
| N+1 | `social` (v17) | `yappr-social-contract-v17.json` | `77cf4308…` | ~18,054 B | `NEXT_PUBLIC_YAPPR_CONTRACT_ID` |
| N+2 | `blocks` | `yappr-blocks-contract.json` | `ba0ef67a…` | 1,258 B | `NEXT_PUBLIC_YAPPR_BLOCKS_CONTRACT_ID` |
| N+3 | `dmV5` | `yappr-dm-contract-v5.json` | `4fe2b3f4…` | 3,557 B | `NEXT_PUBLIC_YAPPR_DM_V5_CONTRACT_ID` |
| N+4 | `blog` (v9) | `yappr-blog-contract.json` | `448fb9ea…` | ~9,247 B | `NEXT_PUBLIC_YAPPR_BLOG_CONTRACT_ID` |
| N+5 | `pollr` (v8) | `pollr-contract.json` | `a77afe5f…` | ~3,568 B | `NEXT_PUBLIC_POLLR_CONTRACT_ID` |
| N+6 | `storefront` (v10) | `yappr-storefront-contract.json` | `69daf979…` | ~18,704 B | `NEXT_PUBLIC_YAPPR_STOREFRONT_CONTRACT_ID` |
| N+7 | `passkeyVault` ([PASSKEY_VAULT.md](PASSKEY_VAULT.md)) | `yappr-passkey-vault-contract.json` | `14094cad…` | 1,008 B | `NEXT_PUBLIC_YAPPR_PASSKEY_VAULT_CONTRACT_ID` |

- This is the **testnet release set** as first registered on 2026-10-21 (social v17, blog v9, pollr v8, storefront v10; [SOCIAL_V17.md](SOCIAL_V17.md)). The owner then abandoned social v17, blog v9 and storefront v10 (D42, [TESTNET_RELEASE.md](TESTNET_RELEASE.md)): they stay in the group for good, unused. Social v18, blog v10 and storefront v11 ([SOCIAL_V18.md](SOCIAL_V18.md)) are the appended entries of `APP_CONNECT_ENTRIES`; they join the same group when registered with `--append-after passkeyVault`. The password-era `authVault` is out (R-M6, D10): the passkey vault (`yappr-passkey-vault-contract.json`, [PASSKEY_VAULT.md](PASSKEY_VAULT.md)) joins at N+7 instead. Sakura's beta.6 genesis registered the previous set (social v16 at N+1, blog v8, pollr v7, storefront v8 and `authVault` at N+7; the ids below).
- Signed sizes are the PV14 version 1 creates with the membership. A membership adds about 33 B to a create. The release cut's `~` sizes are `validate-contract-offline.mjs`'s estimates on the 5.0.0-rc.3 wasm-sdk.
- Every file passes rs-dpp's full validation at PV14 (5.0.0-beta.5 `b5val` for the four beta.5 re-cuts, 5.0.0-beta.4 `b4val` for the others), the two 5.0.0-beta.5 wasm full parses, meta-schema v3 at beta.5 and the node-rule audit. The elected cuts (social, blog, storefront) also pass with mainnet's rendering (interim `notYetUsable`).
- The `~` sizes of the beta.5 re-cuts are the publisher's estimates (`--plan`) less its 100 B signature allowance, plus a 65 B signature. Social v16's is the same arithmetic on `validate-contract-offline.mjs`'s estimate from the 5.0.0-beta.6 wasm-sdk, plus the membership; it passes the two 5.0.0-beta.6 wasm full parses and the node-rule audit, devnet and mainnet renderings alike.
- None embeds another contract's id. The publisher refuses a `SOCIAL_CONTRACT_ID` placeholder, so the order inside the set only fixes the ids.
- **Cost:** about 263e9 credits (2.6 DASH, ~15,800¢) by the beta.3 per-contract costs on sakura. The shorthand files are smaller, so expect a little less.

DashPay's `profile` is a system contract and cannot join a group. App Connect covers it with a separate `documentType(DashPay, profile)` key.

## Retired on PV14

These are excluded from the **testnet release** (`RETIRED_ON_PV14`, D9). On Sakura's older beta.5 and beta.6 geneses, key exchange, vault and key backup were registered **without any group** (maker nonces 21–23 on beta.5, 32–34 on beta.6). That historical deployment is not the release policy: register none of them in the fresh release set, blank their ids at cut-over and then remove their client paths. DM v4 was not registered on those Sakura geneses either.

| Contract | Why it goes |
| --- | --- |
| key exchange (`key-exchange-v2.json`) | The legacy QR login. App Connect responses go to Platform's own login-response store (`H8F9…`, `loginKeyResponse`), and the wallet registers the keys itself. |
| password vault (`yappr-vault-contract.json`) | The password-era schema is retired. Release passkey access belongs to its own vault member (D10, [PASSKEY_VAULT.md](PASSKEY_VAULT.md)), with no password recovery. |
| key backup (`encrypted-key-backup-contract.json`) | It holds passphrase-encrypted login-key backups, for the same reason. |
| DM v4 (`yappr-dm-contract.json`) | Read-only since DM v5. Its threads only merge into the v5 timeline, so a fresh PV14 network has none to read. |

In the group, each would permanently widen what every group-bound key can sign. Testnet now runs PV14 (5.0.0-rc.3); protocol support is no longer a reason to retain these paths. Current production defaults still select the old contracts and legacy sign-in until WP15 switches every shipping build to App Connect. The release's fresh pollr v8 is a group member; the old externally owned testnet Pollr deployment is separate. See [RELEASE_CLEANUP.md](RELEASE_CLEANUP.md) for the coordinated removals.

## Registering the set

Prerequisites:
- Every node of the target network runs 5.0.0-beta.6 or newer (testnet runs 5.0.0-rc.4: [TESTNET_STAGING_REHEARSAL.md](TESTNET_STAGING_REHEARSAL.md); social v16's typed-array `where` and indexOnly element indexes are refused before it; social v15's format-1 token is undecodable on beta.3, and the beta.5 SDK cannot read beta.3 nodes). Beta.3 to beta.5 nodes report protocol version 14 too, so the publisher reads the Drive version from the status API and refuses to run in any connected mode (`--dry-run`, `--signed-dry-run`, `--live`) unless it is 5.0.0-beta.6 or newer. The publisher itself needs the 5.0.0-beta.6 SDK: even `--plan` decodes every create with wasm-dpp2, and the beta.5 one refuses v16 (10231). The status answers for the one node that responded, so confirm the rest with `ops/status.mjs` first.
- The maker holds the cost above. Every connected mode prints each create's estimate (its registration fee plus a storage allowance) beside the maker's balance, and `--signed-dry-run` and `--live` refuse to sign unless the balance covers the estimate plus 20%.
- NETWORK is required (no script defaults to a network). On testnet and mainnet the run must also name, explicitly: `--maker <id>`; `--interim <kind>`, `--election-windows <join>,<vote>`, `--election-delay <seconds>` and `--challenge-cool-down <seconds>`, which render every elected contract (social, blog, storefront) and are frozen into it (mainnet needs at least 86400 s per window); for `--signed-dry-run` and `--live`, `--maker-key-file <path> --maker-key-id <n>` (a key file of this user's with mode 0600 or tighter; there is no default path and no seed derivation off devnet); and for `--live`, `--production`. The journal's directory must be private (0700; created so when missing). The interim, windows and election delay are printed by every mode and recorded in the journal, and a resumed run must name the same ones. On a devnet they are optional and default to the files' own.
- The connected modes gate on the protocol version of the proved current epoch, never on a status page.
- From the anchor's nonce to the last member's, the maker signs nothing else that takes an **identity** nonce: no other contract create or update, identity update, or credit transfer. Token mints and document writes use identity-contract nonces and do not interfere. The anchor must take the planned nonce, since it fixes APP_ID and GROUP_ID. A member that finds a later nonce still registers, under a different id than the plan printed; the run says so, and its final env lines carry the real ids.

```sh
# 1. Offline: the ids for a maker and anchor nonce, then every create built, decoded and audited (no network, no keys)
NETWORK=devnet node scripts/register-app-connect-contracts.mjs --plan --maker <makerId> --start-nonce <N>
NETWORK=devnet node scripts/register-app-connect-contracts.mjs --plan --start-nonce <N>   # devnet maker from .env.devnet
NETWORK=testnet node scripts/register-app-connect-contracts.mjs --plan --maker <makerId> --start-nonce <N> \
  --interim notYetUsable --election-windows 86400,86400 --election-delay 86400 --challenge-cool-down 1209600              # testnet (D41)
NETWORK=mainnet node scripts/register-app-connect-contracts.mjs --plan --maker <makerId> --start-nonce <N> \
  --interim notYetUsable --election-windows 604800,604800 --election-delay 259200 --challenge-cool-down 2592000 # mainnet (D41)

# 2. Read-only against the network: the maker's nonce (N defaults to chain nonce + 1), and that no
#    contract of the set and not the group exists yet
NETWORK=devnet node scripts/register-app-connect-contracts.mjs --dry-run

# 3. The same, signed with the maker's key (devnet: seed index 9, or a named key file; elsewhere only
#    --maker-key-file <0600 file> --maker-key-id <n>); nothing is broadcast
NETWORK=devnet node scripts/register-app-connect-contracts.mjs --signed-dry-run

# 4. Register. The journal (mode 0600, outside the repo) keeps every signed transition; re-running with the
#    same journal resumes and only ever re-broadcasts the same bytes for a nonce. `--upto app` stops after the anchor.
NETWORK=devnet node scripts/register-app-connect-contracts.mjs --live --journal <ops-dir>/appconnect-<network>.json
#    On testnet, every setting explicit:
NETWORK=testnet node scripts/register-app-connect-contracts.mjs --live --production --journal <0700 ops-dir>/appconnect-testnet.json \
  --maker <makerId> --maker-key-file <0600 key file> --maker-key-id <n> --interim notYetUsable --election-windows 86400,86400 --election-delay 86400 --challenge-cool-down 1209600

# 5. Prove it
NETWORK=devnet node scripts/verify-appconnect.mjs --contract <APP_ID> --group <GROUP_ID> --owner <maker> --members <ids>
```

Every mode first builds the whole set unsigned at the planned nonces, so a changed file or a rule the node would refuse stops the run before anything is signed. Each create is decoded by the wasm-sdk and checked:
- it re-encodes byte-identically;
- its nonce;
- the group registration is on the anchor only, with no admins;
- its membership is exactly `[(GROUP_ID, contract)]`;
- the carried contract equals the assembled one;
- it is under the 20,480 B cap.

Then wasm-dpp2 decodes it and parses the contract with full validation.

During the live run, one entry at a time:
- The create is signed at the maker's next identity nonce and journaled before its first broadcast.
  - The next nonce is never taken below the highest one the journal already spent. A lagging node can therefore not hand back a used nonce, and with it a registered contract's id.
  - A resumed run re-broadcasts those same bytes and never signs that entry again.
  - The journal is replaced durably before each broadcast: written and flushed to a temporary file, renamed, then its directory flushed. A failed flush stops the run.
  - A maker nonce spent beyond the journal must not have produced a member of the group. If one did, the journal lost a checkpoint, and the run stops instead of registering a second copy.
- After broadcast, these are read back with proofs:
  - the contract, whose document types must equal the pinned file's, so a wrong id cannot pass;
  - its membership;
  - the group: owner the maker, no admins.
- A create counts as refused only on proof. A proof must show the maker's nonce spent at height H, and a membership proof at height H or later must show the contract outside the group. Every create writes its membership together with the contract. A plain contract fetch can't decide this: it proves "not found" with no height. Then the create was refused (and paid for), or another transition took the nonce.
  - "Spent" reads the nonce's missing-revision bitset: a nonce below the top whose bit is still set may yet land, so it stays pending.
  - `identityNonceSpent` and `decideCreateOutcome` are pure, and covered by `verify-appconnect.mjs --self-test`.
  - It is marked `refused` in the journal and the run stops.
  - Reads that keep failing, or that never catch up with H, stop the run without marking anything; a re-run re-broadcasts the same bytes.
- After investigating, `--retry-refused` proves the refusal again in the same way, then prepares the member again at the maker's next nonce, under a new id. The group already exists, so it can still join. A refused anchor leaves nothing of the set on chain: start a fresh journal.

**Dry-run output.** The header comes first. The `--plan` example below is sakura's maker at nonce 24, after the burn of nonces 1-23 on the beta.6 genesis:

```text
App Connect contract set on devnet: maker 9RPq2JuMsmrTUoxQLricaT245t4bYskCj4hXWcedCagH (environment), anchor nonce 24
APP_ID=BbWcUA8Msi7HSgC2hCJsCtDADs2FzQVabRuHvk1tnj4d
GROUP_ID=7iM9B6WDREEURDgMakuSP5sZRQy62dscFQpN1APPC9hF
GROUP_OWNER=9RPq2JuMsmrTUoxQLricaT245t4bYskCj4hXWcedCagH
nonce  contract    id                                            source
   24  app         BbWcUA8Msi7HSgC2hCJsCtDADs2FzQVabRuHvk1tnj4d  yappr-app-contract.json d3acd888168f… (registers the group and joins it)
   25  social      4qctQYg3YNxp3kVojKxq47iABNbPFtRqSLxQvRz3cjeF  yappr-social-contract-v16.json 63dcfa91da1e…
   …
   31  authVault   9PoojBAXm6PNabkJEU65nd9dPcvpjpSfXK15bJVeFWAt  yappr-auth-vault-contract.json cecf0ccca95a…
```

Then:
- under `creates (unsigned, at the planned nonces):`, one block per create: its size, its role, and that both wasm builds decoded it (the moderated cuts also print their moderation and action fees);
- `--signed-dry-run` repeats the blocks signed, with exact sizes;
- the env lines: the four `NEXT_PUBLIC_APP_CONNECT_*` variables (the member list includes the anchor), then each member's contract variable.

`--dry-run` adds a first line with the protocol version and the maker's nonce and balance. A `--live` run prints its env lines from the journal, with the ids each create actually landed at.

These are the ids nonce 24 produces, and the ids the sakura `--live` run of 2026-10-13 landed at.

### Adding a member to the registered set

On a live chain `APP_CONNECT_ENTRIES` only ever grows at the end. A member a later cut replaces keeps its entry, because its membership can never be removed and the app must pin every member of the group; its `envKey` becomes null, so the env lines name only the replacement's id while `NEXT_PUBLIC_APP_CONNECT_GROUP_MEMBERS` keeps both. A fresh genesis starts a new set instead: sakura's beta.6 genesis registers social v16 in v15's slot and no v15 at all.

`--dry-run` and `--signed-dry-run` plan a fresh set from the anchor nonce, so they refuse once the maker is past it. An appended entry is added by resuming the live run with the same journal: the verified entries are skipped, and the new one is signed at the maker's next identity nonce, journaled, broadcast and read back with proofs.

```sh
NETWORK=devnet node scripts/register-app-connect-contracts.mjs --live --journal <ops-dir>/appconnect-sakura.json
```

- Its planned nonce N+i may already be spent (on beta.5's sakura, 21 to 23 went to the legacy contracts). The run then prints a NOTE and registers it at the maker's next nonce under a different id than the plan's; its final env lines carry the real one. Before it signs, it checks that none of the nonces spent beyond the journal produced a member of the group.
- Afterwards `verify-appconnect.mjs --only g1,g2,g3,a1` must pass with the grown member list.

## Env

| Variable | Value |
| --- | --- |
| `NEXT_PUBLIC_APP_CONNECT_APP_ID` | the anchor contract id |
| `NEXT_PUBLIC_APP_CONNECT_GROUP_ID` | the group the anchor registered |
| `NEXT_PUBLIC_APP_CONNECT_GROUP_OWNER` | the maker |
| `NEXT_PUBLIC_APP_CONNECT_GROUP_MEMBERS` | comma-separated: the anchor and every member, in registration order |

- `.env.devnet` sets them from the publisher's output, together with the member contracts' own variables and the topology; `.env.testing` lists them unset.
- `lib/app-connect/config.ts` reads them. A member may be written `id:version`; a bare id pins version 1.

## Group trust model

- **Append-only.** Anything the maker creates with a membership joins the group for good, and every group-bound key can then sign for it. Binding a key to a group trusts the group's owner (and admins; this group has none) with that growth. Nobody else can add a member: any other creator is refused 41002.
- **Widening by update.** A `contract` membership covers every document type and token the contract has or will have. A maker update that adds a type to a member, or to the non-readonly anchor, therefore widens what every group-bound key signs for, without changing the member list. Contract updates are maker-only too. The app pins each member's version beside its id (`id:version`, a bare id pins 1), and the battery checks every member is at its pinned version (g3e): a member at another version blocks new logins, and the group key stops signing for it. An additive update (`scripts/update-contract-additive.mjs`, devnet only) therefore ships together with the new pin; storefront v9 is the first (docs/STOREFRONT_V9.md).
- **Pinned in the app.** The app ships `GROUP_OWNER` and the member list. At startup it makes proved reads (`contractGroups.info`, `contractGroups.members`), and checks in both directions:
  - the group's owner must equal the pinned owner, with no admins;
  - every pinned member must be in the group;
  - every member of the group must be pinned.

  A different owner, an admin, or a member the app does not pin blocks **new** logins. The user is not asked to approve a key that could sign for a contract the app does not know.
- **Verified per candidate.** A wallet's response is accepted only if every granted key passes the verifier (hint, framing and AAD, bounds, levels, limits, the primary binding, and the anchor encryption key being the current one). The full list is in [APP_CONNECT_PROFILE.md](APP_CONNECT_PROFILE.md#app-rules), "Verification".
- **The maker key is the root of trust.** Anything that can create contracts as the maker can grow the group. On mainnet the publisher should be a dedicated identity with cold MASTER and CRITICAL keys, used only for registrations.

`verify-appconnect.mjs` checks the same invariants from outside after a registration:

| Case | What it proves |
| --- | --- |
| g1 | The group exists, its owner is the pinned owner, it has no admins, and its name is "Yappr". |
| g2 | Pinned members = group members, with no document-type or token members. |
| g3 | `APP_ID` and `GROUP_ID` derive from the same maker nonce, and every member is maker-owned, lists the group, and is at its pinned version. |
| a1 | The deployed anchor's encryption opt-in is 2, with no decryption opt-in, and its schema equals the committed file. |
| k1 | Writes. A seed-ledger persona with MASTER and CRITICAL keys (`--keyholder`, default 242; `--ledger` names the ledger file) registers an ENCRYPTION/MEDIUM key bound to the anchor, and `contractKeys` returns it. A second key moves the pointer to itself, and the first stays enabled and bound. Each key is the test wallet's own App Connect key at the next unused rotation, so the persona's wallet sign-in still holds its current key. In a `finally`, k1d checks that it does, and adds the next rotation if it does not. Every run adds two keys to that persona. |

Peers encrypt to the newest anchor key, and Platform never moves that pointer back: a disabled key keeps it, and a key the identity already holds is never added again. `verify-appconnect.mjs --restore-anchor-key --keyholder <n>` is k1d alone. It is the repair for a persona whose current anchor key nobody holds. It prints public keys, key ids and the credits spent.

`--only g1,g2,g3,a1` runs without the seed ledger. The read cases were exercised against sakura's existing group, `Cxxdiq5b…`, and its key-backup creator: g1 and g3 pass, and g2 flags a member left out of the pinned list on purpose.
