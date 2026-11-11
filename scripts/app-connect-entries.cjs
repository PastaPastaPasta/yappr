/**
 * The eight-member release set, in nonce order: anchor, social v17, blocks,
 * DM v5, blog v9, pollr v8, storefront v10 and passkey vault. This is the set
 * registered on testnet on 2026-10-21 and selected by default on every network
 * for the mainnet release (D45). Every member has its deployment env key.
 *
 * The v18/v10/v11 re-cuts belong only to the testnet /beta rehearsal group.
 * Its eleven-entry plan keeps the eight historical members (with the old
 * elected cuts marked replaced) before appending the three experimental cuts.
 * Memberships can never be removed: never append those cuts to the release
 * group. Only `--testnet-set rehearsal` selects that separate plan.
 */
const APP_CONNECT_ENTRIES = [
  { name: 'app', file: 'yappr-app-contract.json', envKey: 'NEXT_PUBLIC_APP_CONNECT_APP_ID', sha256: 'd3acd888168f6ee074d2eb7f73442917b255aa0be3b6417698d637844ce41f41' },
  { name: 'social', file: 'yappr-social-contract-v17.json', envKey: 'NEXT_PUBLIC_YAPPR_CONTRACT_ID', sha256: '2e41bbb32317433bf5aeb1ad8179d6d264277b85dbd9f2f9a5e66ffb1bd378b2' },
  { name: 'blocks', file: 'yappr-blocks-contract.json', envKey: 'NEXT_PUBLIC_YAPPR_BLOCKS_CONTRACT_ID', sha256: 'ba0ef67a458cae5c702612a096a6b71fb0098fa370b3861da6da735dd80d3677' },
  { name: 'dmV5', file: 'yappr-dm-contract-v5.json', envKey: 'NEXT_PUBLIC_YAPPR_DM_V5_CONTRACT_ID', sha256: '4fe2b3f46447d8aff30efcafc0e6235bee97724e34e7c96130951a59b0037c21' },
  { name: 'blog', file: 'yappr-blog-contract.json', envKey: 'NEXT_PUBLIC_YAPPR_BLOG_CONTRACT_ID', sha256: '448fb9ea4a9b6b4f4c0e0224dfe5ba610514d18793b6927255f3a7c67631504c' },
  { name: 'pollr', file: 'pollr-contract.json', envKey: 'NEXT_PUBLIC_POLLR_CONTRACT_ID', sha256: 'a77afe5f27ad97d80e530551bbd5561ab02b1c622698b1a583a4893b03bd2347' },
  { name: 'storefront', file: 'yappr-storefront-contract.json', envKey: 'NEXT_PUBLIC_YAPPR_STOREFRONT_CONTRACT_ID', sha256: '69daf9799cb4f34552e4fce3ec7963a66f6f492f37d45baee4f6c83880bf05dc' },
  // The passkey vault (docs/PASSKEY_VAULT.md). A member so a wallet sign-in's group key can write its own vault entries.
  { name: 'passkeyVault', file: 'yappr-passkey-vault-contract.json', envKey: 'NEXT_PUBLIC_YAPPR_PASSKEY_VAULT_CONTRACT_ID', sha256: '14094cadcaf6c9b575fcb97ea53b769c5b0d88cfa99b3c5c827da0ab176f73c5' },
];

module.exports = { APP_CONNECT_ENTRIES };
