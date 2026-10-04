import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import appConfig, { resolveBuildNumber, resolveCommit } from '../../app.config';
import { withConfigurationHandler, withFontScaleConfigChange } from '../../plugins/font-scale';
import pkg from '../../package.json';
import { VARIANTS, type Variant } from '../variants';

const APP_DIR = path.resolve(__dirname, '../..');

function configFor(variant: Variant, env: Record<string, string> = {}) {
  const saved = { ...process.env };
  Object.assign(process.env, { APP_VARIANT: variant, YAPPR_ALLOW_PRODUCTION: '1' }, env);
  try {
    return appConfig({ config: {}, projectRoot: APP_DIR, staticConfigPath: null, packageJsonPath: null });
  } finally {
    process.env = saved;
  }
}

describe('resolveBuildNumber', () => {
  it('defaults to 1 for local builds', () => {
    expect(resolveBuildNumber(undefined)).toBe(1);
    expect(resolveBuildNumber('')).toBe(1);
  });

  it('accepts a positive integer up to the Play versionCode ceiling', () => {
    expect(resolveBuildNumber('42')).toBe(42);
    expect(resolveBuildNumber('2100000000')).toBe(2_100_000_000);
  });

  it.each(['0', '-3', '1.5', '1e3', 'abc', '2100000001'])('refuses %p', (raw) => {
    expect(() => resolveBuildNumber(raw)).toThrow(/YAPPR_BUILD_NUMBER/);
  });
});

describe('resolveCommit (About, SET-06)', () => {
  const SHA = '3d328f5c0123456789abcdef0123456789abcdef';

  it('takes CI\'s commit, then EAS\'s, then this checkout\'s HEAD, without the network', () => {
    expect(resolveCommit({ YAPPR_COMMIT: SHA.toUpperCase(), EAS_BUILD_GIT_COMMIT_HASH: 'abcdef1' })).toBe(SHA);
    expect(resolveCommit({ EAS_BUILD_GIT_COMMIT_HASH: 'abcdef1' })).toBe('abcdef1');
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: APP_DIR, encoding: 'utf8' }).trim();
    expect(resolveCommit({ YAPPR_COMMIT: 'not a sha' })).toBe(head);
  });

  it('is baked into extra', () => {
    expect(configFor('devnet', { YAPPR_COMMIT: SHA }).extra?.commit).toBe(SHA);
  });
});

describe.each(Object.keys(VARIANTS) as Variant[])('app.config for %s (store readiness)', (variant) => {
  const config = configFor(variant, { YAPPR_BUILD_NUMBER: '17' });

  it('takes the display name, version and build number from their sources', () => {
    expect(config.name).toBe(VARIANTS[variant].name);
    expect(config.version).toBe(pkg.version);
    expect(config.ios?.buildNumber).toBe('17');
    expect(config.android?.versionCode).toBe(17);
  });

  it('ships every icon it references', () => {
    const icons = [
      config.icon,
      ...Object.values(typeof config.ios?.icon === 'object' ? config.ios.icon : {}),
      config.android?.adaptiveIcon?.foregroundImage,
      config.android?.adaptiveIcon?.monochromeImage,
    ];
    expect(icons.every(Boolean)).toBe(true);
    for (const icon of icons) {
      expect(icon).toContain(`/icons/${variant}/`);
      expect(fs.existsSync(path.join(APP_DIR, icon!))).toBe(true);
    }
  });

  it('declares no tracking and no collected data', () => {
    expect(config.ios?.privacyManifests).toMatchObject({
      NSPrivacyTracking: false,
      NSPrivacyTrackingDomains: [],
      NSPrivacyCollectedDataTypes: [],
    });
    expect(config.ios?.config?.usesNonExemptEncryption).toBe(true);
  });

  it('keeps app data on the device and drops unused Android permissions', () => {
    expect(config.android?.allowBackup).toBe(false);
    expect(config.android?.blockedPermissions).toEqual(
      expect.arrayContaining([
        'android.permission.READ_EXTERNAL_STORAGE',
        'android.permission.WRITE_EXTERNAL_STORAGE',
        'android.permission.SYSTEM_ALERT_WINDOW',
      ]),
    );
    expect(config.plugins).toContain('./plugins/release-hardening');
  });
});

