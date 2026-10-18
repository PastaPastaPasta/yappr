import * as Application from 'expo-application';
import Constants from 'expo-constants';

import { VARIANTS, variantForApplicationId, type Network, type Variant } from './variants';

/** The engine bundle this build ships (plugins/engine-assets `engineExtra`). */
export interface EngineBuildConfig {
  bundleHash: string;
  evoSdkVersion: string;
  builtAt: string;
  network: string;
  /** Names the engine's storage namespaces: network, release epoch and deployment; devnet retains `devnet-<name>`. */
  networkKey: string;
  topology: string;
  /** Dev only: read the engine from this URL instead of the app bundle. */
  devUrl?: string;
}

export interface AppConfig {
  variant: Variant;
  network: Network;
  /** The URL scheme this install registers (`yappr-dev`, `yappr-staging`, `yappr-beta`, `yappr`). */
  scheme: string;
  /** The yap.pr path prefix this variant's web links use (`/devnet`, `/staging`, or '' for the root). */
  webBasePath: string;
  /** The deployment owning this build's data, including its path prefix. */
  webBaseUrl: string;
  applicationId: string;
  appVersion: string;
  /** null when the JS bundle was built without a built engine (tests, a fresh clone). */
  engine: EngineBuildConfig | null;
  /** The git commit the bundle was built from (app.config.ts `resolveCommit`), or null. */
  commit: string | null;
}

/**
 * Derives the variant from the native application id, the one thing a
 * JS bundle cannot get wrong, and checks the embedded `extra` agrees. They
 * disagree when the native project and the bundle were built with different
 * APP_VARIANTs (for example a testnet prebuild served by a devnet `expo start`),
 * and an app that talks to the wrong network must not start.
 */
export function resolveAppConfig(
  applicationId: string | null,
  extra: { variant?: unknown; engine?: unknown; commit?: unknown } | undefined,
  appVersion: string | null,
): AppConfig {
  const variant = applicationId ? variantForApplicationId(applicationId) : undefined;
  if (!applicationId || !variant) {
    throw new Error(`Unknown application id "${applicationId}". Expected one of the ADR-001 E6 ids.`);
  }
  if (extra?.variant !== variant) {
    throw new Error(
      `This ${variant} build (${applicationId}) is running a JS bundle built for ` +
        `"${String(extra?.variant)}". Rebuild with APP_VARIANT=${variant}.`,
    );
  }
  const v = VARIANTS[variant];
  return {
    variant,
    network: v.network,
    scheme: v.scheme,
    webBasePath: new URL(v.webBaseUrl).pathname.replace(/\/$/, ''),
    webBaseUrl: v.webBaseUrl,
    applicationId,
    appVersion: appVersion ?? '0.0.0',
    engine: (extra?.engine as EngineBuildConfig | null | undefined) ?? null,
    commit: typeof extra?.commit === 'string' ? extra.commit : null,
  };
}

export const config: AppConfig = resolveAppConfig(
  Application.applicationId,
  Constants.expoConfig?.extra,
  Application.nativeApplicationVersion,
);
