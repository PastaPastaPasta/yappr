# Passkey vault v1: sign in with a passkey

Implemented 2026-10-17 for the testnet release (D10). This is the design as built. It revises the 2026-10-16 design (`vault-design.md` in the release audit) where the owner's decisions V1–V6 changed it, most of all by including wallet (App Connect) sign-ins. Credits are paired with cents at 1M credits ≈ 0.06¢.

## 1. What it is

On a device where you are signed in, you add a passkey. Yappr writes one public `vaultEntry` document holding the signing keys of the session you are in, sealed so that only that passkey can open it. On another device or browser on yap.pr you choose **Sign in with a passkey**, pick the passkey (Face ID, Touch ID, Windows Hello, your phone, a security key), and the same session comes back:

| You signed in with | The passkey keeps | Opening it gives you |
|---|---|---|
| Your Dash wallet (App Connect) | The wallet's key ring: the group key, the DashPay profile key and the anchor's encryption key | The wallet session, with its allowance and expiry. If the wallet sign-in expired, ran out or was turned off, Yappr asks the wallet to renew it right there. |
| A HIGH key | That key, plus your messaging key when this device has the current one | A key session, as if you had pasted the key |
| A CRITICAL key, as a moderator | That key (only while you are on a social, storefront or blog moderation team), plus your messaging key | A key session for this tab, like a typed CRITICAL key. It never signs token transitions. |
| A CRITICAL key, not a moderator | Nothing: "To add a passkey, sign in with your Dash wallet or your everyday sign-in key." | — |

MASTER and TRANSFER keys never go in. The primary flow (V3) is: sign in with the Dash wallet, add a passkey when Yappr offers it, and sign in with the passkey from then on.

## 2. Owner decisions and what they changed

| Decision | As built |
|---|---|
| **V1** HPKE: any signed-in device re-seals every passkey's entry | Yes. Re-sealing is never silent: a review lists every passkey (added date, this or another device, "Needs update") with checkboxes, and offers "Remove all and start over". Only this device's passkeys start ticked (see §6 for why). |
| **V2** HIGH + messaging key for everyone; CRITICAL only for moderators, checked at enrol and at open; token actions never use a vault-held CRITICAL key | Yes. The moderator check reads each moderated contract's team fresh: the seated leader and members, or the appointed moderators while none is seated. A contract owner moderating under an interim does not count. Builds without App Connect persist every typed key, so they refuse such a key outright. A CRITICAL key from a passkey is marked for the tab before it is stored, and token transitions refuse it (they ask for the key typed in). A wallet key ring from a passkey keeps its group key's rights, starter claim included (V3b). |
| **V3** The vault is an App Connect group member; wallet users write their own entries with the group key | Yes: `passkeyVault` is the last entry of `APP_CONNECT_ENTRIES` (`scripts/app-connect-set.mjs`, sha256 pinned). A wallet entry holds the whole key ring; opening it rebuilds the grant and runs the same checks as a fresh wallet answer. |
| **V3b** A group-bound CRITICAL key is vaultable for everyone; an unbound CRITICAL key only for moderators | Yes. Every key-ring key must be contract-bound on chain. A raw CRITICAL key needs the moderator check unless it is bound to a contract group. |
| **V4** Offer once after a wallet or key sign-in on a device without a passkey; also in Settings | Yes. The offer is made at most once per browser, ever, and never after a passkey sign-in. Settings › Privacy & Security › Passkeys lists, adds, updates (through the review), renames and removes. |
| **V5** yap.pr only | The relying party is `yap.pr` on yap.pr (so `/`, `/staging`, `/testing` and `/devnet` share it) and `localhost` for development and the end-to-end tests. Everywhere else (`yappr.pages.dev`, the versioned mirrors and archives) the passkey button and settings do not appear. No Related Origin Requests. |
| **V6** On at launch, no flag | Passkeys appear wherever the deployment sets `NEXT_PUBLIC_YAPPR_PASSKEY_VAULT_CONTRACT_ID` and the page is on yap.pr. PRF is detected from the actual output; a provider without it writes nothing and gets friendly copy. |
| Naming | `contracts/yappr-passkey-vault-contract.json`, doctype `vaultEntry`, `NEXT_PUBLIC_YAPPR_PASSKEY_VAULT_CONTRACT_ID`, 10 passkeys per identity (client cap). |

The 2026-10-16 design assumed wallet users needed nothing and recommended against group membership. V3 overruled both; §4 and §6 cover the new parts.

## 3. Crypto (lib/crypto/hpke.ts, lib/crypto/passkey-vault.ts)