describe('iOS App Transport Security (SR-46)', () => {
  it('keeps the template ATS (local networking for the dev client) outside release builds', () => {
    expect(configFor('devnet').ios?.infoPlist).toBeUndefined();
  });

  it.each(Object.keys(VARIANTS) as Variant[])('drops the local-networking exception from %s release builds', (variant) => {
    expect(configFor(variant, { YAPPR_RELEASE: '1' }).ios?.infoPlist?.NSAppTransportSecurity).toEqual({
      NSAllowsArbitraryLoads: false,
    });
  });

  it('marks every EAS store profile, and release-ios.sh, as a release build', () => {
    const eas = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'eas.json'), 'utf8')) as {
      build: Record<string, { distribution?: string; env?: Record<string, string> }>;
    };
    const store = Object.values(eas.build).filter((profile) => profile.distribution === 'store');
    expect(store.length).toBeGreaterThan(0);
    for (const profile of store) expect(profile.env?.YAPPR_RELEASE).toBe('1');
    expect(eas.build.development?.env?.YAPPR_RELEASE).toBeUndefined();
    expect(fs.readFileSync(path.join(APP_DIR, 'scripts/release-ios.sh'), 'utf8')).toMatch(/^export YAPPR_RELEASE=1$/m);
  });

  const plistBuddy = '/usr/libexec/PlistBuddy';
  (fs.existsSync(plistBuddy) ? it : it.skip)('release-ios.sh strips the exception from a reused dev prebuild', () => {
    const script = fs.readFileSync(path.join(APP_DIR, 'scripts/release-ios.sh'), 'utf8');
    const strip = /^strip_dev_launcher_keys\(\) \{[\s\S]*?^\}$/m.exec(script)?.[0];
    expect(strip).toBeDefined();
    const app = fs.mkdtempSync(path.join(os.tmpdir(), 'release-ios-ats-'));
    const plist = path.join(app, 'Info.plist');
    fs.writeFileSync(
      plist,
      '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>NSAppTransportSecurity</key><dict>' +
        '<key>NSAllowsArbitraryLoads</key><false/><key>NSAllowsLocalNetworking</key><true/></dict></dict></plist>',
    );
    try {
      execFileSync('bash', ['-c', `${strip}\nstrip_dev_launcher_keys "$0"`, app]);
      const ats = execFileSync(plistBuddy, ['-c', 'Print :NSAppTransportSecurity', plist], { encoding: 'utf8' });
      expect(ats).toContain('NSAllowsArbitraryLoads');
      expect(ats).not.toContain('NSAllowsLocalNetworking');
    } finally {
      fs.rmSync(app, { recursive: true, force: true });
    }
  });
});

describe('iOS 27 UIScene life cycle', () => {
  // The iOS 27 SDK stops apps without it at launch; SDK 57 opts in (expo/expo#46664).
  it.each(Object.keys(VARIANTS) as Variant[])('enables scene support for %s', (variant) => {
    expect(configFor(variant).plugins).toContainEqual(['expo-build-properties', { ios: { enableSceneSupport: true } }]);
  });
});

