# App Connect contracts: the `yappr-app` anchor and Yappr's contract group

App Connect logs a user in by having their wallet add keys to their identity that are scoped to Yappr. The main one is an AUTHENTICATION key bound to a **contract group**, so one key can sign for every Yappr contract and nothing else. This document covers the contract side: the anchor contract that registers the group, which contracts join it, how they are registered, and how the app decides whether to trust the group.

**Status: nothing is registered anywhere yet, and no client code reads any of this.** The PR that added it ships the anchor contract, the publisher (`scripts/register-app-connect-contracts.mjs`), the battery (`scripts/verify-appconnect.mjs`), the offline probes and empty env names. The first registration is planned for sakura at the beta.4 cut-over, where every member contract is re-created into the new group together with social v15.

Credit costs are paired with cents at $60/DASH (1M credits = 0.06¢).

## Why an anchor contract

The group has to be registered by some contract's create transition, and its id is `contractGroupId(owner, nonce)` of that create. Yappr registers it from a dedicated contract, `yappr-app` (`contracts/yappr-app-contract.json`), rather than from social or from the first feature contract as the sakura deploys did:

- **A stable app id.** The anchor's id is the App Connect app id: the id a wallet's brand map is keyed by, the id the login request names, and the id grant records point at. Social is re-cut every few weeks and gets a new id each time; the anchor has no reason to change.
- **A home for the encryption key.** Peers find a user's messaging key with `identities.contractKeys([...ids], APP_ID, [ENCRYPTION])`. Encryption keys can only be bound to a contract, never to a group (`InvalidKeyPurposeForContractBoundsError`), and only to one that opts in. The anchor is the contract that opts in, so the binding survives every re-cut of the contracts that use it.
- **A narrow group.** Memberships can never be removed. The existing sakura group (`Cxxdiq5b…`, registered by key backup) holds all twelve contracts, including the ones App Connect retires. A key bound to it could write to the password vault and key backup for as long as the key lives. A new group, registered by the anchor, holds only what App Connect needs.

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

No decryption opt-in: App Connect has no DECRYPTION twin.

**`appInfo`**, the one document type. It is deliberately small.

| Property | |
| --- | --- |
| `version` | integer 1–255, the App Connect profile version the app speaks |
| `name` | display name, 1–32 characters |
| `url` | the app's https origin (`^https://[a-z0-9.-]+$`, up to 64 characters) |

- `creationRestrictionMode: 1` (owner only). Batch validation refuses a create whose owner is not the contract owner (`DocumentCreationNotAllowedError`, `document_create_transition_action/advanced_structure_v1`).
- A unique `byOwner` index, so there is at most one, and it is the maker's.
- Mutable, never deleted. Nothing reads it yet; a wallet may show it beside its own brand-map entry.

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
| N+1 | `social` (v15) | `yappr-social-contract-v15.json` | `d2e72900…` | 16,288 B | `NEXT_PUBLIC_YAPPR_CONTRACT_ID` |
| N+2 | `blocks` | `yappr-blocks-contract.json` | `ba0ef67a…` | 1,258 B | `NEXT_PUBLIC_YAPPR_BLOCKS_CONTRACT_ID` |
| N+3 | `dmV5` | `yappr-dm-contract-v5.json` | `4fe2b3f4…` | 3,557 B | `NEXT_PUBLIC_YAPPR_DM_V5_CONTRACT_ID` |
| N+4 | `blog` (v7) | `yappr-blog-contract.json` | `0b7d6839…` | 6,754 B | `NEXT_PUBLIC_YAPPR_BLOG_CONTRACT_ID` |
| N+5 | `pollr` (v6) | `pollr-contract.json` | `75a9deec…` | 4,171 B | `NEXT_PUBLIC_POLLR_CONTRACT_ID` |
| N+6 | `storefront` (v7) | `yappr-storefront-contract.json` | `ab7cd333…` | 16,604 B | `NEXT_PUBLIC_YAPPR_STOREFRONT_CONTRACT_ID` |
| N+7 | `authVault` | `yappr-auth-vault-contract.json` | `cecf0ccc…` | 2,029 B | `NEXT_PUBLIC_YAPPR_AUTH_VAULT_CONTRACT_ID` |