- **Suite:** RFC 9180 base mode, DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, ChaCha20-Poly1305, single shot. The spec checks RFC 9180 A.2.
- **PRF input:** `UTF8("yappr/passkey-vault/v1/prf") ‖ vaultContractId`. One input per deployment, so a discoverable sign-in evaluates the PRF in the same ceremony that picks the passkey, and a passkey gives a different key on every network.
- **Recipient:** `(skR, pkR) = DeriveKeyPair(prf)`; `pkR` is `recipientKey`.
- **info:** `UTF8("yappr/passkey-vault/v1") ‖ 0x00 ‖ contractId ‖ ownerId`.
- **AAD:** `UTF8("vaultEntry") ‖ 0x00 ‖ u8(version) ‖ u8(len(credentialId)) ‖ credentialId ‖ recipientKey ‖ u32be(authKeyId)`.
- **Bundle:** `format u8 ‖ n u8 ‖ n × (purpose u8 ‖ level u8 ‖ keyType u8 ‖ keyId u32be ‖ privateKey[32]) ‖ zero padding`.

  | Format | Holds | Padded to (sealed) | Allowed slots |
  |---|---|---|---|
  | 1, raw key | 1 sign-in key + at most 1 messaging key | 80 B (96 B) | slot 0 AUTHENTICATION at HIGH or CRITICAL (secp256k1 or hash160); ENCRYPTION at MEDIUM (secp256k1) |
  | 2, key ring | the group key first, then the other wallet keys, up to 4 | 160 B (176 B) | AUTHENTICATION at HIGH or CRITICAL; ENCRYPTION or DECRYPTION at MEDIUM |

  Slot 0 is the entry's `authKeyId`. Never MASTER, never TRANSFER, no repeated key id, padding must be zero; the decoder refuses anything else.
- **Seal:** any signed-in device, no passkey prompt; a fresh ephemeral key per seal.
- **Open:** version 1 only; `DeriveKeyPair(prf).pk == recipientKey` before any decryption; then the tag; then the bundle rules. The derived secret and PRF bytes are wiped.
- **Test vectors** (`lib/crypto/passkey-vault.test.ts`): the 2026-10-16 raw-key vector from the independent prototype, a key-ring vector computed with the prototype's HPKE, and the negative cases (wrong passkey, identity, contract, credential, key id, bit flips, version, MASTER/TRANSFER, slot rules, padding, and a forged bundle that opens: the chain check is what refuses it).

## 4. The chain check (lib/auth/passkey-vault.ts)

HPKE has no sender authentication: anyone can seal to a public `recipientKey`, and only the owner's keys can write the document. Nothing from a bundle is used until it is checked against the identity read fresh:

- **Raw key:** slot 0 must be an enabled AUTHENTICATION key with that id, level and type whose public key the private key matches (`checkSignInKey`); an unbound CRITICAL key must pass the moderator check now. The messaging key is kept only if it is the key peers encrypt to now (on App Connect builds the anchor's, via `resolveEncryptionPublicKey`); otherwise it is dropped and the sign-in goes on. Then the normal key sign-in (`login`), which checks the key again.
- **Key ring:** the private keys go through `verifyAppConnectKeys` (vendor/platform-auth), the same verifier as a wallet answer, against the request Yappr makes today: each key must be a live key of the owner matching one binding (bounds, purpose, level, limits), the group key must be there, nothing may be expired, spent or superseded, and the encryption key must be the anchor's current one. A refused secondary key (the DashPay profile key, a superseded messaging key) is dropped; only the group key decides. The App Connect group trust check must pass, fresh. Then the normal wallet sign-in (`walletSignIn.signIn`), so the key ring lands in this browser's store exactly as a wallet's grant does.
- **Renewal:** when the group key is expired, out of allowance or turned off, the passkey sign-in becomes a wallet sign-in for that identity (the renewal request, identity hint set). Afterwards the passkey's entry names keys that no longer work, so the review offers to update it.

## 5. Contract (contracts/yappr-passkey-vault-contract.json)

One mutable, deletable type, `vaultEntry`, unique index `byCredential [$ownerId, credentialId]` (the per-owner list and the sign-in lookup), `credentialId` and `recipientKey` immutable, `authKeyId` `refersTo identityPublicKey` with purpose authentication. Default config, no moderation, no token cost.

- **Contract-bound keys:** the `refersTo` keyRequirements name only the purpose, so the group-bound key of a wallet sign-in is accepted, and a disabled one is refused at write time. Proven on sakura: the wallet e2e writes and re-seals entries signed by, and naming, the group key.
- **Validated offline** on 5.0.0-rc.3 (wasm-sdk full validation, wasm-dpp2 node rules, meta-schema v3) for testnet and mainnet: ~1,009 B signed without the membership, 1,008 B measured with it (sakura). sha256 `14094cad…73c5`.
- **Byte-array queries:** a `credentialId` operand must be base64; hex silently matches nothing.

## 6. App Connect: sharing a grant between devices

- A passkey holds one grant. Each browser that opens it adopts that grant into its own key ring store, under its own connection id. The grant's limits are on chain, so they are shared: every device spends from the same allowance.
- If the browser that made the grant renews it, the wallet supersedes the old keys. Every other browser using them is signed out ("You were signed out from your Dash wallet") and its next passkey sign-in asks the wallet again. The renewing browser's review offers to update the passkeys, so the next passkey sign-in gets the new keys.
- **Planted entries.** Anyone who once held a live key of the identity (a group key, a HIGH key, or a passkey that opened an entry) can write an entry sealed to their own key, and any group key can delete or overwrite entries. Deletion only costs "add your passkey again". A planted entry is worse: if the user later updates it, their new keys go to the attacker. So the review ticks only this device's passkeys, marks the rest "Another device", says "Tick only the passkeys you recognise" and, after turning Yappr off or changing a key because someone else had access, "remove them all and start over". The removal copy says the same.
- **Reads that lag.** A kept key that is not visible yet, or a budget the node does not report, fails the sign-in or update with "try again" instead of dropping the key.

## 7. Flows and copy

- **Offer** (V4): "Sign in faster with a passkey", once per browser, after a wallet or key sign-in, when the session can keep a passkey and none was added or used here.
- **Add:** the browser's create sheet (PRF evaluated, `excludeCredentials` the owner's existing passkeys), then **Confirm** (a second, user-gestured assertion restricted to the new passkey): seal to the get-time PRF output and refuse if a create-time one differs. No PRF at either step: nothing is written, the provider is told to drop the passkey (`signalUnknownCredential`), and the user reads "This passkey can't be used to sign in to Yappr. Try a passkey saved to iCloud Keychain or Google Password Manager, or keep signing in the way you do now."
- **Sign in:** one discoverable assertion. The user handle is the identity id followed by the vault contract id (64 bytes): every deployment on yap.pr shares the relying party, and providers replace a passkey with the same relying party and user handle, so a /testing passkey must not carry the production handle. A handle for another vault reads "This passkey isn't set up for Yappr here". /staging shares production's contracts and so its passkeys. The credential id names the entry.
- **Update:** the review (§2, V1). Unchecked passkeys that cannot sign in are offered for removal.
- **Remove:** "It won't sign you in to Yappr any more. You can also delete it from your passwords app." The honest part: "If you think someone else has this passkey, also change your key in your Dash wallet (wallet users: turn off Yappr in your Dash wallet): copies saved earlier stay on the network, and only that locks them out." After a removal the provider is told which passkeys still work (`signalAllAcceptedCredentials`).
- **Names** stay in the browser that set them. The chain keeps no label, device or provider, since those would be public forever.

