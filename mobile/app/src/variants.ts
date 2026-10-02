/**
 * Build variants (ADR-001 E6). Shared by app.config.ts (build time, Node) and
 * src/config.ts (run time), so it must stay free of React Native imports.
 *
 * Each variant registers only its own URL scheme, so side-by-side installs
 * never compete for a link (or a wallet's sign-in callback). `webBasePath` is
 * the yap.pr prefix whose links (universal links / App Links) the variant
 * claims (UX_SPEC §3.5).
 */
export const VARIANTS = {
  devnet: {
    name: 'Yappr Dev',
    applicationId: 'pr.yap.app.dev',
    scheme: 'yappr-dev',
    webBasePath: '/devnet',
    network: 'devnet',
  },
  testnet: {
    name: 'Yappr Beta',
    applicationId: 'pr.yap.app.beta',
    scheme: 'yappr-beta',
    webBasePath: '',
    network: 'testnet',
  },
  production: {
    name: 'Yappr',
    applicationId: 'pr.yap.app',
    scheme: 'yappr',
    // TODO(launch): yap.pr's root serves testnet today, so production share links would open the
    // wrong network. Point this at the mainnet deployment's prefix before production ships.
    webBasePath: '',
    network: 'mainnet',
  },
} as const;

export type Variant = keyof typeof VARIANTS;
export type Network = (typeof VARIANTS)[Variant]['network'];

export function isVariant(value: string): value is Variant {
  return Object.hasOwn(VARIANTS, value);
}

/** The variant whose bundle id / application id is `applicationId`, if any. */
export function variantForApplicationId(applicationId: string): Variant | undefined {
  return (Object.keys(VARIANTS) as Variant[]).find(
    (v) => VARIANTS[v].applicationId === applicationId,
  );
}