- Signed sizes are the PV14 version 1 creates with the membership. A membership adds about 33 B to a create.
- Every file passes rs-dpp 5.0.0-beta.4 full validation at PV14 (`b4val`), the two wasm full parses, meta-schema v3 and the node-rule audit. The elected cuts (social, blog, storefront) also pass with mainnet's rendering (interim `notYetUsable`).
- None embeds another contract's id. The publisher refuses a `SOCIAL_CONTRACT_ID` placeholder, so the order inside the set only fixes the ids.
- **Cost:** about 263e9 credits (2.6 DASH, ~15,800¢) by the beta.3 per-contract costs on sakura. The shorthand files are smaller, so expect a little less.

DashPay's `profile` is a system contract and cannot join a group. App Connect covers it with a separate `documentType(DashPay, profile)` key.

## Retired on PV14

These are not re-registered on a PV ≥ 14 network and never join the group (`RETIRED_ON_PV14`). Sakura's current copies stay in the old group, unused once `/devnet` moves to App Connect.

| Contract | Why it goes |
| --- | --- |
| key exchange (`key-exchange-v2.json`) | The legacy QR login. App Connect responses go to Platform's own login-response store (`H8F9…`, `loginKeyResponse`), and the wallet registers the keys itself. |
| password vault (`yappr-vault-contract.json`) | It stores the login key wrapped under a password. An App Connect session has no single long-lived login key to store. Password access goes; restored sessions come from the passkey-wrapped bundle in the auth vault. |
| key backup (`encrypted-key-backup-contract.json`) | It holds passphrase-encrypted login-key backups, for the same reason. |
| DM v4 (`yappr-dm-contract.json`) | Read-only since DM v5. Its threads only merge into the v5 timeline, so a fresh PV14 network has none to read. |

In the group, each would also widen what every group-bound key can sign, permanently, for features that no longer exist. PV13 networks (testnet, mainnet today) keep the legacy flow and these contracts until the legacy code is deleted. Pollr on testnet is externally owned and could not join a maker-owned group anyway.

## Registering the set