describe('release-ios.sh variant guard', () => {
  const script = fs.readFileSync(path.join(APP_DIR, 'scripts/release-ios.sh'), 'utf8');
  const guard = /^bundle_id_matches\(\) \{[\s\S]*?^\}$/m.exec(script)?.[0];

  function matches(applicationId: string, setting: string): boolean {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-ios-'));
    const pbxproj = path.join(dir, 'project.pbxproj');
    fs.writeFileSync(pbxproj, `\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = ${setting};\n`);
    try {
      execFileSync('bash', ['-c', `${guard}\nbundle_id_matches "$0" "$1"`, applicationId, pbxproj]);
      return true;
    } catch {
      return false;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('accepts the bundle id bare or quoted, as Expo prebuild may write it', () => {
    expect(guard).toBeDefined();
    expect(matches('pr.yap.app.dev', 'pr.yap.app.dev')).toBe(true);
    expect(matches('pr.yap.app.dev', '"pr.yap.app.dev"')).toBe(true);
  });

  it('rejects another variant, including look-alikes', () => {
    expect(matches('pr.yap.app.dev', 'pr.yap.app.beta')).toBe(false);
    expect(matches('pr.yap.app', 'pr.yap.app.dev')).toBe(false);
    expect(matches('pr.yap.app.dev', 'prXyapXappXdev')).toBe(false);
  });
});

describe('Android predictive back', () => {
  // Opting in on React Native 0.86 sends Back past JS on Android 13-15 and closes the app
  // (react/react-native#58407). Re-check on Android 13-15 before turning it on.
  it.each(Object.keys(VARIANTS) as Variant[])('stays off for %s (enableOnBackInvokedCallback)', (variant) => {
    expect(configFor(variant).android?.predictiveBackGestureEnabled).toBe(false);
  });
});

describe('screen capture blocking (AUTH-12)', () => {
  it('links expo-screen-capture on iOS only', () => {
    // On Android it registers a screenshot callback at startup, so Android 14+ would say
    // "Yappr detected this screenshot" on every screen; modules/secure-window sets FLAG_SECURE instead.
    expect(pkg.expo.autolinking.android.exclude).toContain('expo-screen-capture');
    const secureWindow = JSON.parse(
      fs.readFileSync(path.join(APP_DIR, 'modules/secure-window/expo-module.config.json'), 'utf8'),
    ) as { platforms: string[] };
    expect(secureWindow.platforms).toEqual(['android']);
  });
});

describe('Android font-size changes keep the activity (NEW-R-A-01)', () => {
  /** SDK 57's MainActivity.kt as prebuild writes it (expo-splash-screen's block included), trimmed. */
  const TEMPLATE = `package pr.yap.app.dev
import expo.modules.splashscreen.SplashScreenManager

import android.os.Build
import android.os.Bundle

import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate

class MainActivity : ReactActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    SplashScreenManager.registerOnActivity(this)
    super.onCreate(null)
  }

  override fun getMainComponentName(): String = "main"

  override fun invokeDefaultOnBackPressed() {
      super.invokeDefaultOnBackPressed()
  }
}
`;

  it('is applied to every variant', () => {
    for (const variant of Object.keys(VARIANTS) as Variant[]) {
      expect(configFor(variant).plugins).toContain('./plugins/font-scale');
    }
  });

  it('adds fontScale, and not density, to the template configChanges', () => {
    // The RC4 manifest's value (0x80000fb0): neither fontScale nor density, so both recreated MainActivity.
    const template = 'keyboard|keyboardHidden|orientation|screenSize|screenLayout|uiMode|smallestScreenSize|assetsPaths';
    const changes = withFontScaleConfigChange(template);
    expect(changes).toBe(`${template}|fontScale`);
    expect(changes.split('|')).not.toContain('density');
    expect(withFontScaleConfigChange(changes)).toBe(changes);
    expect(withFontScaleConfigChange(undefined)).toBe('fontScale');
  });

  it('has MainActivity pass the new scale on to JS at once, idempotently', () => {
    const patched = withConfigurationHandler(TEMPLATE, 'kt');
    expect(patched).toMatch(/^package pr\.yap\.app\.dev\nimport android\.content\.res\.Configuration\n/);
    expect(patched).toContain('import com.facebook.react.ReactApplication\n');
    expect(patched).toContain('import com.facebook.react.bridge.LifecycleEventListener\n');
    expect(patched).toContain('override fun onConfigurationChanged(newConfig: Configuration) {');
    expect(patched).toContain('super.onConfigurationChanged(newConfig)');
    expect(patched).toContain('getNativeModule("DeviceInfo") as? LifecycleEventListener)?.onHostResume()');
    // Inside the class: the override comes before the class's closing brace.
    expect(patched.trimEnd().endsWith('// @generated end yappr-font-scale\n}')).toBe(true);
    expect(withConfigurationHandler(patched, 'kt')).toBe(patched);
  });

  it('fails the prebuild on a template it does not know', () => {
    expect(() => withConfigurationHandler(TEMPLATE, 'java')).toThrow(/Kotlin/);
    const overridden = TEMPLATE.replace('override fun getMainComponentName', 'override fun onConfigurationChanged(c: Configuration) {}\n  override fun getMainComponentName');
    expect(() => withConfigurationHandler(overridden, 'kt')).toThrow(/already overrides/);
  });
});
