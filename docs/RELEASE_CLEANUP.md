# Pre-cut-over cleanup (WP17)

Verified against staging `e92b310e` on 2026-10-17. This cleanup preserves the
current production default build and Sakura `/devnet` until WP15 switches the
release environment. D9 and D21/D22 apply to the release, not to today's defaults.
No testnet or mainnet writes are part of this work.

## Removed now

- Four unreferenced contract JSONs: `yappr-block-contract.json`,
  `yappr-hashtag-contract.json`, `yappr-mention-contract.json`, and
  `yappr-minimal.json`. No build, script, or test imports or opens these files;
  the early standalone types were folded into social, and the last was a
  scratch schema. The separate **plural** `yappr-blocks-contract.json` stays.
- `scripts/verify-v8.mjs` (v9-only battery) and
  `scripts/verify-refersto.mjs` (v3-draft/scratch reference experiment).
  `scripts/verify-v10.mjs` covers the supported v10–v17 social cuts and their
  reference rules. Historical experiment results remain in the archived docs.
- Five unused script helper exports exposed by narrowing knip's script roots.
  CLI tools, script tests, and the browser benchmark remain explicit roots;
  imported helper modules are traversed rather than treated as entry points.
- `getUserStats`, which asynchronously overwrote profile follow counts with
  zeros. Follow counts remain the follow service's responsibility.
- `TipResult.transactionHash` and all three literal `'confirmed'` values. No
  caller reads that field; success/error results retain their existing meaning.
- The stale knip Ajv ignore. The validator now imports `ajv/dist/2020`, so Ajv
  is declared directly as a dev dependency instead of relying on a transitive
  installation or silently skipping the meta-schema check.

## Deferred to WP15 / the cut-over cleanup

| Item | Evidence and reason to retain it now |
| --- | --- |
| DM v3/v4 service, web/mobile legacy UI and merged legacy conversations (R-C2) | `DM_TOPOLOGY` still defaults to `v3`, with the current production DM id. The testnet mobile engine uses those same defaults. Remove once every shipping build explicitly uses DM v5. |
| YAPP purchases, token-tip branch, and their builders/services (R-C3) | The production social default is `v2`; `yappIsLocked()` is false there. These are still live product paths, although v16/devnet and v17/release lock YAPP. `set-yapp-price.mjs` is already absent. |
| Mobile key-exchange engine/screens, Maestro `10-sign-in-wallet`, controller methods, `NEXT_PUBLIC_LOGIN_PROTOCOL` legacy branch (R-C5) | Production web (master's root) and `/testing` still default to legacy sign-in. Builds that load `.env.testnet`, `.env.devnet` or `.env.beta` set `NEXT_PUBLIC_LOGIN_PROTOCOL=app-connect`, and so do the native `testnet` and `staging-testnet` variants ([TESTNET_DEPLOY.md](TESTNET_DEPLOY.md)), so `/devnet` is not the only App Connect build. Keep #612 open until its key-registration path is removed or corrected. |
| Token-authority fallback (R-C6) | Production v2 still needs its current token-authority gate; `.env.devnet` already supplies its own authority. Remove the default only with explicit production configuration; v17 gives all manual token authorities to `noOne`. |
| Other social/feature JSONs and generic registration tools (R-C4/R-C7) | They still have build, test, script, or retired-contract manifest references. Do not prune by age alone. Keep v2 for production and v16 for `/devnet`; the release set is v17 / blog v9 / storefront v10 / pollr v8 / DM v5. |
| `/testing` contract registration and complete environment | Owned by WP13/WP15. Its current social/profile overrides still use v2 defaults for other features. Smoke tests are read-only; no write suite is authorised here. |

## Other lanes and already-fixed items

- Private-feed implementation, its specification/link, and passkey-vault code
  (PR #786) are deliberately untouched. Their rewrites own any overlapping
  legacy-secret or contract work.
- `/login` already says “Moderated in the open”, alongside “You hold your keys”
  and “Chronological or ranked feeds”; the censorship-resistance tagline is
  already gone.
- `DIGITAL_PRODUCTS.md` already documents store/listing/review takedowns and
  elected storefront moderation after WP8; preserve that corrected behavior.
- #261 is obsolete: all three Platform SDK packages already pin 5.0.0-rc.3.
  #564 still calls for a deliberate write-pipeline change: rc.3's
  `sdk.documents.create()` derives nonce-committed ids, while Yappr still
  assembles batches manually. `lib/document-id.ts` already delegates hashing
  to wasm; its nonce allocation and pending-write settlement are still used.
  Replacing that pipeline is separate from deleting a stale JS hash implementation.