Prerequisites:
- Every node of the target network runs 5.0.0-beta.4 (social v15's format-1 token is undecodable on beta.3).
- The maker holds the cost above.
- From the anchor's nonce to the last member's, the maker signs nothing else that takes an **identity** nonce: no other contract create or update, identity update, or credit transfer. Token mints and document writes use identity-contract nonces and do not interfere. The anchor must take the planned nonce, since it fixes APP_ID and GROUP_ID. A member that finds a later nonce still registers, under a different id than the plan printed; the run says so, and its final env lines carry the real ids.

```sh
# 1. Offline: the ids for a maker and anchor nonce, then every create built, decoded and audited (no network, no keys)
node scripts/register-app-connect-contracts.mjs --plan --maker <makerId> --start-nonce <N>
NETWORK=devnet node scripts/register-app-connect-contracts.mjs --plan --start-nonce <N>   # devnet maker from .env.devnet

# 2. Read-only against the network: the maker's nonce (N defaults to chain nonce + 1), and that no
#    contract of the set and not the group exists yet
NETWORK=devnet node scripts/register-app-connect-contracts.mjs --dry-run

# 3. The same, signed with the maker's key (devnet: seed index 9; elsewhere the contract-maker file); nothing is broadcast
NETWORK=devnet node scripts/register-app-connect-contracts.mjs --signed-dry-run

# 4. Register. The journal (mode 0600, outside the repo) keeps every signed transition; re-running with the
#    same journal resumes and only ever re-broadcasts the same bytes for a nonce. `--upto app` stops after the anchor.
NETWORK=devnet node scripts/register-app-connect-contracts.mjs --live --journal <ops-dir>/appconnect-<network>.json

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
  - The journal is replaced atomically: written to a temporary file, then renamed.
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

**Dry-run output.** The header comes first. The `--plan` example below is sakura's maker at nonce 13, the next one after storefront v7:

```text
App Connect contract set on devnet: maker 9RPq2JuMsmrTUoxQLricaT245t4bYskCj4hXWcedCagH (environment), anchor nonce 13
APP_ID=CWbSpGNiKGL1i3bmLSWiMQvv364FBCh8sgBqNb1Qo9N9
GROUP_ID=3S3owNijnVrxE9FvgcHbCTG6iogKBwg69iwFhV7Pke8c
GROUP_OWNER=9RPq2JuMsmrTUoxQLricaT245t4bYskCj4hXWcedCagH
nonce  contract    id                                            source
   13  app         CWbSpGNiKGL1i3bmLSWiMQvv364FBCh8sgBqNb1Qo9N9  yappr-app-contract.json d3acd888168f… (registers the group and joins it)
   14  social      BVW1hBXxLSSTo7V5ZXUf6vhJ3Zkb2CgWoCQz3fHt9t9F  yappr-social-contract-v15.json d2e729005ce6…
   …
   20  authVault   6u6Ztd6V64L1tn7YuCMzZntqAcv1rAFfmVWrXCN6xC3e  yappr-auth-vault-contract.json cecf0ccca95a…
```

Then:
- under `creates (unsigned, at the planned nonces):`, one block per create: its size, its role, and that both wasm builds decoded it (the moderated cuts also print their moderation and action fees);
- `--signed-dry-run` repeats the blocks signed, with exact sizes;
- the env lines: the four `NEXT_PUBLIC_APP_CONNECT_*` variables (the member list includes the anchor), then each member's contract variable.

`--dry-run` adds a first line with the protocol version and the maker's nonce and balance. A `--live` run prints its env lines from the journal, with the ids each create actually landed at.

The ids above are only what nonce 13 would produce. Nothing is registered until a `--live` run.

## Env

| Variable | Value |
| --- | --- |
| `NEXT_PUBLIC_APP_CONNECT_APP_ID` | the anchor contract id |
| `NEXT_PUBLIC_APP_CONNECT_GROUP_ID` | the group the anchor registered |
| `NEXT_PUBLIC_APP_CONNECT_GROUP_OWNER` | the maker |
| `NEXT_PUBLIC_APP_CONNECT_GROUP_MEMBERS` | comma-separated: the anchor and every member, in registration order |

- They are listed, unset, in `.env.devnet` and `.env.testing`.
- The cut-over PR fills them from the publisher's output, together with the member contracts' own variables and the topology.
- The web PR adds the client constants that read them.

## Group trust model

- **Append-only.** Anything the maker creates with a membership joins the group for good, and every group-bound key can then sign for it. Binding a key to a group trusts the group's owner (and admins; this group has none) with that growth. Nobody else can add a member: any other creator is refused 41002.
- **Widening by update.** A `contract` membership covers every document type and token the contract has or will have. A maker update that adds a type to a member, or to the non-readonly anchor, therefore widens what every group-bound key signs for, without changing the member list. Contract updates are maker-only too. The battery checks that every member is still at version 1 (g3e), and the web PR should pin each member's version beside its id.
- **Pinned in the app.** The app ships `GROUP_OWNER` and the member list. At startup it makes proved reads (`contractGroups.info`, `contractGroups.members`), and checks in both directions:
  - the group's owner must equal the pinned owner, with no admins;
  - every pinned member must be in the group;
  - every member of the group must be pinned.

  A different owner, an admin, or a member the app does not pin blocks **new** logins. The user is not asked to approve a key that could sign for a contract the app does not know.
- **Verified per candidate.** A wallet's response is accepted only if:
  - the group key is AUTH, bound `contractGroup(GROUP_ID)`;
  - the encryption key is bound `singleContract(APP_ID)` and is the current one according to `contractKeys`;
  - nothing is unbound, CRITICAL outside the group key, or foreign-bound.
- **The maker key is the root of trust.** Anything that can create contracts as the maker can grow the group. On mainnet the publisher should be a dedicated identity with cold MASTER and CRITICAL keys, used only for registrations.

`verify-appconnect.mjs` checks the same invariants from outside after a registration:

| Case | What it proves |
| --- | --- |
| g1 | The group exists, its owner is the pinned owner, it has no admins, and its name is "Yappr". |
| g2 | Pinned members = group members, with no document-type or token members. |
| g3 | `APP_ID` and `GROUP_ID` derive from the same maker nonce, and every member is maker-owned, lists the group, and is still at version 1. |
| a1 | The deployed anchor's encryption opt-in is 2, with no decryption opt-in, and its schema equals the committed file. |
| k1 | Writes. A seed-ledger persona with a MASTER key (`--keyholder`, default 242) registers an ENCRYPTION/MEDIUM key bound to the anchor, and `contractKeys` returns it. A second key moves the pointer to itself, and the first stays enabled and bound. Every run adds two keys to that persona. |

`--only g1,g2,g3,a1` runs without the seed ledger. The read cases were exercised against sakura's existing group, `Cxxdiq5b…`, and its key-backup creator: g1 and g3 pass, and g2 flags a member left out of the pinned list on purpose.
