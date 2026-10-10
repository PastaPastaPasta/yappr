# Social v15, the Platform 5.0.0-beta.4 re-cut

Social v15 is social v14 ([SOCIAL_V14.md](SOCIAL_V14.md)) re-cut for Platform 5.0.0-beta.4. Beta.4 adds the non-transferable token flag that v14 had to do without, so YAPP becomes what Yappr always meant it to be: an in-app token that can pay for posts, replies and likes but can never move between identities. v15 also writes its byte arrays with beta.4's property type shorthands, which Platform stores in their short form.

This document was written with the PR that adds the contract, the client topology `v15`, the tooling and the batteries. **v15 is not registered anywhere yet.** `/devnet` keeps running v14 until sakura runs beta.4 and a separate cut-over PR registers v15 there and switches `.env.devnet` (see [Registering it](#registering-it)). It needs the 5.0.0-beta.4 SDK: the beta.3 SDK cannot parse a shorthand or a version 1 token configuration.

| # | Decision | What changes |
| --- | --- | --- |
| 1 | **YAPP is not transferable** | `tokens["0"]`: `$formatVersion: "1"` and `transferable: false`. Every transfer of YAPP is refused (40726). |
| 2 | **YAPP costs burn** | `"effect": 1` on the four token costs (post 10, reply 3, like 1, likeReply 1). Each stays `optional: true` with sponsored gas (`gasFeesPaidBy: 2`). |
| 3 | **No base supply** | `baseSupply: 0` (v14: 1,000,000). The contract owner would hold a balance it could never send, so nobody gets one; the owner can still mint. |
| 4 | **YAPP stays unpaused** | `startAsPaused: false`, with `emergencyActionRules` still `noOne`. Nobody can ever pause it. |
| 5 | **Shorthands** | Every 32-byte identifier is `{"type": "identifier"}` and every other fixed-size byte array is `{"type": "bytes", "size": n}`. Platform expands them before validating and parses the contract exactly as the long form. |
| 6 | **Everything else is v14's** | Document types, properties, indexes, rules, `deleteConstraints`, action fees, moderation and the blocks contract. |

No byte rules (`byteAt`, byte-array `startsWith`/`endsWith`, also new in beta.4) are used. Every candidate measured cost more bytes than it was worth: a `report.box` shape check +192 B, `mediaKinds` values +372 B, a public-key prefix +77 to +89 B.

## The file

| | Social v15 |
| --- | --- |
| File | `contracts/yappr-social-contract-v15.json` |
| sha256 | `d2e729005ce68688a7663c605efa37f979321d0b0a5e5c417fd03b12ce179859` |
| Serialized (beta.4 rs-dpp) | 16,182 B (v14: 17,868 B) |
| Signed create | **16,290 B** (v14: 17,976 B): 1,686 B smaller, 3,710 B under the 20,000 B budget. The validator's estimate is ~16,289 B. Mainnet's rendering (interim `notYetUsable`) is the same size. |
| Document types | 12, as v14 |
| Parses | `validate-contract-offline.mjs --network mainnet --cost --strict-size` on the 5.0.0-beta.4 wasm-sdk and wasm-dpp2 (full validation, meta-schema, node-rule audit): OK. Also rs-dpp at beta.4 with full validation (`b4val`), which reads the token back as `transferable=false`. |

Almost all of the 1,686 B saving comes from the shorthands. The token changes add a few bytes (the format version and the flag) and take back the base supply's.

## The diff against v14

| | v14 | v15 |
| --- | --- | --- |
| `tokens["0"]` | token configuration v0 (no transfer flag), `baseSupply: 1000000` | **`$formatVersion: "1"`, `transferable: false`, `baseSupply: 0`**. Every other rule is unchanged: unpaused and unpausable, unpriced (`changeDirectPurchasePricingRules: noOne`), the owner mints to any destination, the owner freezes, a 100-YAPP grant once per identity, and the full token history. |
| `tokenCost.create` on post, reply, like, likeReply | pays the contract owner (`effect` absent, so 0) | **`effect: 1`**, so the cost is burned |
| Every 32-byte identifier | `{"type": "array", "byteArray": true, "minItems": 32, "maxItems": 32, "contentMediaType": "application/x.dash.dpp.identifier"}` | `{"type": "identifier"}` |
| Every other fixed-size byte array | `{"type": "array", "byteArray": true, "minItems": n, "maxItems": n}` | `{"type": "bytes", "size": n}` |

Variable-size byte arrays (ciphertext, `mediaDigests`, the report `box`) keep the long form, because the shorthands only cover a fixed size. `lib/contract-topology.test.ts` checks that v15's schemas, with the shorthands written out and the cost effects removed, equal v14's.

## Why

### A token that cannot move

Beta.3 had no way to make a token non-transferable, so v14's YAPP was unpaused to keep its token costs payable, and was therefore transferable on chain. Yappr just never offered a transfer ([SOCIAL_V14.md §1](SOCIAL_V14.md#1-yapp-unpaused)). Beta.4's token configuration v1 adds `transferable`. With it set to `false`, these are all refused with `TokenNotTransferableError` (40726):

- a token transfer, from anyone, including the contract owner;
- a document of **another** contract that charges YAPP as its token cost;
- a token cost of this contract that pays the contract owner.

That last case is why the costs burn. Platform refuses to register a non-transferable token whose document cost pays the owner (`NonTransferableTokenPaymentMustBurnError`, 10280), because the payment would itself be a transfer. A non-transferable token also cannot have its own shielded pool (`NonTransferableTokenShieldedPoolError`, 10279), and v15 declares none.

These still work: the once-per-identity grant (a claim, not a transfer), the owner minting to any identity, freezing, sponsored gas on a cost, and spending YAPP on Yappr's own posts, replies and likes.

### Burn, and no base supply

With burning costs, nothing flows back to the contract owner, so a base supply would be 1,000,000 YAPP stuck with the owner for good. It could not send any of it, and the owner identity has no reason to post with it. v15 starts with no supply instead. Every YAPP comes from the starter grant or from an owner mint, and every YAPP spent leaves circulation.

## Product consequences

- **YAPP spends burn.** Posting (10), replying (3) and liking (1) in YAPP destroys the YAPP. The contract owner receives none of it, and the total supply shrinks with use. Network fees (gas) are still sponsored by the owner when its credits allow (`gasFeesPaidBy: 2`), as on v14.
- **YAPP can't move between identities.** No tips in YAPP, no gifting, no moving a balance to a new identity. A user's YAPP stays with the identity that claimed or was minted it. Tips stay credit tips, as on v10–v14.
- **YAPP is social-only.** Another contract (storefront, blog, a third-party app) cannot charge YAPP: Platform refuses that payment with 40726. None of Yappr's other contracts charge YAPP today.
- **No pause switch.** As on v14, nobody can pause YAPP (`emergencyActionRules: noOne`). An incident can't be stopped by pausing the token; the owner can still freeze an identity's balance.
- **It's permanent.** The flag, the cost effects and the emergency rules can't be changed for this token. Changing them means a new contract.

## Client: topology `v15`

`NEXT_PUBLIC_CONTRACT_TOPOLOGY=v15` with `NEXT_PUBLIC_YAPPR_CONTRACT_ID` and `NEXT_PUBLIC_YAPPR_BLOCKS_CONTRACT_ID`, as on v14. The descriptor is v14's. YAPP is read off the committed JSON:

- `yappIsTransferable()` (new) is `tokens["0"].transferable !== false`: false on v15, true on every earlier cut (none has the flag).
- `yappIsLocked()` is true whenever YAPP is not transferable, as well as on the v10–v14 rule (nobody may price it or change its pause state). On v15 that means no Buy YAPP, no YAPP tab in the tip dialog, credit tips only, and `tokenService.transfer` refusing before it signs. The mobile engine's `yappLocked` capability reads the same predicate.
- `buildUnsignedYappTipTransition` (the wallet-signed YAPP tip) refuses to build a transfer where YAPP isn't transferable, so a wallet is never handed a transition the chain would refuse after the nonce is spent.
- `yappIsPausedForGood()` is false, as on v14: posts, replies and likes may pay YAPP when the user chooses it and the balance covers it, and the starter grant is offered as on v14.
- `isTokenNotTransferableError` (40726) is a permanent refusal. `categorizeError` words it "YAPP can't be sent to other accounts or spent outside Yappr." Yappr never builds such a write, so this only shows if something slips past the checks above.

Both v14 and v15 work in one build. `.env.devnet` stays on v14 until the cut-over.

## Shorthands in every contract

The other repo contracts are rewritten with the shorthands in place, so each is registered in short form at its next registration. The deployed copies stay as they are, because a registered contract is never rewritten. Each file was checked with rs-dpp at beta.4: full validation passes, and the parsed document types and indexes are identical to the long form (`b4val --same`).

| File | Signed create (beta.4) | Saved |
| --- | ---: | ---: |
| `yappr-storefront-contract.json` (v7) | 16,606 B | 1,163 B |
| `yappr-blog-contract.json` (v7) | 6,756 B | 255 B |
| `yappr-dm-contract-v5.json` | 3,559 B | 116 B |
| `yappr-dm-contract.json` (v4) | 2,538 B | 201 B |
| `pollr-contract.json` (v6) | 4,173 B | 85 B |
| `yappr-blocks-contract.json` | 1,260 B | 170 B |
| `key-exchange-v2.json` | 1,288 B | 172 B |
| `yappr-auth-vault-contract.json` | 2,031 B | 203 B |
| `yappr-vault-contract.json` | 691 B | 29 B |
| `encrypted-key-backup-contract.json` | 1,012 B | 0 (no fixed-size byte array; the key rename only) |

The vault, auth-vault and key-backup files also rename their legacy `mutable` key to `documentsMutable`. Meta-schema v3 refuses `mutable` (10101), and the parse without validation ignores it, which is why devnets published these three from the testnet snapshot. With the rename they pass full validation, so they can be published from the repo. On a parse that ignored the old key, the rename does change one thing: `encryptedKeyBackup` becomes immutable, as its file always intended. The client only creates and deletes backups, and never replaces one. The historical social files (v2, v9–v14) are left as they are.

## Tooling

- **`scripts/schema-shorthands.mjs`** (new): `expandShorthands` / `expandSchemas`, a port of rs-dpp's `expand_property_type_shorthands`. Every script that reads a schema's shape goes through it: `metaSchemaProblems` and `auditNodeRules` (the node expands before its meta-schema runs), `social-shapes.mjs`, the `verify-v10.mjs` self-test, `battery-moderation.mjs`, `verify-storefront.mjs` and `verify-dm-v5.mjs`.
- **Meta-schema**: `scripts/meta-schema/document-meta-v3.json` is beta.4's (it adds `byteAt` and byte-array `startsWith`/`endsWith`, and documents that shorthands are expanded before it runs), pinned by sha256.
- **`scripts/contract-probes.mjs`** (`--probes`), v15: controls (devnet and mainnet renderings). The parsed token reads back `transferable: false` with no shielded pool, unpaused, unpriced and with no base supply, and every cost burns. These are refused: a cost paying the owner (`effect: 0`) or one with no effect (both 10280, refused by wasm-dpp2 and flagged by the audit), and a shielded pool on the non-transferable YAPP (10279, which only the node checks). `auditNodeRules` now carries both rules (`auditNonTransferableTokens`). A control shows that a transferable YAPP may pay the owner again.
- **`scripts/property-constraint-cases.mjs`**: v15 declares v14's rules, write cases and delete cases.
- **Batteries**: `verify-v10.mjs --contract-file contracts/yappr-social-contract-v15.json` refuses y1a's YAPP transfer (40726). After y1d's YAPP-paid post, the contract owner's YAPP balance is unchanged (y1j) and the total supply fell by exactly the cost (y1k). The self-test pins `transferable: false`, `baseSupply: 0` and `effect: 1`. `verify-tips.mjs` treats a non-transferable YAPP as locked (credit tips), and the tips seeder (`scripts/seed/non-social/tips.mjs`) reads the deployed token and skips YAPP tips when it isn't transferable. The seeder writes v15 (`SEEDED_TOPOLOGIES`).

### Validation done for this PR

On the 5.0.0-beta.4 SDK:

- `validate-contract-offline.mjs contracts/yappr-social-contract-v15.json --network mainnet --cost --strict-size`: OK, ~16,289 B signed, meta-schema clean, no node-rule problem. Every per-write fee is identical to v14's.
- `validate-contract-offline.mjs` on each shorthand contract: OK.
- `--probes`: every probe and `where` case behaves as recorded, the v15 ones included.
- `--constraints`: every case of every file behaves as recorded, v15's included.
- The `--self-test` of `social-shapes.mjs` and `verify-v10.mjs` (v14 and v15), and of the storefront, blog, DM, pollr and tips batteries: pass.
- rs-dpp at beta.4 (`b4val`): full validation of every changed file, and `--same` against each long-form original.

## Registering it

Not in this PR: nothing is registered, and `.env.devnet` is unchanged. Once sakura runs beta.4, the cut-over PR registers v15 from the merged file, pinned to the sha256 above. It uses the maker, joins the `/devnet` contract group, and takes the maker's next identity nonce (13 after storefront v7 at 12). It goes through the sakura ops publisher that registered v14 and storefront v7 (`ops/publish-beta3.mjs` in the sakura ops directory: add the file as a held entry with its sha, then `--dry-run`, `--signed-dry-run`, and `--live --release`), running on the beta.4 SDK. `scripts/register-social-v3-draft.mjs --maker --contract-file yappr-social-contract-v15.json` can also register it (try it with `--dry-run` first), but without the contract group membership. After it is registered:

1. Mint YAPP to the battery bots, since nobody starts with a balance (`register-social-v3-draft.mjs --fund-only <id> --fund <ids>`).
2. Run `verify-v10.mjs --contract <id> --contract-file contracts/yappr-social-contract-v15.json`, `prove-merged-counts.mjs` and `verify-tips.mjs`.
3. Re-snapshot `lib/contracts/bundled/devnet-sakura.json`.
4. Set `NEXT_PUBLIC_CONTRACT_TOPOLOGY=v15` and the new id in `.env.devnet`.

The other contracts move to their short form whenever they are next registered.
