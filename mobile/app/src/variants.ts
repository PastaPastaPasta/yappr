/**
 * Build variants (ADR-001 E6). Shared by app.config.ts (build time, Node) and
 * src/config.ts (run time), so it must stay free of React Native imports.
 *
 * Each variant registers only its own URL scheme, so side-by-side installs
 * never compete for a link (or a wallet's sign-in callback). `webBaseUrl` includes
 * the yap.pr prefix whose links (universal links / App Links) the variant
 * claims (UX_SPEC §3.5).
 */
export const VARIANTS = {
  devnet: {
    name: 'Yappr Dev',
    applicationId: 'pr.yap.app.dev',
    scheme: 'yappr-dev',
    webBaseUrl: 'https://yap.pr/devnet',
    network: 'devnet',
  },
  'staging-testnet': {
    name: 'Yappr Staging',
    applicationId: 'pr.yap.app.staging',
    scheme: 'yappr-staging',
    webBaseUrl: 'https://yap.pr/staging',
    network: 'testnet',
  },
  testnet: {
    name: 'Yappr Beta',
    applicationId: 'pr.yap.app.beta',
    scheme: 'yappr-beta',
    webBaseUrl: 'https://yap.pr',
    network: 'testnet',
  },
  production: {
    name: 'Yappr',
    applicationId: 'pr.yap.app',
    scheme: 'yappr',
    // Mainnet must own this deployment before production ships.
    webBaseUrl: 'https://yap.pr',
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

/** The one variant whose iOS bundle id YAPPR_IOS_BUNDLE_ID may replace (the Yappr Beta record). */
export const IOS_BUNDLE_ID_OVERRIDE_VARIANT: Variant = 'testnet';

/**
 * The iOS bundle id a build is signed for: the variant's own id, or, for the
 * testnet variant only, YAPPR_IOS_BUNDLE_ID when its App Store record lives
 * under another id (mobile/RELEASE.md, TestFlight). Android always keeps the
 * variant's id. Limiting the override to one variant lets src/config.ts tell
 * the variant from the native id alone. iOS bundle ids are case-insensitive, so
 * a reserved id in any case is refused.
 */
export function resolveIosBundleId(variant: Variant, override: string | undefined): string {
  if (override === undefined || override === '') return VARIANTS[variant].applicationId;
  if (variant !== IOS_BUNDLE_ID_OVERRIDE_VARIANT) {
    throw new Error(`YAPPR_IOS_BUNDLE_ID applies to the ${IOS_BUNDLE_ID_OVERRIDE_VARIANT} variant only, not ${variant}.`);
  }
  if (!/^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z0-9][A-Za-z0-9-]*)+$/.test(override)) {
    throw new Error(`YAPPR_IOS_BUNDLE_ID must be a reverse-DNS bundle id, got "${override}".`);
  }
  const reserved = (Object.keys(VARIANTS) as Variant[]).find(
    (v) => v !== variant && VARIANTS[v].applicationId.toLowerCase() === override.toLowerCase(),
  );
  if (reserved) {
    throw new Error(`YAPPR_IOS_BUNDLE_ID "${override}" is the ${reserved} variant's id, not ${variant}'s.`);
  }
  return override;
}
