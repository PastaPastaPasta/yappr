import { execFileSync } from 'child_process';
import type { ConfigContext, ExpoConfig } from 'expo/config';

import pkg from './package.json';
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

/**
 * The store build number: iOS `CFBundleVersion` and Android `versionCode`.
 * Both stores need it to grow with every upload, so CI sets
 * YAPPR_BUILD_NUMBER from its run counter; local builds default to 1. The
 * user-facing version is `version` in package.json.
 */
export function resolveBuildNumber(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 1;
  const value = Number(raw);
  // Google Play's versionCode ceiling.
  if (!/^\d+$/.test(raw) || value < 1 || value > 2_100_000_000) {
    throw new Error(`YAPPR_BUILD_NUMBER must be an integer from 1 to 2100000000, got "${raw}".`);
  }
  return value;
}

/**
 * The commit the app is built from, for About (PRD SET-06). Baked into
 * `extra` when the config is read (prebuild, start, export), never fetched:
 * YAPPR_COMMIT when CI sets it, EAS's EAS_BUILD_GIT_COMMIT_HASH on EAS, else
 * this checkout's HEAD. Null outside a git checkout.
 */
export function resolveCommit(env: Record<string, string | undefined> = process.env): string | null {
  const isSha = (value: string | undefined): value is string => !!value && /^[0-9a-f]{7,40}$/i.test(value);
  const fromEnv = [env.YAPPR_COMMIT, env.EAS_BUILD_GIT_COMMIT_HASH].find(isSha);
  if (fromEnv) return fromEnv.toLowerCase();
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return isSha(head) ? head : null;
  } catch {
    return null;
  }
}

// The fox icon's own background (#0f87cf), so the splash and adaptive icon blend with it.
const ICON_BACKGROUND = '#0f87cf';
/** The app's dark page surface (`colors.neutral900` in src/ui/tokens.ts). */
const DARK_BACKGROUND = '#171717';

/**
 * Apple's required-reason APIs (C9). The app collects nothing and tracks
 * nothing (ADR-001: no analytics or crash SDKs); the reasons are React
 * Native's and Expo's own uses, for data on the device only. SDK 57 links
 * some Expo modules as precompiled frameworks whose privacy bundles are
 * empty, so their reasons (expo-file-system's disk space) are declared here.
 */
