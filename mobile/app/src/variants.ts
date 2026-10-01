/**
 * Build variants (ADR-001 E6). Shared by app.config.ts (build time, Node) and
 * src/config.ts (run time), so it must stay free of React Native imports.
 *
 * Each variant registers only its own URL scheme, so side-by-side installs
 * never compete for a link (or a wallet's sign-in callback).
 */
export const VARIANTS = {
  devnet: {
    name: 'Yappr Dev',
    applicationId: 'pr.yap.app.dev',
    scheme: 'yappr-dev',
    network: 'devnet',
  },
  testnet: {
    name: 'Yappr Beta',
    applicationId: 'pr.yap.app.beta',
    scheme: 'yappr-beta',
    network: 'testnet',
  },
  production: {
    name: 'Yappr',
    applicationId: 'pr.yap.app',
    scheme: 'yappr',
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
