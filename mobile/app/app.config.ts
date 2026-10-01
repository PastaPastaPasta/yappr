import type { ConfigContext, ExpoConfig } from 'expo/config';

import { engineExtra } from './plugins/engine-assets';
import { isVariant, VARIANTS, type Variant } from './src/variants.ts';

/**
 * APP_VARIANT picks the build variant at prebuild/start/export time; the
 * default is devnet so agents and local builds never point at production by
 * accident. The app re-derives the variant at run time from its native
 * application id (src/config.ts) and refuses to start if the two disagree.
 *
 *   APP_VARIANT=testnet npm run prebuild
 */
function resolveVariant(raw: string | undefined): Variant {
  const value = raw ?? 'devnet';
  if (!isVariant(value)) {
    throw new Error(
      `Unknown APP_VARIANT "${value}". Expected one of: ${Object.keys(VARIANTS).join(', ')}.`,
    );
  }
  // Mainnet needs the Rust engine (ADR-001 E1/E6); keep it from being built by accident.
  if (value === 'production' && process.env.YAPPR_ALLOW_PRODUCTION !== '1') {
    throw new Error('APP_VARIANT=production is not buildable yet. Set YAPPR_ALLOW_PRODUCTION=1 to override.');
  }
  return value;
}

// The icon's own background, so the splash and adaptive icon blend with it.
const ICON_BACKGROUND = '#1088d2';

export default ({ config }: ConfigContext): ExpoConfig => {
  const variant = resolveVariant(process.env.APP_VARIANT);
  const v = VARIANTS[variant];

  return {
    ...config,
    name: v.name,
    slug: 'yappr',
    version: '1.0.0',
    orientation: 'portrait',
    icon: './assets/images/icon.png',
    scheme: v.scheme,
    userInterfaceStyle: 'automatic',
    ios: {
      bundleIdentifier: v.applicationId,
      supportsTablet: false,
    },
    android: {
      package: v.applicationId,
      adaptiveIcon: {
        foregroundImage: './assets/images/icon.png',
        backgroundColor: ICON_BACKGROUND,
      },
      predictiveBackGestureEnabled: false,
    },
    plugins: [
      'expo-router',
      'expo-secure-store',
      'expo-web-browser',
      [
        'expo-local-authentication',
        { faceIDPermission: 'Allow Yappr to use Face ID to unlock your accounts.' },
      ],
      ['./plugins/engine-assets', { variant }],
      [
        'expo-splash-screen',
        {
          image: './assets/images/icon.png',
          imageWidth: 160,
          backgroundColor: ICON_BACKGROUND,
        },
      ],
    ],
    experiments: {
      typedRoutes: true,
      reactCompiler: true,
    },
    extra: {
      variant,
      network: v.network,
      engine: engineExtra(variant),
    },
  };
};
