/**
 * Android release settings that app.config.ts has no key for (M10,
 * mobile/RELEASE.md):
 *
 * - 64-bit only: native code is built and packaged for arm64-v8a and x86_64
 *   (emulators). Release scripts narrow it to arm64-v8a with
 *   `-PreactNativeArchitectures=arm64-v8a`.
 * - R8 minify and resource shrinking in release builds.
 * - No cleartext traffic. The debug manifests re-enable it for Metro.
 * - No device-to-device transfer of app data (Android 12+). `allowBackup:
 *   false` in app.config.ts stops cloud backup only. The data is useless on
 *   another device anyway: it is wrapped by Keystore keys that never leave this
 *   one.
 * - Release signing with the upload key from YAPPR_UPLOAD_* (never committed),
 *   falling back to the debug key so local and CI builds work without secrets.
 */
const fs = require('fs');
const path = require('path');
const {
  AndroidConfig,
  withAndroidManifest,
  withAppBuildGradle,
  withDangerousMod,
  withGradleProperties,
} = require('expo/config-plugins');

const ARCHITECTURES = 'arm64-v8a,x86_64';
const RULES = 'yappr_data_extraction_rules';

const GRADLE_PROPERTIES = {
  reactNativeArchitectures: ARCHITECTURES,
  hermesEnabled: 'true',
  'android.enableMinifyInReleaseBuilds': 'true',
  'android.enableShrinkResourcesInReleaseBuilds': 'true',
};

// Excludes every domain, credential-encrypted and device-protected, from cloud backup and device transfer.
const DOMAINS = ['root', 'file', 'database', 'sharedpref', 'external'].flatMap((d) =>
  d === 'external' ? [d] : [d, `device_${d}`],
);
const excludeAll = DOMAINS.map((domain) => `        <exclude domain="${domain}" path="." />`).join('\n');
const DATA_EXTRACTION_RULES = `<?xml version="1.0" encoding="utf-8"?>
<data-extraction-rules>
    <cloud-backup>
${excludeAll}
    </cloud-backup>
    <device-transfer>
${excludeAll}
    </device-transfer>
</data-extraction-rules>
`;

const SIGNING_CONFIG = `
        release {
            // The upload key (mobile/RELEASE.md). Unset: release builds use the debug key.
            if (System.getenv('YAPPR_UPLOAD_STORE_FILE')) {
                storeFile file(System.getenv('YAPPR_UPLOAD_STORE_FILE'))
                storePassword System.getenv('YAPPR_UPLOAD_STORE_PASSWORD')
                keyAlias System.getenv('YAPPR_UPLOAD_KEY_ALIAS')
                keyPassword System.getenv('YAPPR_UPLOAD_KEY_PASSWORD')
            }
        }`;
const RELEASE_SIGNING = "signingConfig System.getenv('YAPPR_UPLOAD_STORE_FILE') ? signingConfigs.release : signingConfigs.debug";

/**
 * Replaces `search` in `contents` exactly once, so a changed Expo template
 * fails the prebuild instead of silently skipping the change.
 */
function replaceOnce(contents, search, replacement, what) {
  const at = contents.indexOf(search);
  if (at === -1 || contents.indexOf(search, at + 1) !== -1) {
    throw new Error(`release-hardening: cannot find a unique ${what} in android/app/build.gradle.`);
  }
  return contents.slice(0, at) + replacement + contents.slice(at + search.length);
}

/** @param {string} gradle */
function withReleaseSigning(gradle) {
  if (gradle.includes('YAPPR_UPLOAD_STORE_FILE')) return gradle;
  gradle = replaceOnce(
    gradle,
    "            keyPassword 'android'\n        }",
    `            keyPassword 'android'\n        }${SIGNING_CONFIG}`,
    'debug signing config',
  );
  const buildTypes = gradle.indexOf('buildTypes {');
  const release = buildTypes === -1 ? -1 : gradle.indexOf('        release {', buildTypes);
  if (release === -1) throw new Error('release-hardening: no release build type in android/app/build.gradle.');
  return gradle.slice(0, release) + replaceOnce(gradle.slice(release), 'signingConfig signingConfigs.debug', RELEASE_SIGNING, 'release signingConfig');
}

/** @type {import('expo/config-plugins').ConfigPlugin} */
const withReleaseHardening = (config) => {
  config = withGradleProperties(config, (cfg) => {
    for (const [key, value] of Object.entries(GRADLE_PROPERTIES)) {
      cfg.modResults = cfg.modResults.filter((item) => !(item.type === 'property' && item.key === key));
      cfg.modResults.push({ type: 'property', key, value });
    }
    return cfg;
  });

  config = withAndroidManifest(config, (cfg) => {
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(cfg.modResults);
    app.$['android:usesCleartextTraffic'] = 'false';
    app.$['android:dataExtractionRules'] = `@xml/${RULES}`;
    return cfg;
  });

  config = withDangerousMod(config, [
    'android',
    async (cfg) => {
      const dir = path.join(cfg.modRequest.platformProjectRoot, 'app/src/main/res/xml');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${RULES}.xml`), DATA_EXTRACTION_RULES);
      return cfg;
    },
  ]);

  config = withAppBuildGradle(config, (cfg) => {
    cfg.modResults.contents = withReleaseSigning(cfg.modResults.contents);
    return cfg;
  });

  return config;
};

module.exports = withReleaseHardening;