## 8. Fees (sakura, 5.0.0-beta.6 servers, rc.3 client, measured by the e2e)

| Action | Credits | ¢ |
|---|---:|---:|
| Register the contract (with the group membership) | 13,085,062,050 | 785.1 |
| Add a passkey: the identity's first entry (key / wallet) | 46,257,340 / 48,634,740 | 2.78 / 2.92 |
| Add a passkey: a later entry | 37,628,180 | 2.26 |
| Update a passkey (re-seal; key / wallet) | 1,861,020 / 2,056,280 | 0.11 / 0.12 |
| Remove a passkey (refund; key / wallet) | −33,606,783 / −35,596,829 | −2.02 / −2.14 |
| Sign in with a passkey | reads only | 0 |

A wallet session's writes count against its group key's allowance.

## 9. Scope and what is left

- **Mobile native:** out of scope. The engine's key storage and sign-in are unchanged; the vault code only runs where WebAuthn does.
- **Device QA:** a real-device PRF pass (iOS 18.4+ Safari, Android Chrome with Google Password Manager, Windows 11 Hello, 1Password, and Bitwarden for the graceful failure) before the feature is announced.
- **Token actions for moderators:** V2 asks for a wallet QR (dash-st) for token transitions. There is no dash-st path for them after #771; a moderator whose CRITICAL key came from a passkey is asked to type the key, as before.
- **Release wiring:** registering the contract in the release set and setting `NEXT_PUBLIC_YAPPR_PASSKEY_VAULT_CONTRACT_ID` (and adding it to `NEXT_PUBLIC_APP_CONNECT_GROUP_MEMBERS`) in the release env files belongs to the release registration work package.

## 10. Rehearsal on sakura

A throwaway App Connect set, owned by persona corpus:75 (not the devnet maker), carries the e2e:

| | Id |
|---|---|
| Anchor (registers the group) | `BvivHxBzcGVtcLDpmqxuNLrPq6dJqKix5hFPh4Ti8FAd` |
| Group "Yappr vault test" | `5Azy7UPY79fqDj6pNAQGV4PDEDqUpnf2G3kxVZWg63uu` |
| Passkey vault (member) | `DnUfZ42sp58xrTX11eXJtFbcUPqgrvZRraRvGiwHU6aj` |

`e2e/write/passkey-vault.spec.ts` runs against a local `/devnet` build with these pins and the vault id, on Chromium's virtual authenticator with PRF: a key sign-in (persona corpus:76) and a wallet sign-in (persona 92 through the mobile/tools responder) each add a passkey from the offer, sign out, sign back in with the passkey alone, update and remove it; the wallet case also has the wallet turn Yappr off, and the passkey sign-in renews through the wallet and then updates the passkey. `.env.devnet` is unchanged: sakura's real group does not have the vault, and adding a member to it would mean a new devnet set.
