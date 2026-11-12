/**
 * The eight-member release set, in nonce order: anchor, social v19, blocks,
 * DM v5, blog v11, pollr v8, storefront v12 and passkey vault. This is the set
 * selected by default for fresh registrations on every network (D45/D46).
 * The historical 2026-10-21 testnet set keeps social v17. Every member has its deployment env key.
 *
 * The v18/v10/v11 re-cuts belong only to the testnet /beta rehearsal group.
 * Its eleven-entry plan keeps the eight historical members (with the old
 * elected cuts marked replaced) before appending the three experimental cuts.
 * Memberships can never be removed: never append those cuts to the release
 * group. Only `--testnet-set rehearsal` selects that separate plan.
 */
const REGISTERED_TESTNET_MAKER = 'hbGEcFcXKJ2W9Di24ekiozTWfFszrjqkxbjfEep3D8A';

const APP_CONNECT_ENTRIES = [
  { name: 'app', file: 'yappr-app-contract.json', envKey: 'NEXT_PUBLIC_APP_CONNECT_APP_ID', sha256: 'd3acd888168f6ee074d2eb7f73442917b255aa0be3b6417698d637844ce41f41' },
  { name: 'social', file: 'yappr-social-contract-v19.json', envKey: 'NEXT_PUBLIC_YAPPR_CONTRACT_ID', sha256: 'bae9bd60f16b917f39309a8ca2dcc495687ec35174fa9caa08a8b0311e318971' },
  { name: 'blocks', file: 'yappr-blocks-contract.json', envKey: 'NEXT_PUBLIC_YAPPR_BLOCKS_CONTRACT_ID', sha256: 'ba0ef67a458cae5c702612a096a6b71fb0098fa370b3861da6da735dd80d3677' },
  { name: 'dmV5', file: 'yappr-dm-contract-v5.json', envKey: 'NEXT_PUBLIC_YAPPR_DM_V5_CONTRACT_ID', sha256: '4fe2b3f46447d8aff30efcafc0e6235bee97724e34e7c96130951a59b0037c21' },
  { name: 'blog', file: 'yappr-blog-contract-v11.json', envKey: 'NEXT_PUBLIC_YAPPR_BLOG_CONTRACT_ID', sha256: 'd1a53c31803a2f6f057700b358755b4d927318bfdcd5d2cb5b6718e8942dca6c' },
  { name: 'pollr', file: 'pollr-contract.json', envKey: 'NEXT_PUBLIC_POLLR_CONTRACT_ID', sha256: 'a77afe5f27ad97d80e530551bbd5561ab02b1c622698b1a583a4893b03bd2347' },
  { name: 'storefront', file: 'yappr-storefront-contract-v12.json', envKey: 'NEXT_PUBLIC_YAPPR_STOREFRONT_CONTRACT_ID', sha256: '873dc5c665c78cbd8390de181d4bb373068d042a405c002620e123b24df0f214' },
  // The passkey vault (docs/PASSKEY_VAULT.md). A member so a wallet sign-in's group key can write its own vault entries.
  { name: 'passkeyVault', file: 'yappr-passkey-vault-contract.json', envKey: 'NEXT_PUBLIC_YAPPR_PASSKEY_VAULT_CONTRACT_ID', sha256: '14094cadcaf6c9b575fcb97ea53b769c5b0d88cfa99b3c5c827da0ab176f73c5' },
];

module.exports = { APP_CONNECT_ENTRIES, REGISTERED_TESTNET_MAKER };