const PRIVACY_MANIFEST = {
  NSPrivacyTracking: false,
  NSPrivacyTrackingDomains: [],
  NSPrivacyCollectedDataTypes: [],
  NSPrivacyAccessedAPITypes: [
    // App-own preferences (React Native, Expo modules).
    { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryUserDefaults', NSPrivacyAccessedAPITypeReasons: ['CA92.1'] },
    // Timestamps of files inside the app container (caches, MMKV, the engine bundle).
    { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryFileTimestamp', NSPrivacyAccessedAPITypeReasons: ['C617.1'] },
    // Elapsed time for timers and performance marks (React Native).
    { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategorySystemBootTime', NSPrivacyAccessedAPITypeReasons: ['35F9.1'] },
    // Free space checked before writing files (expo-file-system).
    { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryDiskSpace', NSPrivacyAccessedAPITypeReasons: ['E174.1'] },
  ],
};

/**
 * Permissions that Expo's template or a library's manifest adds and the app
 * never uses. Removed from the merged manifest (`tools:node="remove"`).
 */
const BLOCKED_ANDROID_PERMISSIONS = [
  'android.permission.READ_EXTERNAL_STORAGE',
  'android.permission.WRITE_EXTERNAL_STORAGE',
  'android.permission.READ_MEDIA_IMAGES',
  'android.permission.READ_MEDIA_VIDEO',
  'android.permission.READ_MEDIA_AUDIO',
  'android.permission.SYSTEM_ALERT_WINDOW',
  'android.permission.RECORD_AUDIO',
  'android.permission.CAMERA',
  // Play install referrer, bundled by expo-application; the app never reads it.
  'com.google.android.finsky.permission.BIND_GET_INSTALL_REFERRER_SERVICE',
];

/**
 * Release builds (scripts/release-ios.sh and the EAS store profiles set
 * YAPPR_RELEASE=1) drop the template's `NSAllowsLocalNetworking`: it lets
 * cleartext http:// load from `.local` and unqualified hosts, which only the
 * dev client needs (Metro and the dev launcher on the LAN). The Info.plist
 * merge is shallow, so this replaces the whole ATS dictionary.
 */
const RELEASE_ATS = { NSAppTransportSecurity: { NSAllowsArbitraryLoads: false } };

export default ({ config }: ConfigContext): ExpoConfig => {
  const variant = resolveVariant(process.env.APP_VARIANT);
  const v = VARIANTS[variant];
  const buildNumber = resolveBuildNumber(process.env.YAPPR_BUILD_NUMBER);
  // Per-variant icons from scripts/generate-icons.mjs: devnet and testnet carry a DEV / BETA badge.
  const icons = `./assets/images/icons/${variant}`;

  return {
    ...config,
    name: v.name,
    slug: 'yappr',
    version: pkg.version,
    orientation: 'portrait',
    icon: `${icons}/ios-light.png`,
    scheme: v.scheme,
    userInterfaceStyle: 'automatic',
    ios: {
      bundleIdentifier: v.applicationId,
      buildNumber: String(buildNumber),
      supportsTablet: false,
      icon: {
        light: `${icons}/ios-light.png`,
        dark: `${icons}/ios-dark.png`,
        tinted: `${icons}/ios-tinted.png`,
      },
      // secp256k1, XChaCha20-Poly1305 and AES-GCM from libraries, not iOS (COMPLIANCE.md, Encryption export).
      config: { usesNonExemptEncryption: true },
      privacyManifests: PRIVACY_MANIFEST,
      ...(process.env.YAPPR_RELEASE === '1' ? { infoPlist: RELEASE_ATS } : null),
    },
    android: {
      package: v.applicationId,
      versionCode: buildNumber,
      adaptiveIcon: {
        foregroundImage: `${icons}/android-foreground.png`,
        monochromeImage: `${icons}/android-monochrome.png`,
        backgroundColor: ICON_BACKGROUND,
      },
      // Keys and their wrapped stores must never leave the device (plugins/release-hardening also
      // opts out of Android 12+ device-to-device transfer, which allowBackup does not cover).
      allowBackup: false,
      blockedPermissions: BLOCKED_ANDROID_PERMISSIONS,
      // Predictive back (`android:enableOnBackInvokedCallback`) stays off: on React Native 0.86 it
      // breaks Back on Android 13-15. Opted in, those versions stop calling onBackPressed(), and
      // ReactActivity registers its OnBackPressedCallback only on Android 16+ (with targetSdk 36),
      // so Back never reaches JS (no stack pop, sheet or BackHandler) and closes the app
      // (react/react-native#58407, open). Android 16+ takes back through that callback either
      // way. Turning this on would buy no animation yet: React Native always holds an enabled
      // callback, so the system never shows its back-to-home preview.
      predictiveBackGestureEnabled: false,
    },
    plugins: [
      'expo-router',
      // The app opts out of Android backup entirely (above), so no secure-store backup rules.
      ['expo-secure-store', { configureAndroidBackup: false }],
      'expo-web-browser',
      [
        'expo-local-authentication',
        { faceIDPermission: 'Allow Yappr to use Face ID to unlock your accounts.' },
      ],
      ['./plugins/engine-assets', { variant }],
      './plugins/release-hardening',
      './plugins/wallet-schemes',
      // A system font-size change keeps the activity, and with it the user's place (NEW-R-A-01).
      './plugins/font-scale',
      // The Open-source licenses list (PRD SET-06), regenerated from the lockfiles.
      './plugins/licenses',
      // Apps built with the iOS 27 SDK (Xcode 27) must adopt the UIScene life cycle or iOS 27
      // stops them at launch. SDK 57 opts in here (expo/expo#46664); SDK 58 templates do it by
      // default, so remove this on the SDK 58 upgrade.
      ['expo-build-properties', { ios: { enableSceneSupport: true } }],
      [
        'expo-splash-screen',
        {
          image: './assets/images/splash-icon.png',
          imageWidth: 180,
          backgroundColor: ICON_BACKGROUND,
          dark: { image: './assets/images/splash-icon.png', backgroundColor: DARK_BACKGROUND },
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
      commit: resolveCommit(),
    },
  };
};
