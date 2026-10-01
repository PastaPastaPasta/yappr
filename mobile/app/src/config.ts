import * as Application from 'expo-application';
import Constants from 'expo-constants';

import { VARIANTS, variantForApplicationId, type Network, type Variant } from './variants';

export interface AppConfig {
  variant: Variant;
  network: Network;
  /** The URL scheme this install registers (`yappr-dev`, `yappr-beta`, `yappr`). */
  scheme: string;
  applicationId: string;
  appVersion: string;
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
  extra: { variant?: unknown } | undefined,
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
    applicationId,
    appVersion: appVersion ?? '0.0.0',
  };
}

export const config: AppConfig = resolveAppConfig(
  Application.applicationId,
  Constants.expoConfig?.extra,
  Application.nativeApplicationVersion,
);
